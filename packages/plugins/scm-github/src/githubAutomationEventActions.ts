import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  PluginActionInputById,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import {
  PluginEventAutomationHistoryGapResetActionInputV1Schema,
  PluginEventAutomationHistoryGapResetActionResultV1Schema,
  PluginEventAutomationSetupResultV1Schema,
  type PluginEventAutomationHistoryGapResetActionInputV1,
  type PluginEventAutomationHistoryGapResetActionResultV1,
  type PluginEventAutomationSetupResultV1,
} from '@happier-dev/plugin-sdk/events';

import { createGithubApiClient } from './observations/githubApiClient.js';
import {
  replaceGithubAutomationEventHistoryGapWithBaseline,
  type GithubAutomationEventSourceDefinitionV1,
} from './observations/githubAutomationEventObserver.js';
import {
  GithubApiResponseError,
  resolveGithubRepositoryWithClient,
} from './observations/githubRepositoryResolution.js';
import { parseGithubRepositorySetupInput } from './observations/githubRepositorySetupInput.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  type GithubRepositorySourceConfigV1,
  type GithubAutomationRepositoryEventSourceConfigV1,
} from './observations/githubProviderContracts.js';

type AutomationEventSourcesListResultV1 = PluginActionResultById['automation.event.sources.list'];

type CurrentHistoryGapResetSourceV1 = Readonly<{
  definition: GithubAutomationEventSourceDefinitionV1;
  /** Rechecks the single host revision that authorized the provider I/O. */
  isCurrent: () => Promise<boolean>;
}>;

function throwHistoryGapResetInputInvalid(): never {
  throw new PluginError({
    code: 'github_automation_baseline_input_invalid',
    message: 'GitHub Event baseline input is invalid.',
  });
}

function parseGithubAutomationHistoryGapResetInput(
  input: unknown,
): PluginEventAutomationHistoryGapResetActionInputV1 {
  const parsed = PluginEventAutomationHistoryGapResetActionInputV1Schema.safeParse(input);
  if (!parsed.success) throwHistoryGapResetInputInvalid();
  return parsed.data;
}

function matchesHistoryGapResetSource(
  definition: GithubAutomationEventSourceDefinitionV1,
  input: PluginEventAutomationHistoryGapResetActionInputV1,
): boolean {
  return definition.automationId === input.automationId
    && definition.triggerId === input.triggerId
    && definition.triggerRevision === input.triggerRevision
    && definition.sourceSelectorId === input.sourceSelectorId;
}

/**
 * A reset has no retained source cache. It exhausts one revision-bound host
 * projection so the action can use only the caller-current definition and its
 * persisted exact Connected Account reference. Any source-list currentness
 * loss is a typed no-effect result, never a local fallback or provider call.
 */
async function readCurrentHistoryGapResetSource(input: Readonly<{
  context: PluginInvocationContext;
  reset: PluginEventAutomationHistoryGapResetActionInputV1;
}>): Promise<CurrentHistoryGapResetSourceV1 | null> {
  const matches: GithubAutomationEventSourceDefinitionV1[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let revision: string | null = null;

  while (true) {
    input.context.signal.throwIfAborted();
    const request: PluginActionInputById['automation.event.sources.list'] = {
      transport: { kind: 'checkpointedPull' },
      ...(cursor === undefined ? {} : { cursor }),
    };
    const result: AutomationEventSourcesListResultV1 = await input.context.services.actions.execute(
      'automation.event.sources.list',
      request,
      { signal: input.context.signal },
    );
    input.context.signal.throwIfAborted();
    if (result.kind !== 'page'
      || (revision !== null && result.revision !== revision)
      || (result.nextCursor !== null && result.definitions.length === 0)) {
      return null;
    }
    revision ??= result.revision;
    for (const definition of result.definitions) {
      if (matchesHistoryGapResetSource(definition, input.reset)) matches.push(definition);
    }
    if (result.nextCursor === null) {
      if (matches.length !== 1 || revision === null) return null;
      const currentRevision = revision;
      // A completed public scan is only a candidate. The same exact revision
      // must hold both before provider I/O and immediately before checkpoint
      // CAS, so a source/template move cannot baseline old authority.
      const isCurrent = async (): Promise<boolean> => {
        input.context.signal.throwIfAborted();
        const request: PluginActionInputById['automation.event.sources.list'] = {
          transport: { kind: 'checkpointedPull' },
          knownRevision: currentRevision,
        };
        const current: AutomationEventSourcesListResultV1 = await input.context.services.actions.execute(
          'automation.event.sources.list',
          request,
          { signal: input.context.signal },
        );
        input.context.signal.throwIfAborted();
        return current.kind === 'unchanged' && current.revision === currentRevision;
      };
      return await isCurrent()
        ? Object.freeze({ definition: matches[0]!, isCurrent })
        : null;
    }
    if (seenCursors.has(result.nextCursor)) return null;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    await Promise.resolve();
  }
}

function throwTypedRepositoryResolutionFailure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  if (error instanceof GithubApiResponseError) {
    throw new PluginError({
      code: error.status === 404 ? 'github_repository_not_found' : 'github_repository_unavailable',
      message: error.status === 404
        ? 'The selected GitHub repository was not found.'
        : 'GitHub could not resolve the selected repository.',
    });
  }
  if (isPluginError(error)) throw error;
  if (error instanceof RangeError) {
    throw new PluginError({
      code: 'github_repository_response_invalid',
      message: 'GitHub returned invalid repository details.',
    });
  }
  throw new PluginError({
    code: 'github_repository_unavailable',
    message: 'GitHub could not resolve the selected repository.',
  });
}

/**
 * Resolves user-entered GitHub repository text into the strict source facts
 * consumed by the canonical Automation definition writer. It owns neither
 * Automation persistence nor provider observation.
 */
export async function setupGithubRepositoryEventSource(
  input: unknown,
  context: PluginInvocationContext,
): Promise<PluginEventAutomationSetupResultV1> {
  const setup = parseGithubRepositorySetupInput(input, context.plugin.id);
  context.signal.throwIfAborted();

  const client = await createGithubApiClient(context, setup.credentialRef);
  let repository: GithubRepositorySourceConfigV1;
  try {
    repository = await resolveGithubRepositoryWithClient(client, setup.repository);
  } catch (error) {
    throwTypedRepositoryResolutionFailure(error, context.signal);
  }
  context.signal.throwIfAborted();

  const sourceConfig: GithubAutomationRepositoryEventSourceConfigV1 = Object.freeze({
    v: 1,
    credentialRef: setup.credentialRef,
    repository,
  });
  return PluginEventAutomationSetupResultV1Schema.parse({
    v: 1,
    sourceInstanceId: `github:repository:${repository.repositoryId}`,
    sourceContractVersion: GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
    sourceConfig,
    displayLabel: repository.nameWithOwner,
  });
}

/**
 * Explicitly replaces a persisted checkpointed-pull history gap with a fresh
 * authenticated current-head baseline. It never resumes the retired cursor,
 * deletes the row, or runs from the background observer.
 */
export async function resetGithubRepositoryEventHistoryGap(
  input: unknown,
  context: PluginInvocationContext,
): Promise<PluginEventAutomationHistoryGapResetActionResultV1> {
  const reset = parseGithubAutomationHistoryGapResetInput(input);
  context.signal.throwIfAborted();
  const source = await readCurrentHistoryGapResetSource({ context, reset });
  context.signal.throwIfAborted();
  if (source === null) {
    return PluginEventAutomationHistoryGapResetActionResultV1Schema.parse({ kind: 'stale' });
  }
  return PluginEventAutomationHistoryGapResetActionResultV1Schema.parse(
    await replaceGithubAutomationEventHistoryGapWithBaseline({
      context,
      definition: source.definition,
      isDefinitionCurrent: source.isCurrent,
    }),
  );
}
