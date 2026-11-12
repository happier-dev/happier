import { isPluginError, PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/plugin-sdk/errors';
import { isPluginActionApprovalRequestCreated, type PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { SessionPullRequestBindingResultV1Schema, SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
  type SessionPullRequestBindingInputV1, type SessionPullRequestBindingResultV1 } from '@happier-dev/channels-protocol/v1';
import { TriageSourceCredentialInputsV1, TriageSourceCredentialBindingV1Schema,
  TriageSourceReadSessionLinksResultV1Schema, type TriageConfiguredSourceInstanceV1,
  type TriageSourceEntryLocalRefV1, type TriageSourceLinkSessionResultV1,
  type TriageSourceReadSessionLinksResultV1 } from '@happier-dev/triage-protocol/v1';
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
const accountRelationsAction = { pluginId: 'happier.channels', localId: 'session-pull-request-relations-v1' };
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

function prepareRelationsInput(input: Readonly<{
  instance: TriageConfiguredSourceInstanceV1; localRef?: TriageSourceEntryLocalRefV1; sessionId?: string;
}>) {
  const admitted = admitInstance(input.instance);
  const pullRequest = input.localRef === undefined ? undefined : exactPullRequest(input.localRef);
  if (admitted === null || pullRequest === null) return null;
  return { admitted, pullRequest, request: { kind: 'readRelations' as const, credentialRef: admitted.credentialRef,
    ...(pullRequest === undefined ? {} : { pullRequest }), ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) } };
}

async function readRelations(input: Readonly<{
  instance: TriageConfiguredSourceInstanceV1; localRef?: TriageSourceEntryLocalRefV1; sessionId?: string;
}>, execute: (request: SessionPullRequestBindingInputV1, credentialRef: ConnectedAccountRef | null) => Promise<SessionPullRequestBindingResultV1>) {
  const prepared = prepareRelationsInput(input);
  if (prepared === null) return null;
  const { admitted, pullRequest } = prepared;
  const result = await execute(prepared.request, admitted.credentialRef);
  if (result.kind !== 'relations') return null;
  for (const link of result.links) {
    if ((pullRequest !== undefined && (link.repositoryId !== pullRequest.repositoryId || link.pullRequest.number !== pullRequest.number))
      || (input.sessionId !== undefined && link.sessionId !== input.sessionId)) return null;
  }
  return { admitted, links: result.links };
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
    target = await context.services.actions.observe(bindingAction, prepared.request, invalidate, options);
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

/** Thin GitHub PR-only projection; Channels is the sole relationship store and writer. */
export async function readGithubTriageSessionLinks(input: unknown, context: PluginInvocationContext): Promise<TriageSourceReadSessionLinksResultV1> {
  return readSessionLinks(input, context.signal, (request, credentialRef) => executeBinding(request, context, credentialRef));
}

/** Account placement is selected by readActions; Channels retains the same relationship reader. */
export async function readAccountGithubTriageSessionLinks(input: unknown, context: GithubTriageInvocationContext): Promise<TriageSourceReadSessionLinksResultV1> {
  return readSessionLinks(input, context.signal, async request => {
    const result = await context.services.actions.execute(accountRelationsAction, request, { signal: context.signal });
    context.signal.throwIfAborted();
    return SessionPullRequestBindingResultV1Schema.parse(result);
  });
}

async function readSessionLinks(input: unknown, signal: AbortSignal,
  execute: (request: SessionPullRequestBindingInputV1, credentialRef: ConnectedAccountRef | null) => Promise<SessionPullRequestBindingResultV1>): Promise<TriageSourceReadSessionLinksResultV1> {
  const parsed = TriageSourceCredentialInputsV1.readSessionLinks.safeParse(input);
  if (!parsed.success) return unavailable;
  try {
    const result = await readRelations(parsed.data, execute);
    if (result === null) return unavailable;
    const links: Array<Extract<TriageSourceReadSessionLinksResultV1, { kind: 'complete' }>['links'][number]> = [];
    const positions = new Map<string, number>();
    for (const relation of result.links) {
      const route = parseGithubRoutingToken(relation.pullRequest.repository);
      const localRef = buildGithubEntryLocalRef({ kindId: 'pull-request', repositoryId: relation.repositoryId, nativeItemId: relation.pullRequest.number });
      if (route === null || localRef === null) return unavailable;
      const locator = buildGithubEntryLocator({ ...route, entryNumber: localRef.entryId,
        webUrl: `https://github.com/${relation.pullRequest.repository}/pull/${localRef.entryId}` });
      if (locator === null) return unavailable;
      const selection = result.admitted.configuration.selection;
      if (selection.kind === 'selected' && !selection.unitIds.includes(locator.routingToken)) continue;
      const key = JSON.stringify([localRef.collisionScope, localRef.entryId, relation.sessionId]);
      const position = positions.get(key);
      if (position !== undefined) {
        const existing = links[position]!;
        links[position] = { ...existing, linkedAtMs: Math.min(existing.linkedAtMs, relation.linkedAtMs) };
      } else {
        positions.set(key, links.length);
        links.push({ localRef, sessionId: relation.sessionId, linkedAtMs: relation.linkedAtMs,
          displayPath: locator.displayPath, locator: toTriageLocator(locator) });
      }
    }
    return TriageSourceReadSessionLinksResultV1Schema.parse({ kind: 'complete', links });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (isPluginError(error)) throw error;
    return unavailable;
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
      const current = await readRelations(request, (input, credentialRef) => executeBinding(input, context, credentialRef));
      if (current === null) return refuse('github_session_relations_invalid', 'read_relations');
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
