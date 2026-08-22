import type {
  SessionAuthService,
  SessionHandle,
  SessionMediaService,
  SessionMediaSourceRoot,
  SessionRuntimeAuthRefreshRequest,
} from '@happier-dev/plugin-sdk/sessions';
import type {
  InteractionsService } from '@happier-dev/plugin-sdk/interactions';
import { PluginError } from '@happier-dev/plugin-sdk';
import { randomUUID } from 'node:crypto';

import type { StoredCredentials } from '@/persistence';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createSessionHandleAuthService } from '@/plugins/runtime/context/session/services/auth';
import { createSessionScopedMcpServices } from '@/plugins/runtime/context/session/services/mcp';
import { hostSubagentStore } from '@/session/subagents/hostSubagentStore';
import { createPluginSubagentsService } from '@/session/subagents/pluginSubagentsService';
import { createServerPluginSubagentDurableCustody } from '@/session/subagents/serverPluginSubagentDurableCustody';
import { createPluginSessionSystemRecordsService } from '@/session/systemRecords/pluginSessionSystemRecordsService';
import { setSessionTitle } from './setSessionTitle';
import type { PluginSessionHandleCapabilities } from './pluginSessionsInventory';

export type PluginSessionLiveCapabilities = Readonly<{
  scopeId: symbol;
  permissionHandler?: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
  interactions?: InteractionsService;
  readPermissionMode: () => string;
  media?: SessionMediaService;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}>;

export type PluginSessionCapabilityCaller = Readonly<{
  pluginId: string;
  contributionId: string;
  immutableGenerationId: string;
  runtimeId?: string;
}>;

type CreateCapabilitiesParams = Readonly<{
  credentials: StoredCredentials;
  readCredentials?: () => Promise<StoredCredentials | null>;
  caller: PluginSessionCapabilityCaller;
  signal: AbortSignal;
  isCurrent: () => boolean;
  readAgentId: (sessionId: string, signal?: AbortSignal) => Promise<string | null>;
  resolveLiveCapabilities: (sessionId: string) => PluginSessionLiveCapabilities | null;
}>;

function current(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
  third?: AbortSignal,
): AbortSignal | undefined {
  const signals = [...new Set([first, second, third].filter((value): value is AbortSignal => Boolean(value)))];
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function unavailableMediaService(): SessionMediaService {
  return Object.freeze({
    async registerSourceRoot() {
      throw new PluginError({
        code: 'plugin_session_media_unavailable',
        message: 'Session media publication is unavailable for this Session',
      });
    },
  });
}

function permissionUnavailable(code: string): never {
  throw new PluginError({ code, message: 'Session permission scope is unavailable' });
}

export function createPluginSessionHandleCapabilitiesFactory(
  params: CreateCapabilitiesParams,
): (sessionId: string) => PluginSessionHandleCapabilities {
  const owner = Object.freeze({
    kind: 'plugin' as const,
    pluginId: params.caller.pluginId,
    ...(params.caller.runtimeId ? { runtimeId: params.caller.runtimeId } : {}),
  });
  const isCallerCurrent = () => !params.signal.aborted && current(params.isCurrent);

  return (sessionId: string): PluginSessionHandleCapabilities => {
    const systemRecords = createPluginSessionSystemRecordsService({
      credentials: params.credentials,
      ...(params.readCredentials ? { readCredentials: params.readCredentials } : {}),
      pluginId: params.caller.pluginId,
      sessionId,
      signal: params.signal,
      isCurrent: params.isCurrent,
    });
    const readLive = () => params.resolveLiveCapabilities(sessionId);
    const isLiveCurrent = (live: PluginSessionLiveCapabilities) => isCallerCurrent()
      && !live.signal?.aborted
      && (!live.isCurrent || current(live.isCurrent));
    const isSameLive = (expected: PluginSessionLiveCapabilities) => (
      readLive()?.scopeId === expected.scopeId
    );
    const operationSignal = (live: PluginSessionLiveCapabilities | null, signal?: AbortSignal) => (
      combineSignals(params.signal, live?.signal, signal)
    );
    const assertDisplayTitleCurrent = (signal?: AbortSignal): void => {
      if (signal?.aborted) {
        throw new PluginError({
          code: 'plugin_operation_aborted',
          message: 'Session title mutation was aborted',
        });
      }
      if (!isCallerCurrent()) {
        throw new PluginError({
          code: 'plugin_session_display_title_scope_unavailable',
          message: 'Session title mutation requires the current plugin invocation',
        });
      }
    };
    const setDisplayTitle = async (title: string | null, options?: { signal?: AbortSignal }): Promise<void> => {
      const signal = operationSignal(null, options?.signal);
      assertDisplayTitleCurrent(signal);
      const credentials = params.readCredentials
        ? await params.readCredentials()
        : params.credentials;
      assertDisplayTitleCurrent(signal);
      if (!credentials) {
        throw new PluginError({
          code: 'plugin_session_display_title_unavailable',
          message: 'Session title mutation requires current credentials',
        });
      }
      let result: Awaited<ReturnType<typeof setSessionTitle>>;
      try {
        result = await setSessionTitle({
          credentials,
          idOrPrefix: sessionId,
          title,
          currentness: {
            ...(signal ? { signal } : {}),
            assertCurrent: () => assertDisplayTitleCurrent(signal),
          },
        });
      } catch (error) {
        assertDisplayTitleCurrent(signal);
        throw error;
      }
      if (signal?.aborted || !isCallerCurrent()) {
        throw new PluginError({
          code: 'plugin_session_display_title_outcome_unknown',
          message: 'Session title mutation may have committed before its invocation retired',
        });
      }
      if (!result.ok) {
        throw new PluginError({
          code: `plugin_session_display_title_${result.code}`,
          message: 'Session title mutation was not applied',
          retryable: result.code === 'conflict' || result.code === 'unknown_error',
        });
      }
    };

    const authOwner = createSessionHandleAuthService({
      readSessionId: async (signal) => {
        if (!isCallerCurrent() || signal?.aborted) return null;
        return sessionId;
      },
      readAgentId: async (signal) => {
        if (!isCallerCurrent() || signal?.aborted) return null;
        return await params.readAgentId(sessionId, signal);
      },
    });
    const auth = Object.freeze({
      services: Object.freeze({
        async refreshRuntimeAuth(request: SessionRuntimeAuthRefreshRequest, options) {
          const result = await authOwner.services.refreshRuntimeAuth(request, {
            signal: operationSignal(null, options?.signal),
          });
          return isCallerCurrent()
            ? result
            : Object.freeze({ status: 'unavailable' as const, reason: 'runtime_auth_session_retired' });
        },
      }),
    } satisfies SessionAuthService);

    const permissions = Object.freeze({
      async requestDecision(request, options) {
        const live = readLive();
        if (!live?.permissionHandler || !isLiveCurrent(live)) {
          return permissionUnavailable('plugin_session_permission_scope_unavailable');
        }
        const toolName = request.toolName?.trim();
        if (!toolName) return permissionUnavailable('plugin_session_permission_tool_unavailable');
        const requestId = request.toolCallId?.trim()
          || request.requestId?.trim()
          || `plugin-session-permission:${randomUUID()}`;
        const result = await live.permissionHandler.handleToolCall(
          requestId,
          toolName,
          request.input ?? Object.freeze({}),
          {
            owner,
            ...(request.source?.trim() ? { source: request.source.trim() } : {}),
            signal: operationSignal(live, options?.signal),
          },
        );
        if (!isSameLive(live) || !isLiveCurrent(live)) {
          return permissionUnavailable('plugin_session_permission_scope_retired');
        }
        return Object.freeze({
          decision: result.decision,
          ...(result.answers ? { answers: result.answers } : {}),
        });
      },
      getMode() {
        const live = readLive();
        return live && isLiveCurrent(live)
          ? live.readPermissionMode()
          : permissionUnavailable('plugin_session_permission_scope_unavailable');
      },
    } satisfies SessionHandle['permissions']);

    const mcp = Object.freeze({
      async elicit(request, options) {
        const live = readLive();
        if (!live || !isLiveCurrent(live)) {
          return Object.freeze({ status: 'unavailable' as const, reason: 'mcp_elicitation_session_unavailable' });
        }
        const mcpOwner = createSessionScopedMcpServices({
          owner,
          ...(live.interactions ? { interactions: live.interactions } : {}),
          readScope: async (signal) => (
            live.permissionHandler && isSameLive(live) && isLiveCurrent(live) && !signal?.aborted
              ? Object.freeze({ permissionHandler: live.permissionHandler })
              : null
          ),
        });
        const signal = operationSignal(live, options?.signal);
        const result = await mcpOwner.elicit(request, { signal });
        if (!isSameLive(live) || !isLiveCurrent(live)) {
          return Object.freeze({ status: 'unavailable' as const, reason: 'mcp_elicitation_session_retired' });
        }
        if (signal?.aborted) {
          if (signal.reason instanceof Error) throw signal.reason;
          throw new PluginError({
            code: 'plugin_session_mcp_elicitation_aborted',
            message: 'Session MCP elicitation was aborted',
          });
        }
        return result;
      },
    } satisfies SessionHandle['mcp']);

    const media = Object.freeze({
      async registerSourceRoot(request, options) {
        const live = readLive();
        if (!live?.media || !isLiveCurrent(live)) {
          return await unavailableMediaService().registerSourceRoot(request, options);
        }
        const source = await live.media.registerSourceRoot(request, {
          signal: operationSignal(live, options?.signal),
        });
        if (!isSameLive(live) || !isLiveCurrent(live)) {
          source.dispose();
          throw new PluginError({
            code: 'plugin_session_media_scope_retired',
            message: 'Session media scope retired during registration',
          });
        }
        return Object.freeze({
          async publishGenerated(mediaRequest, publishOptions) {
            if (!isSameLive(live) || !isLiveCurrent(live)) {
              throw new PluginError({
                code: 'plugin_session_media_scope_retired',
                message: 'Session media scope is retired',
              });
            }
            const signal = operationSignal(live, publishOptions?.signal);
            const result = await source.publishGenerated(mediaRequest, {
              signal,
            });
            if (signal?.aborted || !isSameLive(live) || !isLiveCurrent(live)) {
              throw new PluginError({
                code: 'plugin_session_media_publication_outcome_unknown',
                message: 'Media publication may have committed before its Session scope retired',
              });
            }
            return result;
          },
          dispose: () => source.dispose(),
        } satisfies SessionMediaSourceRoot);
      },
    } satisfies SessionMediaService);

    const subagents = createPluginSubagentsService({
      store: hostSubagentStore,
      identity: {
        pluginId: params.caller.pluginId,
        contributionId: params.caller.contributionId,
        immutableGenerationId: params.caller.immutableGenerationId,
        parentSessionId: sessionId,
      },
      isCurrent: isCallerCurrent,
      durableCustody: createServerPluginSubagentDurableCustody({
        credentials: params.credentials,
        ...(params.readCredentials ? { readCredentials: params.readCredentials } : {}),
        identity: {
          pluginId: params.caller.pluginId,
          contributionId: params.caller.contributionId,
          immutableGenerationId: params.caller.immutableGenerationId,
          parentSessionId: sessionId,
        },
      }),
    });

    return Object.freeze({
      setDisplayTitle,
      ...systemRecords,
      auth,
      permissions,
      mcp,
      media,
      subagents,
    });
  };
}
