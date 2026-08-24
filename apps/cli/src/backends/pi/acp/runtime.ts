import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveEffectiveCodingPromptText } from '@/agent/prompting/coding/resolveEffectiveCodingPrompt';
import { resolveSessionCodingPromptSettings } from '@/agent/prompting/coding/resolveSessionCodingPromptSettings';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { logger } from '@/ui/logger';

import type { PiBackendOptions } from '@/backends/pi/acp/backend';
import { resolveHappyToolsBridgeBackendOptions } from '@/backends/pi/bridgeExtension';
import { publishPiSessionIdMetadata } from '@/backends/pi/utils/piSessionIdMetadata';
import { resolvePiSessionIdFromResumeReference } from '@/backends/pi/utils/piSessionFiles';

export function createPiAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  getSessionOpenAbortSignal?: () => AbortSignal | undefined;
  memoryRecallGuidanceEnabled?: boolean;
  fallbackToolDelivery: 'native_mcp' | 'shell_bridge' | 'unsupported';
  getPermissionMode?: () => PermissionMode | null | undefined;
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
  /**
   * Resolved account credentials. Required: the spawn-path system prompt
   * (including the tool-delivery bridge appendix) is composed from them and
   * forwarded to pi via the `--append-system-prompt` spawn flag, mirroring how
   * the claude backend resolves and forwards its system prompt.
   */
  credentials: Credentials;
  accountSettings?: Record<string, unknown> | null;
}) {
  const lastPublishedPiSessionId: { value: string | null; sessionFile?: string | null } = { value: null };
  let lastPiIdentityGeneration: number | null = null;

  return createCatalogProviderAcpRuntime<PiBackendOptions>({
    provider: 'pi',
    loggerLabel: 'PiACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: {
      kind: 'custom',
      persistBound: async (event) => {
        if (lastPiIdentityGeneration !== event.generation) {
          lastPublishedPiSessionId.value = null;
          lastPublishedPiSessionId.sessionFile = null;
          lastPiIdentityGeneration = event.generation;
        }
        await publishPiSessionIdMetadata({
          operation: event.operation,
          session: params.session,
          getPiSessionId: () => event.vendorSessionId,
          cwd: params.directory,
          processEnv: process.env,
          lastPublished: lastPublishedPiSessionId,
        });
      },
    },
    resolveExpectedVendorSessionIdForResume: resolvePiSessionIdFromResumeReference,
    onThinkingChange: params.onThinkingChange,
    getSessionOpenAbortSignal: params.getSessionOpenAbortSignal,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    getPermissionMode: params.getPermissionMode,
    backendOptions: {
      env: process.env,
    },
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
    inFlightSteer: { enabled: true },
    resolveBackendOptionsBeforeSpawn: async ({ session }) => {
      const memoryRecallGuidanceEnabled = params.memoryRecallGuidanceEnabled === true;
      const sessionProfileId = session.getMetadataSnapshot()?.profileId ?? null;

      // Tools-bridge binding: derive the launch config from the same merged settings
      // that used to build the prompt, so the tools the extension registers always
      // match the guidance it appends. The extension delivers the Happier base prompt
      // blocks (session title, response options, attachments, linked workspace, memory
      // recall) and the bridge tool guidance itself. Prompt/tool policy travels in a
      // protected session manifest selected by the `happy-tools-config` flag. When
      // `PI_CODING_AGENT_DIR` is not set (daemon regular-process spawns do not carry
      // it), fall back to pi's native default agent dir (`~/.pi/agent`, resolved from
      // HOME) — the same root the connected-services materializer uses — so every
      // Happier-spawned Pi session gets the bridge, not just connected-service
      // launches.
      let happyToolsBridge: PiBackendOptions['happyToolsBridge'];
      try {
        const accountSettings =
          params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
            ? params.accountSettings
            : {};
        const mergedSettings = resolveSessionCodingPromptSettings({
          settings: accountSettings,
          profileId: sessionProfileId,
        });
        const explicitAgentDir = typeof process.env.PI_CODING_AGENT_DIR === 'string'
          ? process.env.PI_CODING_AGENT_DIR.trim() || null
          : null;
        const agentDir = explicitAgentDir
          ?? join((typeof process.env.HOME === 'string' && process.env.HOME.trim()) || homedir(), '.pi', 'agent');
        const resolved = await resolveHappyToolsBridgeBackendOptions({
          agentDir,
          sessionId: session.sessionId,
          settings: mergedSettings,
          memoryRecallGuidanceEnabled,
          memoryMachineId: params.machineId,
        });
        if (resolved) {
          happyToolsBridge = resolved;
        }
      } catch (error) {
        // Best-effort: spawn without the bridge args; the full coding system prompt
        // (including the shell-bridge CLI appendix) rides the spawn flag below as the
        // fallback tool delivery path for this session.
        logger.debug('[pi] tools-bridge extension resolution failed; spawning without bridge args', error);
      }

      // Prompt preparation is load-bearing, not best-effort. With the bridge, residual
      // profile/provider/run blocks are appended to the host-resolved base inside the
      // protected bridge config so Pi sees one canonically ordered addition. Without
      // the bridge, the complete prompt rides --append-system-prompt instead.
      const text = await resolveEffectiveCodingPromptText({
        credentials: params.credentials,
        settings: params.accountSettings ?? null,
        profileId: sessionProfileId,
        providerId: 'pi',
        executionRunsFeatureEnabled: resolveCliFeatureDecision({
          featureId: 'execution.runs',
          env: process.env,
        }).state === 'enabled',
        ...(happyToolsBridge
          ? {
            // The bridge resolver already produced the Happier base/tool guidance.
            // Resolve only the remaining profile/provider/run blocks here, then join
            // them after that base in the protected bridge configuration below.
            baseOverride: null,
            memoryRecallGuidanceEnabled: false,
          }
          : {
            memoryRecallGuidanceEnabled,
            memoryMachineId: params.machineId,
            toolDelivery: params.fallbackToolDelivery,
            toolDeliverySessionId: session.sessionId,
            toolDeliveryDirectory: params.directory,
          }),
      });
      const resolvedPromptText = typeof text === 'string' && text.trim() ? text : undefined;

      if (happyToolsBridge) {
        const promptFragments = [happyToolsBridge.sessionConfig.promptAddition, resolvedPromptText]
          .filter((fragment): fragment is string => typeof fragment === 'string' && fragment.trim().length > 0);
        happyToolsBridge = {
          ...happyToolsBridge,
          sessionConfig: {
            ...happyToolsBridge.sessionConfig,
            // Pi applies --append-system-prompt before extension hooks. Keeping the
            // entire Happier addition here preserves the canonical order: base/tool
            // guidance first, then profile stacks and provider/run supplements.
            promptAddition: promptFragments.join('\n\n'),
          },
        };
        return { happyToolsBridge };
      }

      return resolvedPromptText ? { appendSystemPromptText: resolvedPromptText } : {};
     },
   });
 }
