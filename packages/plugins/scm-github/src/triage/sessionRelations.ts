import { isPluginError, PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/plugin-sdk/errors';
import { isPluginActionApprovalRequestCreated, type PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { SessionPullRequestBindingResultV1Schema, SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
  SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1, SESSION_PULL_REQUEST_NATIVE_RELATIONS_ACTION_ID_V1,
  type SessionPullRequestBindingInputV1, type SessionPullRequestBindingResultV1, type SessionPullRequestRelationsInputV1 } from '@happier-dev/channels-protocol/v1';
import { readTriageSessionSetEnvelopeV1, TriageSourceCredentialInputsV1, TriageSourceCredentialBindingV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageSourceEntryLocalRefV1, type TriageSourceLinkSessionResultV1,
  type TriageSourceReadSessionLinksResultV1, type TriageSourceSessionLinksSliceV1 } from '@happier-dev/triage-protocol/v1';
import { decodeGithubJsonResponse } from '../observations/githubApiClient.js';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { readGithubRepositoryIdFromCollisionScope, buildGithubEntryLocalRef } from './identity.js';
import { buildGithubEntryLocator, parseGithubRoutingToken } from './locator.js';
import { toTriageLocator } from './mapping/protocol.js';
import { resolveGithubTriageInstance, openGithubTriageClient } from './operations.js';
import { decodeGithubRepositoryMetadata } from './repositories.js';
import { classifyGithubResponseFailure } from './errors.js';
import type { GithubTriageInvocationContext, GithubTriageObservationContext } from './invocation.js';

const bindingAction = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 };
const accountRelationsAction = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 };
const nativeRelationsAction = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_NATIVE_RELATIONS_ACTION_ID_V1 };
const unavailable = { kind: 'failed', failure: { class: 'unknown', code: 'github_session_relations_unavailable' } } as const;

function exactPullRequest(ref: TriageSourceEntryLocalRefV1) {
  const repositoryId = readGithubRepositoryIdFromCollisionScope(ref.collisionScope);
  const number = Number(ref.entryId);
  return ref.kindId === 'pull-request' && repositoryId !== null && /^[1-9][0-9]*$/u.test(ref.entryId)
    && Number.isSafeInteger(number) ? { repositoryId, number } : null;
}

function admitInstance(instance: TriageConfiguredSourceInstanceV1) {
  const resolved = resolveGithubTriageInstance(instance);
  const binding = TriageSourceCredentialBindingV1Schema.safeParse(instance.binding);
  if (!resolved.ok || !binding.success) return null;
  if (!('account' in binding.data) && (binding.data.service.pluginId !== GITHUB_CONNECTED_ACCOUNT_SERVICE.pluginId
    || binding.data.service.localId !== GITHUB_CONNECTED_ACCOUNT_SERVICE.localId)) return null;
  return { configuration: resolved.configuration, credentialRef: 'account' in binding.data ? binding.data.account : null };
}

async function bindingObservationOptions(context: PluginInvocationContext, credentialRef: ConnectedAccountRef | null) {
  if (credentialRef !== null) return { signal: context.signal };
  const routing = await context.services.actions.getCurrentExecutionRouting?.({ signal: context.signal });
  if (routing === undefined || routing === null || routing.pluginId !== GITHUB_CONNECTED_ACCOUNT_SERVICE.pluginId) {
    throw new PluginError({ code: 'github_session_relations_native_origin_unavailable', message: 'The GitHub source placement is unavailable.' });
  }
  return { signal: context.signal, expectedExecutionRouting: { ...routing, pluginId: bindingAction.pluginId } };
}

async function executeBinding(input: SessionPullRequestBindingInputV1, context: PluginInvocationContext,
  credentialRef: ConnectedAccountRef | null): Promise<SessionPullRequestBindingResultV1> {
  // A machine-native service is not an Account credential. Keep the call at
  // this source's admitted placement and let Channels prove the caller stamp.
  let result: unknown;
  if (credentialRef === null) {
    result = (await context.services.actions.executeWithExecutionOrigin(bindingAction, input, {
      ...await bindingObservationOptions(context, credentialRef),
    })).result;
  } else result = await context.services.actions.execute(bindingAction, input, { signal: context.signal });
  context.signal.throwIfAborted();
  if (isPluginActionApprovalRequestCreated(result)) throw new PluginError({ code: 'github_session_relations_not_applied', message: 'The relationship operation was not applied.' });
  return SessionPullRequestBindingResultV1Schema.parse(result);
}

function prepareRelationsInput(input: ReturnType<typeof TriageSourceCredentialInputsV1.readSessionLinks.parse>) {
  const admitted = admitInstance(input.instance);
  if (admitted === null) return null;
  const common = { kind: 'readRelations' as const, credentialRef: admitted.credentialRef };
  if ('sessionIds' in input) return { admitted, request: { ...common, sessionIds: [...new Set(input.sessionIds)] } };
  const pullRequest = exactPullRequest(input.localRef);
  return pullRequest === null ? null : { admitted, request: { ...common, pullRequest } };
}

/** Forward native membership changes through the host's ordinary contributed-read owner. */
export const observeGithubTriageSessionLinks: PluginActionReadObserver = async (input, invalidate, context) => {
  context.signal.throwIfAborted();
  const parsed = TriageSourceCredentialInputsV1.readSessionLinks.safeParse(input);
  const prepared = parsed.success ? prepareRelationsInput(parsed.data) : null;
  if (prepared === null) throw new PluginError({ code: 'plugin_action_read_observation_unavailable', message: 'The configured PR relationships cannot be observed.' });
  const options = await bindingObservationOptions(context, prepared.admitted.credentialRef);
  const purpose = context.services.connectedAccounts.watch(GITHUB_CONNECTED_ACCOUNT_PURPOSE, () => {
    // The host privately retires the admitted credential lifetime. Metadata
    // resync alone is not a native relationship change.
  });
  let target: Awaited<ReturnType<typeof context.services.actions.observe>> | undefined;
  let cleanup: Promise<void> | undefined;
  function dispose(): Promise<void> {
    context.signal.removeEventListener('abort', onAbort);
    return cleanup ??= Promise.all([purpose.dispose(), target?.dispose()]).then(() => {});
  }
  const onAbort = () => { void dispose().catch(() => {}); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  try {
    target = await context.services.actions.observe(nativeRelationsAction, prepared.request, invalidate, options);
    if (cleanup !== undefined) await target.dispose();
    context.signal.throwIfAborted();
    return { dispose };
  } catch (error) { await dispose(); throw error; }
};

export const observeAccountGithubTriageSessionLinks: PluginActionReadObserver<JsonValue, GithubTriageObservationContext> = async (input, invalidate, context) => {
  context.signal.throwIfAborted();
  const parsed = TriageSourceCredentialInputsV1.readSessionLinks.safeParse(input);
  const prepared = parsed.success ? prepareRelationsInput(parsed.data) : null;
  if (prepared === null) throw new PluginError({ code: 'plugin_action_read_observation_unavailable', message: 'The configured PR relationships cannot be observed.' });
  return context.services.actions.observe(accountRelationsAction, prepared.request, invalidate, { signal: context.signal });
};

type ReadRelations = (request: SessionPullRequestRelationsInputV1, credentialRef: ConnectedAccountRef | null) => Promise<JsonValue | void>;

/** Thin GitHub PR-only projection; Channels is the sole relationship store and writer. */
export async function readGithubTriageSessionLinks(input: unknown, context: PluginInvocationContext): Promise<TriageSourceReadSessionLinksResultV1> {
  return readSessionLinks(input, context.signal, async (request, credentialRef) => {
    if (credentialRef !== null) return context.services.actions.execute(nativeRelationsAction, request, { signal: context.signal });
    return (await context.services.actions.executeWithExecutionOrigin(nativeRelationsAction, request,
      await bindingObservationOptions(context, credentialRef))).result;
  });
}

/** Account placement uses the same Channels reader without acquiring a Machine. */
export async function readAccountGithubTriageSessionLinks(input: unknown, context: GithubTriageInvocationContext): Promise<TriageSourceReadSessionLinksResultV1> {
  return readSessionLinks(input, context.signal, request => context.services.actions.execute(accountRelationsAction, request, { signal: context.signal }));
}

async function readSessionLinks(input: unknown, signal: AbortSignal, execute: ReadRelations): Promise<TriageSourceReadSessionLinksResultV1> {
  const parsed = TriageSourceCredentialInputsV1.readSessionLinks.safeParse(input);
  if (!parsed.success) return unavailable;
  const prepared = prepareRelationsInput(parsed.data);
  const ids = 'sessionIds' in parsed.data ? [...new Set(parsed.data.sessionIds)] : undefined;
  const failed = (): TriageSourceReadSessionLinksResultV1 => ids === undefined ? unavailable
    : { kind: 'sessionSet', slices: ids.map(sessionId => ({ sessionId, result: unavailable })) };
  if (prepared === null) return failed();
  try {
    signal.throwIfAborted();
    const value = await execute(prepared.request, prepared.admitted.credentialRef);
    signal.throwIfAborted();
    const { result: authored, refusals } = readTriageSessionSetEnvelopeV1(value);
    const parsedRelations = SessionPullRequestBindingResultV1Schema.safeParse(authored);
    const relations = parsedRelations.success && parsedRelations.data.kind === 'relations' ? parsedRelations.data : undefined;
    const failures = new Map<string, TriageSourceSessionLinksSliceV1>();
    for (const failure of relations?.failures ?? []) failures.set(failure.sessionId, {
      kind: 'failed', failure: { class: 'transient', code: failure.code },
    });
    for (const [sessionId, code] of refusals) failures.set(sessionId, {
      kind: 'failed', failure: { class: 'permission', code },
    });
    type Link = Extract<TriageSourceSessionLinksSliceV1, { kind: 'complete' }>['links'][number];
    const links = new Map<string, Link>();
    const requested = ids === undefined ? undefined : new Set<string>(ids);
    for (const relation of relations?.links ?? []) {
      if (requested && !requested.has(relation.sessionId)) continue;
      const request = prepared.request;
      if ('pullRequest' in request && (relation.repositoryId !== request.pullRequest.repositoryId
        || relation.pullRequest.number !== request.pullRequest.number)) return unavailable;
      const route = parseGithubRoutingToken(relation.pullRequest.repository);
      const localRef = buildGithubEntryLocalRef({ kindId: 'pull-request', repositoryId: relation.repositoryId, nativeItemId: relation.pullRequest.number });
      const locator = route === null || localRef === null ? null : buildGithubEntryLocator({ ...route, entryNumber: localRef.entryId,
        webUrl: `https://github.com/${relation.pullRequest.repository}/pull/${localRef.entryId}` });
      if (localRef === null || locator === null) {
        if (ids === undefined) return unavailable;
        failures.set(relation.sessionId, unavailable);
        continue;
      }
      const selection = prepared.admitted.configuration.selection;
      if (selection.kind === 'selected' && !selection.unitIds.includes(locator.routingToken)) continue;
      const key = JSON.stringify([localRef.collisionScope, localRef.entryId, relation.sessionId]);
      const existing = links.get(key);
      if (existing === undefined || existing.linkedAtMs > relation.linkedAtMs) {
        links.set(key, { localRef, sessionId: relation.sessionId, linkedAtMs: relation.linkedAtMs,
          displayPath: locator.displayPath, locator: toTriageLocator(locator) });
      }
    }
    if (ids === undefined) return relations === undefined ? unavailable : { kind: 'complete', links: [...links.values()] };
    const bySession = new Map<string, Link[]>();
    for (const link of links.values()) {
      const current = bySession.get(link.sessionId);
      if (current === undefined) bySession.set(link.sessionId, [link]);
      else current.push(link);
    }
    return { kind: 'sessionSet', slices: ids.map(sessionId => ({ sessionId,
      result: failures.get(sessionId) ?? (relations === undefined ? unavailable : { kind: 'complete', links: bySession.get(sessionId) ?? [] }),
    })) };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (isPluginError(error)) throw error;
    return failed();
  }
}

/** One acknowledged local binding write is the source's canonical link fact. */
export async function linkGithubTriageSession(input: unknown, context: PluginInvocationContext): Promise<TriageSourceLinkSessionResultV1> {
  const parsed = TriageSourceCredentialInputsV1.linkSession.safeParse(input);
  if (!parsed.success) return { status: 'failed' };
  const request = parsed.data;
  const admitted = admitInstance(request.instance);
  const pullRequest = exactPullRequest(request.localRef);
  if (admitted === null || pullRequest === null) return { status: 'failed' };
  const refuse = (code: string, phase: string, retryable = false, requestId = context.requestId): never => {
    throw new PluginError({ code, retryable, details: { phase, ...(requestId === undefined ? {} : { requestId }) } });
  };
  try {
    if (!request.linked) {
      const current = await executeBinding({ kind: 'readRelations', credentialRef: admitted.credentialRef,
        sessionId: request.sessionId, pullRequest }, context, admitted.credentialRef);
      if (current.kind !== 'relations' || current.links.some(link => link.sessionId !== request.sessionId
        || link.repositoryId !== pullRequest.repositoryId || link.pullRequest.number !== pullRequest.number)) return refuse('github_session_relations_invalid', 'read_relations');
      for (const link of current.links) {
        const removed = await executeBinding({ kind: 'unlink', sessionId: request.sessionId,
          bindingId: link.bindingId, expectedRevision: link.revision }, context, admitted.credentialRef);
        if (removed.kind !== 'removed') return refuse('github_session_relation_unlink_not_applied', 'unlink');
      }
      return { status: 'unlinked' };
    }
    const opened = await openGithubTriageClient(request.instance, context);
    if (!opened.ok) return refuse(opened.failure.code, 'credential_acquisition',
      opened.failure.class === 'transient' || opened.failure.class === 'rateLimit', opened.failure.requestId ?? context.requestId);
    const response = await opened.client.request({ url: `https://api.github.com/repositories/${pullRequest.repositoryId}` });
    if (response.status !== 200) {
      const failure = classifyGithubResponseFailure(response, context.invokedAtMs);
      return refuse(failure.code, 'repository_read', failure.class === 'transient' || failure.class === 'rateLimit',
        failure.requestId ?? context.requestId);
    }
    const repository = decodeGithubRepositoryMetadata(decodeGithubJsonResponse(response));
    if (repository === null || repository.repositoryId !== pullRequest.repositoryId || repository.repositoryKey === null) {
      return refuse('github_session_relation_repository_invalid', 'repository_decode');
    }
    const selection = admitted.configuration.selection;
    if (selection.kind === 'selected' && !selection.unitIds.includes(repository.repositoryKey)) {
      return refuse('github_session_relation_repository_not_selected', 'repository_selection');
    }
    const linked = await executeBinding({ kind: 'attach', sessionId: request.sessionId, credentialRef: admitted.credentialRef,
      pullRequest: { repository: repository.repositoryKey, number: pullRequest.number }, expectedRepositoryId: pullRequest.repositoryId }, context, admitted.credentialRef);
    if (linked.kind !== 'attached') return refuse('github_session_relation_attach_not_applied', 'attach');
    return { status: 'linked' };
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (isPluginError(error)) throw error;
    const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
    throw new PluginError({ code: 'github_session_relation_write_failed', failureCause: {
      phase: 'github.session_relation_write', errorClass, errorCode, httpStatus,
    }, details: {
      phase: 'relation_write', ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    } }, { cause: error });
  }
}
