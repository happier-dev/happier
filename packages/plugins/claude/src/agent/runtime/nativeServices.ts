import type {
    AgentExecutionRunRuntimeContextV1,
    AgentRuntimeContext,
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  SessionPermissionDecisionRequest,
  SessionPermissionsService,
} from '@happier-dev/plugin-sdk/sessions';
import type { WorkStateItem } from '@happier-dev/plugin-sdk/sessions/work-state';
import {
  SessionActivityHeadlineBundleV1Schema,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import { createClaudeNativeSdkQueryContext } from '../sdk/nativeExec.js';
import { createClaudeNativePermissionEngine } from '../permissions/nativePermissionEngine.js';
import { isAskUserQuestionToolName } from '../permissions/askUserQuestion.js';
import { CLAUDE_NATIVE_QUESTION_REQUEST_SOURCE, type ClaudePermissionDecision } from '../permissions/createClaudePermissionEngine.js';
import { readClaudeCodeNativeCredentialPayload } from '../auth/services/native/credentials.js';
import {
  createClaudeWorkflowSystemRecordBridge,
} from '../workflowRecords/workflowRuntime.js';
import type {
  ClaudeAgentSdkContext,
  ClaudeAgentSdkExecutionRunContext,
  ClaudeAgentSdkSessionContext,
} from './remote/sdk/session.js';

function jsonFields(
  fields: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!fields) return undefined;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) return [key, value];
    return [key, value instanceof Error ? value.message : String(value)];
  }));
}

function createClaudeRuntimeLogger(context: AgentRuntimeContext): ClaudeAgentSdkContext['logger'] {
  return {
    debug(message, fields) { context.services.logger.debug(message, jsonFields(fields)); },
    info(message, fields) { context.services.logger.info(message, jsonFields(fields)); },
    warn(message, fields) { context.services.logger.warn(message, jsonFields(fields)); },
    error(message, fields) { context.services.logger.error(message, jsonFields(fields)); },
  };
}

function unavailable(name: string): never {
  throw new Error(`Claude ${name} is unavailable outside a native session invocation.`);
}

function isNativeConnectedServiceId(
  serviceId: string,
): serviceId is 'anthropic' | 'bitbucket' | 'claude-subscription' | 'gemini' | 'github' | 'openai' | 'openai-codex' {
  return serviceId === 'anthropic'
    || serviceId === 'bitbucket'
    || serviceId === 'claude-subscription'
    || serviceId === 'gemini'
    || serviceId === 'github'
    || serviceId === 'openai'
    || serviceId === 'openai-codex';
}

function toNativeGoalWorkStateItem(
  item: SessionWorkStateV1['items'][number],
): WorkStateItem | null {
  if (item.kind !== 'goal') return null;
  return {
    localId: item.id,
    kind: 'goal',
    origin: item.origin,
    status: item.status,
    ...(item.statusReason ? { statusReason: item.statusReason } : {}),
    title: item.title,
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.vendorRef === undefined ? {} : { providerRef: item.vendorRef }),
    ...(item.order === undefined ? {} : { order: item.order }),
    ...(item.parentId === undefined ? {} : { parentProviderRef: item.parentId }),
    ...(item.priority === undefined ? {} : { priority: item.priority }),
    ...(item.progress === undefined ? {} : { progress: item.progress }),
    ...(item.tokenBudget === undefined ? {} : { tokenBudget: item.tokenBudget }),
    ...(item.tokensUsed === undefined ? {} : { tokensUsed: item.tokensUsed }),
    ...(item.timeUsedSeconds === undefined ? {} : { timeUsedSeconds: item.timeUsedSeconds }),
    ...(item.createdAt === undefined ? {} : { createdAtMs: item.createdAt }),
    ...(item.startedAt === undefined ? {} : { startedAtMs: item.startedAt }),
    ...(item.completedAt === undefined ? {} : { completedAtMs: item.completedAt }),
    updatedAtMs: item.updatedAt,
  };
}

export function createClaudeNativeGoalWorkStatePublisher(
  context: AgentSessionRuntimeContext,
): (snapshot: SessionWorkStateV1) => Promise<void> {
  const publisher = context.workState.publisher('goals');
  let sourceSequence = 0;
  return async (snapshot) => {
    const items = snapshot.items
      .map(toNativeGoalWorkStateItem)
      .filter((item): item is WorkStateItem => item !== null);
    const primaryLocalId = items.some((item) => item.localId === snapshot.primaryItemId)
      ? snapshot.primaryItemId
      : null;
    await publisher.publish({
      sourceSequence: ++sourceSequence,
      observedAtMs: snapshot.updatedAt,
      items,
      primaryLocalId,
    }).then((result) => {
      if (result.status !== 'applied' && result.status !== 'unchanged') {
        throw new Error('diagnostic' in result ? result.diagnostic.code : 'agent_work_state_publication_unconfirmed');
      }
    }).catch((error) => {
      context.services.logger.warn('[Claude] native goal work-state publication failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  };
}

function readUpdatedPermissions(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  return Array.isArray(value)
    && value.every((entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    ? value as readonly Readonly<Record<string, unknown>>[]
    : undefined;
}

function readStructuredQuestionAnswers(
  value: unknown,
): Readonly<Record<string, readonly string[]>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const answers: Record<string, readonly string[]> = {};
  for (const [question, answer] of Object.entries(value)) {
    if (typeof answer !== 'string' || answer.length === 0) continue;
    answers[question] = [answer];
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function createNativePermissionDecisionAdapter(context: AgentSessionRuntimeContext) {
  const engine = createClaudeNativePermissionEngine(context);
  return {
    async settleObservedDecision(request: Parameters<NonNullable<SessionPermissionsService['settleObservedDecision']>>[0]): Promise<boolean> {
      const permissions = context.services.sessions.current?.permissions;
      if (!permissions?.settleObservedDecision) return unavailable('native dialog settlement');
      return await permissions.settleObservedDecision(request);
    },
    async requestDecision(
      request: SessionPermissionDecisionRequest,
      options?: Parameters<SessionPermissionsService['requestDecision']>[1],
    ): Promise<ClaudePermissionDecision> {
      const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : '';
      if (!toolName) return { decision: 'denied', rationale: 'Claude supplied an invalid tool request.' };
      if (isAskUserQuestionToolName(toolName)) {
        const permissions = context.services.sessions.current?.permissions;
        if (!permissions) return unavailable('native dialog permission scope');
        // Runtime-authored terminal dialogs retain their source, presentation,
        // cancellation and apply-before-answer acknowledgement at the rich host seam.
        return await permissions.requestDecision({ ...request, source: request.source ?? CLAUDE_NATIVE_QUESTION_REQUEST_SOURCE }, options);
      }
      const requestId = typeof request.requestId === 'string' ? request.requestId : null;
      const toolUseId = typeof request.toolCallId === 'string' ? request.toolCallId : null;
      const result = await engine.canCallTool(toolName, request.input, {
        requestId,
        toolUseId,
        signal: options?.signal,
      });
      const updatedPermissions = result.behavior === 'allow'
        ? readUpdatedPermissions(result.updatedPermissions)
        : undefined;
      const answers = result.behavior === 'allow'
        ? readStructuredQuestionAnswers(result.updatedInput?.answers)
        : undefined;
      const decision: ClaudePermissionDecision = result.behavior === 'allow'
        ? {
            decision: 'approved',
            updatedInput: result.updatedInput,
            ...(answers ? { answers } : {}),
            ...(updatedPermissions ? { updatedPermissions } : {}),
          }
        : {
            decision: 'denied',
            rationale: result.message,
          };
      await options?.acknowledgeDecisionApplication?.(decision);
      return decision;
    },
  };
}

export function createClaudeNativeAgentSdkContext(
  context: AgentSessionRuntimeContext,
): ClaudeAgentSdkSessionContext {
  const services = context.session.services;
  const currentSession = context.services.sessions?.current;
  const workflowSystemRecords = createClaudeWorkflowSystemRecordBridge(
    currentSession,
  );
  const sessionAuth = services.auth;
  return {
    logger: createClaudeRuntimeLogger(context),
    agentRuntime: {
      exec: createClaudeNativeSdkQueryContext(context.services.exec, (message) => context.services.logger.warn(message), services.nativeLaunch),
      sessionHooks: {
        async startServer(request) {
          const { providerId: _providerId, sessionId: _sessionId, lifecycle: _lifecycle, ...nativeRequest } = request;
          return await services.sessionHooks.startServer(nativeRequest);
        },
        async resolveForwarderAssets() {
          return await services.sessionHooks.resolveForwarderAssets();
        },
        async createPluginDir(request) {
          const { providerId: _providerId, lifecycle: _lifecycle, ...nativeRequest } = request;
          return await services.sessionHooks.createPluginDir(nativeRequest);
        },
        async disposePluginDir(pluginDir) {
          await services.sessionHooks.disposePluginDir(pluginDir);
        },
        async publishProviderTranscript(request) {
          await services.sessionHooks.publishProviderTranscript(request);
        },
      },
      transcripts: services.transcripts,
      accountUsage: {
        async resolveSourceContext(input, options) {
          const sourceContext = await services.accountUsage.resolveSourceContext(input, options);
          return sourceContext ? { ...sourceContext, serviceId: input.serviceId } : null;
        },
        async recordSnapshot(input, options) {
          const { sessionId: _sessionId, ...nativeInput } = input;
          return await services.accountUsage.recordSnapshot(nativeInput, options);
        },
      },
      ...(services.nativeHome ? { nativeHome: services.nativeHome } : {}),
      ...(services.inputFiles ? { inputFiles: services.inputFiles } : {}),
      toolExecution: services.toolExecution,
      modes: services.modes,
    },
    sessions: {
      current: {
        ...(currentSession?.media ? { media: currentSession.media } : {}),
        auth: {
          services: {
            async refreshRuntimeAuth(request, options) {
              if (!sessionAuth) return unavailable('runtime authentication refresh');
              const { agentId: _agentId, ...nativeRequest } = request;
              if (!isNativeConnectedServiceId(nativeRequest.serviceId)) {
                return unavailable(`runtime authentication service ${nativeRequest.serviceId}`);
              }
              const refreshed = await sessionAuth.services.refreshRuntimeAuth(nativeRequest, options);
              if (refreshed.status !== 'refreshed' || nativeRequest.serviceId !== 'claude-subscription') return refreshed;
              const proof = refreshed.result;
              const credentialRevision = proof && typeof proof === 'object' && !Array.isArray(proof)
                && 'credentialRevision' in proof && typeof proof.credentialRevision === 'string'
                ? proof.credentialRevision : null;
              if (!credentialRevision) return { status: 'failed', reason: 'runtime_auth_credential_revision_unavailable' };
              // The host settles only after this exact home is rematerialized. Decode the native
              // access token here; rotation remains exclusively owned by the daemon coordinator.
              let credential: ReturnType<typeof readClaudeCodeNativeCredentialPayload> = null;
              try {
                const bytes = (await services.nativeHome?.readFiles(['.credentials.json']))?.['.credentials.json'];
                credential = readClaudeCodeNativeCredentialPayload(bytes ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null);
              } catch {
                return { status: 'failed', reason: 'runtime_auth_native_materialization_unavailable' };
              }
              options?.signal?.throwIfAborted();
              if (!credential) return { status: 'failed', reason: 'runtime_auth_native_materialization_unavailable' };
              return { status: 'refreshed', result: { accessToken: credential.claudeAiOauth.accessToken, credentialRevision } };
            },
          },
        },
        permissions: createNativePermissionDecisionAdapter(context),
        async readSystemRecord(request) {
          if (!workflowSystemRecords) return unavailable('session system-record reads');
          return await workflowSystemRecords.read(request);
        },
        async writeSystemRecord(request) {
          if (!workflowSystemRecords) return unavailable('session system-record writes');
          await workflowSystemRecords.write(request);
        },
        workflowActivity: {
          async publishHeadlines(bundle) {
            // Fail closed on the whole bundle: publishing one key of a pair meant to describe the
            // same snapshots would leave the two disagreeing about what exists.
            await services.workflowActivity.publishHeadlines(
              SessionActivityHeadlineBundleV1Schema.parse(bundle),
            );
          },
        },
        async writeStateField() {
          return unavailable('legacy state-field writes');
        },
      },
    },
  };
}

/** Claude Agent SDK services that are truthful for a detached Execution Run. */
export function createClaudeNativeExecutionRunAgentSdkContext(
  context: AgentExecutionRunRuntimeContextV1,
): ClaudeAgentSdkExecutionRunContext {
  const services = context.executionRun.services;
  return {
    logger: createClaudeRuntimeLogger(context),
    agentRuntime: {
      exec: createClaudeNativeSdkQueryContext(context.services.exec, (message) => context.services.logger.warn(message), services.nativeLaunch),
      fileFollow: services.fileFollow,
      hooks: services.hooks,
      toolExecution: services.toolExecution,
      ...(services.nativeHome ? { nativeHome: services.nativeHome } : {}),
    },
  };
}
