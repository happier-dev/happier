import { isPluginError, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type {
  PluginActionInputById,
} from '@happier-dev/plugin-sdk/actions';
import {
  isAutomationEventSourcesListPageProgressingV1,
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
import { githubChecksSourceInstanceId, parseGithubChecksSource } from './observations/githubChecksSource.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID,
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_CONNECTED_ACCOUNT_SERVICE,
  GithubAutomationRepositorySourceConfigV1Schema,
  type GithubRepositorySourceConfigV1,
  type GithubAutomationRepositoryEventSourceConfigV1,
  parseGithubDeploymentMonitoringSelection,
} from './observations/githubProviderContracts.js';

type CurrentGithubAutomationEventSourceV1 = Readonly<{
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
  input: Readonly<{ automationId: string; triggerId: string; sourceSelectorId: string; triggerRevision?: number }>,
): boolean {
  return definition.automationId === input.automationId
    && definition.triggerId === input.triggerId
    && (input.triggerRevision === undefined || definition.triggerRevision === input.triggerRevision)
    && definition.sourceSelectorId === input.sourceSelectorId;
}

/**
 * A reset has no retained source cache. It exhausts one revision-bound host
 * projection so the action can use only the caller-current definition and its
 * persisted exact Connected Account reference. Any source-list currentness
 * loss is a typed no-effect result, never a local fallback or provider call.
 */
export async function readCurrentGithubAutomationEventSource(input: Readonly<{
  context: PluginInvocationContext;
  selector: Readonly<{ automationId: string; triggerId: string; sourceSelectorId: string; triggerRevision?: number }>;
}>): Promise<CurrentGithubAutomationEventSourceV1 | null> {
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
    const result = await input.context.services.actions.execute(
      'automation.event.sources.list',
      request,
      { signal: input.context.signal },
    );
    input.context.signal.throwIfAborted();
    // A policy deferral means the catalog read never ran, so this scan has no
    // current revision to baseline against. It joins the existing typed
    // currentness-loss result rather than becoming a provider call.
    if (isPluginActionApprovalRequestCreated(result)) return null;
    if (result.kind !== 'page'
      || (revision !== null && result.revision !== revision)
      || !isAutomationEventSourcesListPageProgressingV1(result)) {
      return null;
    }
    revision ??= result.revision;
    for (const definition of result.definitions) {
      if (matchesHistoryGapResetSource(definition, input.selector)) matches.push(definition);
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
        const current = await input.context.services.actions.execute(
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
  context.signal.throwIfAborted();
  if (input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === 1 && 'repository' in input) {
    const binding = await context.services.connectedAccounts.getBinding(GITHUB_CONNECTED_ACCOUNT_PURPOSE, { signal: context.signal });
    input = { repository: input.repository, credentialRef: binding?.account };
  }
  let deploymentReview: GithubAutomationRepositoryEventSourceConfigV1['deploymentReview'];
  let repositoryInput = input;
  if (input && typeof input === 'object' && !Array.isArray(input) && 'deploymentReview' in input) {
    const raw = input as Readonly<Record<string, unknown>>;
    try {
      if (Object.keys(raw).length !== 3) throw new RangeError('Unexpected setup fields');
      deploymentReview = parseGithubDeploymentMonitoringSelection(raw.deploymentReview);
    } catch {
      throw new PluginError({ code: 'github_setup_input_invalid', message: 'Choose one monitoring Machine for deployment reviews.' });
    }
    repositoryInput = { credentialRef: raw.credentialRef, repository: raw.repository };
  }
  const setup = deploymentReview ? parseGithubRepositorySetupInput(repositoryInput, context.plugin.id, 'deployment')
    : parseGithubRepositorySetupInput(repositoryInput, context.plugin.id);
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
    ...(deploymentReview ? { deploymentReview } : {}),
  });
  return PluginEventAutomationSetupResultV1Schema.parse({
    v: 1,
    sourceInstanceId: `github:repository:${repository.repositoryId}${deploymentReview ? ':deployment-review' : ''}`,
    sourceContractVersion: GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
    sourceConfig,
    displayLabel: repository.nameWithOwner,
  });
}

/** The Event editor pins setup to its chosen watcher. This read only proposes
 * source facts for the current invocation; routing is not enrollment consent.
 * The definition writer still owns explicit watcher admission and enablement. */
export async function setupGithubDeploymentReviewEventSource(input: unknown, context: PluginInvocationContext): Promise<PluginEventAutomationSetupResultV1> {
  context.signal.throwIfAborted();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PluginError({ code: 'github_setup_input_invalid', message: 'GitHub deployment setup requires a repository and exact Connected Account.' });
  }
  const raw = input as Readonly<Record<string, unknown>>;
  if (Object.keys(raw).some(key => !['repository', 'credentialRef', 'nativeService', 'deploymentReview'].includes(key))) {
    throw new PluginError({ code: 'github_setup_input_invalid', message: 'Unexpected GitHub deployment setup fields.' });
  }
  if (raw.credentialRef === null || (raw.credentialRef === undefined && (!raw.nativeService || typeof raw.nativeService !== 'object' || Array.isArray(raw.nativeService)
    || !('pluginId' in raw.nativeService) || raw.nativeService.pluginId !== GITHUB_CONNECTED_ACCOUNT_SERVICE.pluginId
    || !('localId' in raw.nativeService) || raw.nativeService.localId !== GITHUB_CONNECTED_ACCOUNT_SERVICE.localId))
    || (raw.credentialRef !== undefined && raw.nativeService !== undefined)) {
    throw new PluginError({ code: 'github_setup_credential_invalid', message: 'Choose this Machine’s native GitHub login or one exact Connected Account.' });
  }
  const setup = parseGithubRepositorySetupInput({ repository: raw.repository,
    credentialRef: raw.credentialRef === undefined ? null : raw.credentialRef }, context.plugin.id, 'deployment');
  const explicit = raw.deploymentReview === undefined ? null : parseGithubDeploymentMonitoringSelection(raw.deploymentReview);
  const routing = await context.services.actions.getCurrentExecutionRouting?.({ signal: context.signal });
  context.signal.throwIfAborted();
  const unavailable = () => new PluginError({ code: 'github_deployment_monitoring_placement_unavailable',
    message: 'Choose a currently available monitoring Machine in the Event editor.' });
  if (!routing || routing.pluginId !== context.plugin.id || (explicit && explicit.monitoringMachineId !== routing.machineId)) throw unavailable();
  const deploymentReview = { ...explicit, monitoringMachineId: routing.machineId };
  let result: PluginEventAutomationSetupResultV1;
  if (setup.credentialRef && 'teamId' in setup.credentialRef && setup.credentialRef.selection.deliveryMode === 'brokered') {
    const lookup = await context.services.actions.execute({ pluginId: context.plugin.id, localId: GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID },
      setup, { signal: context.signal });
    const source = PluginEventAutomationSetupResultV1Schema.parse(lookup);
    const resolved = GithubAutomationRepositorySourceConfigV1Schema.parse(source.sourceConfig);
    result = { ...source, sourceInstanceId: `github:repository:${resolved.repository.repositoryId}:deployment-review`,
      sourceConfig: { ...resolved, credentialRef: setup.credentialRef, deploymentReview } };
  } else {
    result = await setupGithubRepositoryEventSource({ ...setup, deploymentReview }, context);
  }
  const current = await context.services.actions.getCurrentExecutionRouting?.({ signal: context.signal });
  context.signal.throwIfAborted();
  if (!current || current.pluginId !== routing.pluginId || current.machineId !== routing.machineId
    || current.serverIdentityId !== routing.serverIdentityId) throw unavailable();
  const deliveryMode = explicit?.deliveryMode ?? 'automatic';
  return PluginEventAutomationSetupResultV1Schema.parse({ ...result, observationOnly: { kind: 'observationOnly' },
    ...(deliveryMode === 'polling' ? {} : { webhookDelivery: deliveryMode === 'webhook' ? 'required' : 'automatic' }) });
}

/** Resolve through the existing exact-account repository setup; no second client. */
export async function setupGithubPullRequestChecksSource(input: unknown, context: PluginInvocationContext): Promise<PluginEventAutomationSetupResultV1> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throwHistoryGapResetInputInvalid();
  const raw = input as Readonly<Record<string, unknown>>;
  if (Object.keys(raw).length !== 3) throwHistoryGapResetInputInvalid();
  const checks = parseGithubChecksSource(raw.checks);
  const setup = await setupGithubRepositoryEventSource({ credentialRef: raw.credentialRef, repository: raw.repository }, context);
  const config = setup.sourceConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throwHistoryGapResetInputInvalid();
  const repository = config.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository) || typeof repository.repositoryId !== 'string') throwHistoryGapResetInputInvalid();
  return PluginEventAutomationSetupResultV1Schema.parse({ ...setup,
    sourceInstanceId: githubChecksSourceInstanceId(repository.repositoryId, checks),
    sourceConfig: { ...config, checks }, displayLabel: `${setup.displayLabel}#${checks.pullRequestNumber} · ${checks.selection} checks`,
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
  const source = await readCurrentGithubAutomationEventSource({ context, selector: reset });
  context.signal.throwIfAborted();
  if (source === null) {
    return PluginEventAutomationHistoryGapResetActionResultV1Schema.parse({ kind: 'stale' });
  }
  try {
    return PluginEventAutomationHistoryGapResetActionResultV1Schema.parse(
      await replaceGithubAutomationEventHistoryGapWithBaseline({
        context,
        definition: source.definition,
        isDefinitionCurrent: source.isCurrent,
      }),
    );
  } catch (error) {
    context.signal.throwIfAborted();
    const cause = readUnexpectedActionErrorDiagnosticV1(error);
    const phase = 'github.automation.baseline';
    throw withActionFailureDiagnostic(new PluginError({
      ...(isPluginError(error) ? error.data : {}),
      code: isPluginError(error) ? error.code : 'plugin_action_execution_failed',
      message: isPluginError(error) ? error.message : 'GitHub Event baseline failed.',
      retryable: isPluginError(error) ? error.retryable : false,
      failureCause: (isPluginError(error) ? error.data.failureCause : undefined) ?? {
        phase, errorClass: cause.errorClass, errorCode: cause.errorCode, httpStatus: cause.httpStatus,
      },
    }), { phase, causeKind: 'native_failure', error });
  }
}
