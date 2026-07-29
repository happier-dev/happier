import type {
  AgentRuntimeContext,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agent-runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginSessionWorkStateItem } from '@happier-dev/plugin-sdk/runtime';
import type { SessionMetadataWriteRequestV1 } from '@happier-dev/plugin-sdk/experimental/sessions';
import {
  SessionWorkflowActivityHeadlineV1Schema,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { createClaudeNativeSdkQueryContext } from '../sdk/nativeExec.js';
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

const WORKFLOW_ACTIVITY_HEADLINE_METADATA_KEY = 'sessionWorkflowActivityHeadlineV1';
const WORKFLOW_ACTIVITY_HEADLINE_WRITE_REASON = 'claude_workflow_activity_headline';

function readWorkflowActivityHeadlineWrite(request: SessionMetadataWriteRequestV1) {
  if (request.kind !== 'update' || request.reason !== WORKFLOW_ACTIVITY_HEADLINE_WRITE_REASON) {
    return unavailable('legacy metadata writes');
  }
  const candidate = request.handler({});
  if (
    !candidate
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || Object.keys(candidate).length !== 1
    || !Object.prototype.hasOwnProperty.call(candidate, WORKFLOW_ACTIVITY_HEADLINE_METADATA_KEY)
  ) {
    throw new Error('Claude workflow activity may publish only the compact session headline.');
  }
  return SessionWorkflowActivityHeadlineV1Schema.parse(
    candidate[WORKFLOW_ACTIVITY_HEADLINE_METADATA_KEY],
  );
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
): PluginSessionWorkStateItem | null {
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
      .filter((item): item is PluginSessionWorkStateItem => item !== null);
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
  context: AgentRuntimeContext,
  sessionContext?: AgentSessionRuntimeContext,
): ClaudeAgentSdkContext {
  const services = sessionContext?.session.services;
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
          if (!services) return unavailable('session hooks');
          const { providerId: _providerId, sessionId: _sessionId, lifecycle: _lifecycle, ...nativeRequest } = request;
          return await services.sessionHooks.startServer(nativeRequest);
        },
        async resolveForwarderAssets() {
          if (!services) return unavailable('session hook assets');
          return await services.sessionHooks.resolveForwarderAssets();
        },
        async createPluginDir(request) {
          if (!services) return unavailable('session hook plugin directory');
          const { providerId: _providerId, lifecycle: _lifecycle, ...nativeRequest } = request;
          return await services.sessionHooks.createPluginDir(nativeRequest);
        },
        async disposePluginDir(pluginDir) {
          if (!services) return unavailable('session hook plugin directory');
          await services.sessionHooks.disposePluginDir(pluginDir);
        },
        async publishProviderTranscript(request) {
          if (!services) return unavailable('provider transcript publication');
          await services.sessionHooks.publishProviderTranscript(request);
        },
      },
      transcripts: {
        fileFollow: {
          async follow(input) {
            if (!services) return unavailable('transcript following');
            return await services.transcripts.fileFollow.follow(input);
          },
        },
      },
      accountUsage: {
        async resolveSourceContext(input, options) {
          if (!services) return null;
          const sourceContext = await services.accountUsage.resolveSourceContext(input, options);
          return sourceContext ? { ...sourceContext, serviceId: input.serviceId } : null;
        },
        async recordSnapshot(input, options) {
          if (!services) return { status: 'unavailable', reason: 'session_scope_unavailable' };
          const { sessionId: _sessionId, ...nativeInput } = input;
          return await services.accountUsage.recordSnapshot(nativeInput, options);
        },
      },
    },
    sessions: {
      current: {
        auth: {
          services: {
            async refreshRuntimeAuth(request, options) {
              if (!services) return unavailable('runtime authentication refresh');
              const { agentId: _agentId, ...nativeRequest } = request;
              if (!isNativeConnectedServiceId(nativeRequest.serviceId)) {
                return unavailable(`runtime authentication service ${nativeRequest.serviceId}`);
              }
              return await services.auth.refreshRuntimeAuth(nativeRequest, options);
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
          if (!services) return unavailable('session system-record reads');
          const { reason: _reason, ...nativeRequest } = request;
          return await services.systemRecords.read(nativeRequest);
        },
        async writeSystemRecord(request) {
          if (!services) return unavailable('session system-record writes');
          const { reason: _reason, payload, ...nativeRequest } = request;
          await services.systemRecords.write({
            ...nativeRequest,
            payload: AgentRuntimeJsonValueSchema.parse(payload),
          });
        },
        async writeMetadata(request) {
          if (!services) return unavailable('workflow activity headline publication');
          await services.workflowActivity.publishHeadline(readWorkflowActivityHeadlineWrite(request));
        },
        async writeStateField() {
          return unavailable('legacy state-field writes');
        },
      },
    },
  };
}
