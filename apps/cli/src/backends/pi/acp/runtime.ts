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
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
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
  /** Register the full session-agent tool surface in the pi bridge (off by default). */
  sessionToolsEnabled?: boolean;
  /** Daemon-resolved action ids disabled for the `session_agent` surface. */
  disabledSessionAgentActionIds?: readonly string[];
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
      // recall) and the bridge tool guidance itself, driven by `--happy-*` flags. When
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
          // Full session-agent tool surface: opt-in per spawn while the surface rolls out.
          sessionToolsEnabled: params.sessionToolsEnabled === true,
          disabledActionIds: params.disabledSessionAgentActionIds,
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

      // Prompt preparation is load-bearing, not best-effort: a session whose Happier
      // prompt addition (or, in the no-bridge fallback, its whole tool-delivery appendix)
      // cannot be composed must not silently spawn without it. Rejection propagates
      // through ensureBackend and fails the session start.
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
            // The bridge extension delivers the Happier base blocks (session title,
            // response options, attachments, linked workspace) and the memory-recall
            // guidance from its launch flags; the daemon must not duplicate them in
            // the append content. Only residual user content (prompt stacks,
            // execution-runs guidance) is composed here — with none configured the
            // append content is omitted entirely (the backend then drops the flag).
            baseOverride: null,
            memoryRecallGuidanceEnabled: false,
          }
          : {
            memoryRecallGuidanceEnabled,
            memoryMachineId: params.machineId,
            toolDelivery: resolveAgentToolsDelivery('pi'),
            toolDeliverySessionId: session.sessionId,
            toolDeliveryDirectory: params.directory,
          }),
      });
      const appendSystemPromptText = typeof text === 'string' ? text.trim() || undefined : undefined;

       return {
         ...(appendSystemPromptText ? { appendSystemPromptText } : {}),
         ...(happyToolsBridge ? { happyToolsBridge } : {}),
       };
     },
   });
 }
