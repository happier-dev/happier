import type { AgentId } from '@happier-dev/agents';

import { createCatalogHostSessionRuntimePlan } from '@/agent/runtime/session/loop/catalogPlan';
import type { DeferredStartupPushSender } from '@/agent/runtime/startup/deferredStartupTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatErrorForUi } from '@/ui/formatErrorForUi';

import type { Session } from './session/ClaudeSession';
import {
  createClaudeDeferredStartupSession,
  shouldUseClaudeDeferredStartup,
} from '../startup/createClaudeDeferredStartupSession';
import { synchronizeClaudeStartupOverrides } from '../startup/synchronizeClaudeStartupOverrides';
import { createClaudeHookServerAdjunct } from '../utils/createClaudeHookServerAdjunct';
import { createClaudeRuntimeAdjunctState } from '../utils/createClaudeRuntimeAdjunctState';
import {
  type ClaudeSessionRuntimeOptions,
} from './claudeSessionRuntimeOptions';
import { type EnhancedMode } from './claudeEnhancedMode';
import { createClaudeRuntimeTurnOperations } from './createTurnOperations';
import {
  resolveClaudeRuntimeSessionLeaf,
  type ClaudeRuntimeSessionLeaf,
} from './resolveSessionLeaf';

type ClaudeSessionRuntimePlanOptions = ClaudeSessionRuntimeOptions;

function resolveClaudeSessionRuntimePlanOptions(
  sessionParams: unknown,
  leaf: ClaudeRuntimeSessionLeaf,
): ClaudeSessionRuntimePlanOptions {
  const baseSessionParams =
    sessionParams && typeof sessionParams === 'object'
      ? sessionParams as Record<string, unknown>
      : {};

  switch (leaf.kind) {
    case 'claudeRemoteSessionRuntimeLeaf':
      return {
        ...baseSessionParams,
        ...leaf.startOptions,
        credentials: leaf.credentials,
        startingMode: 'remote',
      } as ClaudeSessionRuntimePlanOptions;
    case 'claudeTerminalSessionRuntimeLeaf':
      return {
        ...baseSessionParams,
        ...leaf.startOptions,
        credentials: leaf.credentials,
        startingMode: 'terminal',
      } as ClaudeSessionRuntimePlanOptions;
  }
}

function createNoopClaudeTerminalDisplay(): null {
  return null;
}

function createInitialEnhancedMode(params: Readonly<{
  opts: ClaudeSessionRuntimeOptions;
  initialClaudeRemoteMetaState: ReturnType<typeof createClaudeRuntimeAdjunctState>['initialClaudeRemoteMetaState'];
}>): EnhancedMode {
  return {
    permissionMode: params.opts.permissionMode ?? 'default',
    agentModeId: params.opts.sessionModeId ?? null,
    model: params.opts.model ?? params.opts.modelId,
    ...params.initialClaudeRemoteMetaState,
  };
}

export function createClaudeSessionRuntimePlan(sessionParams: unknown): HostSessionRuntimePlan {
  const leaf = resolveClaudeRuntimeSessionLeaf(sessionParams);
  const opts = resolveClaudeSessionRuntimePlanOptions(sessionParams, leaf);
  const currentSessionRef = { current: null as Session | null };
  const deferredPushSenderRef = { current: null as DeferredStartupPushSender | null };
  const adjunctState = createClaudeRuntimeAdjunctState({
    claudeRemoteMetaDefaults: opts.claudeRemoteMetaDefaults,
  });
  const initialMode = createInitialEnhancedMode({
    opts,
    initialClaudeRemoteMetaState: adjunctState.initialClaudeRemoteMetaState,
  });
  let hookAdjunctPromise: ReturnType<typeof createClaudeHookServerAdjunct> | null = null;

  return createCatalogHostSessionRuntimePlan({
    providerId: 'claude',
    opts,
    config: {
      flavor: 'claude',
      policyAgentId: 'claude' as AgentId,
      backendDisplayName: 'Claude',
      uiLogPrefix: '[claude]',
      providerName: 'Claude',
      waitingForCommandLabel: 'Claude',
      agentMessageType: 'claude',
      initializeSession: {
        startupSideEffectsOrder: 'persist-first',
      },
      supportsMcpServers: true,
      machineMetadata: initialMachineMetadata,
      terminalDisplay: createNoopClaudeTerminalDisplay,
      shouldRenderTerminalDisplay: () => false,
      formatPromptErrorMessage: formatErrorForUi,
      startRuntimeBeforeFirstPrompt: true,
      startupBootstrap: {
        shouldCreate: ({ opts }) => shouldUseClaudeDeferredStartup(opts as ClaudeSessionRuntimeOptions),
        create: async ({ opts }) => {
          const planOpts = opts as ClaudeSessionRuntimePlanOptions;
          return await createClaudeDeferredStartupSession({
            credentials: leaf.credentials,
            opts: planOpts,
            onPushSenderReady: async (pushSender) => {
              deferredPushSenderRef.current = pushSender;
              currentSessionRef.current?.setPushSender(pushSender);
            },
          });
        },
      },
      lifecycleHooks: {
        onSessionInitialized: async ({ session, opts, attachedToExistingSession }) => {
          await synchronizeClaudeStartupOverrides({
            session,
            sessionKind: attachedToExistingSession ? 'attach' : 'fresh',
            opts,
          });
        },
      },
      createNativeRuntime: async ({
        directory,
        machineId,
        session,
        mcpServers,
        setThinking,
        getPermissionMode,
      }) => {
        hookAdjunctPromise ??= createClaudeHookServerAdjunct({
          getCurrentSession: () => currentSessionRef.current,
          localPermissionBridgeManager: adjunctState.localPermissionBridgeManager,
          localPermissionBridgeWaitIndefinitely: adjunctState.initialLocalPermissionBridgeWaitIndefinitely,
          localPermissionBridgeTimeoutMs: adjunctState.initialLocalPermissionBridgeTimeoutMs,
        });
        const hookAdjunct = await hookAdjunctPromise;
        return createClaudeRuntimeTurnOperations({
          opts,
          directory,
          machineId,
          session,
          mcpServers,
          hookSettingsPath: hookAdjunct.hookSettingsPath,
          hookPluginDir: hookAdjunct.hookPluginDir,
          hookServer: hookAdjunct.hookServer,
          currentSessionRef,
          initialMode,
          setThinking,
          getPermissionMode,
          localPermissionBridgeManager: adjunctState.localPermissionBridgeManager,
          deferredPushSenderRef,
        });
      },
    },
  });
}
