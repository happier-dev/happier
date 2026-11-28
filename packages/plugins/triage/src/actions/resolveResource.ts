import { indexTriageAdmittedSourcesV1, readAccountDataSourceRecordsV1 } from '../corpus/configuration/accountDataSources.js';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import type { TriageConfiguredSourceInstanceV1, TriageEntryRefV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { readExactConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { sameConfiguredSourceAuthority } from '../corpus/configuration/configuredSourceAuthority.js';
import { renderSourceQualifiedId, sameTriageEntryReference, sameTriageSourceIdentity } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import type { TriageAdmittedSourceV1 } from './listEntries.js';
import type { TriageResolveResourceActionInputV1, TriageResolveResourceActionResultV1 } from './resolveResourceProtocol.js';
import { readReviewSessionRepository } from './reviewSessionRepository.js';

function disconnectedSource() {
  return {
    kind: 'unavailable',
    code: 'sourceUnavailable',
    remedy: 'Connect the repository in PRs & Issues, then try the pull request again.',
  } as const;
}

export function disconnectedSourceError(): PluginError {
  const refused = disconnectedSource();
  return new PluginError({
    code: refused.code, message: refused.remedy, effectAttempted: false, details: refused,
  });
}

export function sourceResourceReadError(failure: TriageSourceFailureV1): PluginError {
  const remedy = failure.class === 'authentication'
    ? 'Reconnect the source account in PRs & Issues, then try the pull request again.' : undefined;
  return new PluginError({
    code: failure.code, effectAttempted: false, details: failure,
    message: [remedy, failure.detail].filter(Boolean).join(' ')
      || 'The pull request could not be read from its connected source.',
  });
}

type SourceResource = Extract<TriageResolveResourceActionInputV1, { resource: unknown }>['resource'];
type SourceContext = Pick<PluginInvocationContext, 'signal'> & Readonly<{
  services: Pick<PluginInvocationContext['services'], 'targetedContributions'> & Readonly<{
    actions: Pick<PluginInvocationContext['services']['actions'], 'executeAdmittedTargetedOperation'>;
  }>;
}> & PluginAccountStorageConsumerContext;

async function resolveConfiguredResource(
  source: TriageAdmittedSourceV1 | undefined,
  instance: TriageConfiguredSourceInstanceV1,
  resource: SourceResource,
  { services, signal }: SourceContext,
) {
  const operation = source?.operations.resolveResource;
  if (operation === undefined) return { kind: 'unavailable' } as const;
  const result = await services.actions.executeAdmittedTargetedOperation(operation, { v: 1, instance, resource }, { signal });
  throwIfAborted(signal);
  return result.kind === 'resolved' ? {
    kind: 'resolved' as const, sourceInstance: instance.instance,
    entryRef: { source: instance.instance.source, ...result.localRef }, locator: result.locator,
  } : result;
}

/** At Prepare dispatch, admit the approved source through the same provider repository selection as Resolve. */
export async function admitPullRequestSourceForPreparation(
  input: Readonly<{ instance: TriageConfiguredSourceInstanceV1; entryRef: TriageEntryRefV1; url: string }>,
  context: SourceContext,
) {
  const { signal, services } = context;
  if (!sameTriageSourceIdentity(input.instance.instance.source, input.entryRef.source)) throw disconnectedSourceError();
  const observation = services.targetedContributions.observeForSelf(
    TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
  );
  try {
    const snapshot = await observation.readCurrent({ signal });
    const sources = indexTriageAdmittedSourcesV1(snapshot.contributions);
    const source = sources.get(renderSourceQualifiedId(input.entryRef.source));
    const operation = source?.operations.prepareReviewWorkspace;
    if (!operation) throw disconnectedSourceError();
    const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
    const record = await readExactConfiguredSourceInstanceRow(sourceInstances, input.instance, {
      signal, accountDataSources: readAccountDataSourceRecordsV1(sources),
    });
    if (!record || !sameConfiguredSourceAuthority({ ...record.value, configured: input.instance }, record.value)) {
      throw disconnectedSourceError();
    }
    const instance = record.value.configured;
    const resolved = await resolveConfiguredResource(source, instance, { kind: 'pullRequest', url: input.url }, context);
    if (resolved.kind === 'unavailable' && 'failure' in resolved && resolved.failure
        && resolved.failure.class !== 'unsupportedContract') throw sourceResourceReadError(resolved.failure);
    if (resolved.kind !== 'resolved' || !sameTriageEntryReference(resolved.entryRef, input.entryRef)) {
      throw disconnectedSourceError();
    }
    return { instance, operation, locator: resolved.locator };
  } finally {
    observation.dispose();
  }
}

async function resourceForSession(
  input: Extract<TriageResolveResourceActionInputV1, { kind: 'pullRequestForSession' }>,
  context: TriageDataActionContext,
) {
  const reference = typeof input.reference === 'string' ? input.reference.trim() : input.reference;
  if (typeof reference === 'string' && !/^#?\d+$/u.test(reference)) {
    const qualified = /^((?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}#)[\w.-]+)#([1-9]\d*)$/u.exec(reference);
    return { kind: 'pullRequest' as const,
      url: qualified ? `https://github.com/${qualified[1]}/pull/${qualified[2]}` : reference };
  }
  const number = typeof reference === 'string' ? Number(reference.replace(/^#/u, '')) : reference;
  if (!Number.isSafeInteger(number) || number < 1) throw new PluginError({
    code: 'invalid_input', effectAttempted: false, message: 'Enter a positive pull request number.',
  });
  const checkout = await readReviewSessionRepository(input.sessionId, context);
  if (checkout?.repository?.kind !== 'github') throw new PluginError({
    code: 'invalid_input', effectAttempted: false,
    message: 'A pull request number needs a repository. Select a Session with the repository checkout or paste the pull request URL.',
    details: { field: 'repository', reason: 'repository_needed' },
  });
  return {
    kind: 'pullRequest' as const,
    url: `${checkout.repository.deployment}/${checkout.repository.repository}/pull/${number}`,
  };
}

/** One finite walk of configured connections; only the source can mint entry identity. */
export function createTriageResolveResourceActionHandler(): TriageDataActionHandler<
  TriageResolveResourceActionInputV1,
  TriageResolveResourceActionResultV1
> {
  return async (input, context) => {
    throwIfAborted(context.signal);
    const options = { signal: context.signal };
    const resource = 'resource' in input ? input.resource : await resourceForSession(input, context);
    const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
    const observation = context.services.targetedContributions.observeForSelf(
      TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
    );
    try {
      const admitted = await observation.readCurrent(options);
      const sources = indexTriageAdmittedSourcesV1(admitted.contributions);
      const configured = await readActiveConfiguredSourceRows(sourceInstances, {
        ...options, accountDataSources: readAccountDataSourceRecordsV1(sources),
      });
      for (const row of configured.rows) {
        throwIfAborted(context.signal);
        const instance = row.configured;
        const source = sources.get(renderSourceQualifiedId(instance.instance.source));
        try {
          const result = await resolveConfiguredResource(source, instance, resource, context);
          if (result.kind === 'resolved') return result;
        } catch {
          throwIfAborted(context.signal);
          // Another configured connection may read the URL. Provider failures
          // settle this connection; the walk never retries it.
        }
      }
      throwIfAborted(context.signal);
      if ('resource' in input) return disconnectedSource();
      throw disconnectedSourceError();
    } finally {
      observation.dispose();
    }
  };
}
