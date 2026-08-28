import type {
    AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { WorkStateItem } from '@happier-dev/plugin-sdk/sessions/work-state';
import {
  SessionActivityHeadlineBundleV1Schema,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import { createClaudeNativeSdkQueryContext } from '../sdk/nativeExec.js';
import {
  createClaudeWorkflowSystemRecordBridge,
} from '../workflowRecords/workflowRuntime.js';
import type { ClaudeAgentSdkContext } from './remote/sdk/session.js';

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
): (snapshot: SessionWorkStateV1) => void {
  const publisher = context.workState.publisher('goals');
  let sourceSequence = 0;
  return (snapshot) => {
    const items = snapshot.items
      .map(toNativeGoalWorkStateItem)
      .filter((item): item is WorkStateItem => item !== null);
    const primaryLocalId = items.some((item) => item.localId === snapshot.primaryItemId)
      ? snapshot.primaryItemId
      : null;
    void publisher.publish({
      sourceSequence: ++sourceSequence,
      observedAtMs: snapshot.updatedAt,
      items,
      primaryLocalId,
    }).catch((error) => {
      context.services.logger.warn('[Claude] native goal work-state publication failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

export function createClaudeNativeAgentSdkContext(
  context: AgentSessionRuntimeContext,
): ClaudeAgentSdkContext {
  const services = context.session.services;
  const currentSession = context.services.sessions?.current;
  const workflowSystemRecords = createClaudeWorkflowSystemRecordBridge(
    currentSession,
  );
  const sessionAuth = currentSession?.auth;
  return {
    logger: {
      debug(message, fields) { context.services.logger.debug(message, jsonFields(fields)); },
      info(message, fields) { context.services.logger.info(message, jsonFields(fields)); },
      warn(message, fields) { context.services.logger.warn(message, jsonFields(fields)); },
      error(message, fields) { context.services.logger.error(message, jsonFields(fields)); },
    },
    agentRuntime: {
      exec: createClaudeNativeSdkQueryContext(context.services.exec),
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
      transcripts: {
        fileFollow: {
          async follow(input) {
            return await services.transcripts.fileFollow.follow(input);
          },
        },
        async publishSessionEvent(event) {
          return await services.transcripts.publishSessionEvent(event);
        },
      },
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
      toolExecution: services.toolExecution,
    },
    sessions: {
      current: {
        auth: {
          services: {
            async refreshRuntimeAuth(request, options) {
              if (!sessionAuth) return unavailable('runtime authentication refresh');
              const { agentId: _agentId, ...nativeRequest } = request;
              if (!isNativeConnectedServiceId(nativeRequest.serviceId)) {
                return unavailable(`runtime authentication service ${nativeRequest.serviceId}`);
              }
              return await sessionAuth.services.refreshRuntimeAuth(nativeRequest, options);
            },
          },
        },
        permissions: {
          async requestDecision() {
            return {
              decision: 'denied',
              rationale: 'Claude native permissions are resolved through context.ui.',
            };
          },
        },
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
