import { createCatalogAcpBackend } from '@/agent/acp';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { AcpBoundSessionIdentity } from '@/agent/acp/runtime/sessionIdentityBinding';
import type { McpServerConfig } from '@/agent';
import type { AgentBackend } from '@/agent/core';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import {
  sendPermissionRequestPushNotificationForActiveAccount,
  type PermissionRequestPushSender,
} from '@/settings/notifications/permissionRequestPush';
import { createAgentSessionMediaPersister } from '@/session/sessionMedia/createAgentSessionMediaPersister';
import { createSessionMediaAccessPolicy } from '@/session/sessionMedia/createSessionMediaAccessPolicy';
import { AGENTS_CORE, getProviderCliRuntimeSpec, isAgentMediaCapabilitySupported } from '@happier-dev/agents';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import { createVendorResumeIdMetadataPublisher } from '@/session/metadata/createVendorResumeIdMetadataPublisher';

export type CatalogProviderSessionIdentityPublication =
  | Readonly<{ kind: 'manifest-metadata' }>
  | Readonly<{ kind: 'custom'; persistBound: (event: AcpBoundSessionIdentity) => Promise<void> }>
  | Readonly<{ kind: 'external-owner' }>
  | Readonly<{ kind: 'runtime-only'; reason: 'vendor-resume-unsupported' }>;

/** Backend options a pre-spawn resolver may contribute — everything except the host-owned fields. */
export type CatalogBackendOptionsBeforeSpawn<TBackendOptions extends object> =
  Partial<Omit<TBackendOptions, 'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode' | 'happierSessionId'>>;

type CatalogAcpProviderRuntimeParams<TBackendOptions extends object> = {
  provider: Parameters<typeof createCatalogAcpBackend>[0];
  loggerLabel: string;
  directory: string;
  session: ApiSessionClient;
  pushSender?: PermissionRequestPushSender;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  processEnv?: NodeJS.ProcessEnv;
  getSessionOpenAbortSignal?: () => AbortSignal | undefined;
  backendOptions?: Omit<TBackendOptions, 'cwd' | 'mcpServers' | 'permissionHandler' | 'permissionMode' | 'happierSessionId'>;
  /**
   * Additional backend options resolved inside `ensureBackend`, immediately before the
   * backend process is constructed and spawned — for options (e.g. a resolved system
   * prompt) that depend on the live session and cannot be computed synchronously at
   * runtime-construction time.
   *
   * The returned shape is the same host-excluded subset as {@link backendOptions}:
   * `cwd`, `mcpServers`, `permissionHandler`, `permissionMode`, and `happierSessionId`
   * are owned by the runtime and cannot be overridden here (the merge applies them last
   * as defense in depth). Rejection propagates and prevents the spawn.
   */
  resolveBackendOptionsBeforeSpawn?: (ctx: { session: ApiSessionClient }) => Promise<CatalogBackendOptionsBeforeSpawn<TBackendOptions>>;
  getPermissionMode?: () => PermissionMode | null | undefined;
  resolvePermissionMode?: (args: {
    getPermissionMode?: () => PermissionMode | null | undefined;
    session: ApiSessionClient;
  }) => PermissionMode | null | undefined;
  sessionIdentity: CatalogProviderSessionIdentityPublication;
  resolveExpectedVendorSessionIdForResume?: Parameters<typeof createAcpRuntime>[0]['resolveExpectedVendorSessionIdForResume'];
  inFlightSteer?: Parameters<typeof createAcpRuntime>[0]['inFlightSteer'];
  hooks?: Parameters<typeof createAcpRuntime>[0]['hooks'];
  memoryRecallGuidance?: Parameters<typeof createAcpRuntime>[0]['memoryRecallGuidance'];
  resolveSessionModelConfigUpdate?: Parameters<typeof createAcpRuntime>[0]['resolveSessionModelConfigUpdate'];
  deriveSessionModelsFromConfigOptions?: Parameters<typeof createAcpRuntime>[0]['deriveSessionModelsFromConfigOptions'];
  resolveSessionConfigOptionUpdate?: Parameters<typeof createAcpRuntime>[0]['resolveSessionConfigOptionUpdate'];
  sessionMediaProviderRoots?: readonly (string | null | undefined)[];
  startupOverrides?: Parameters<typeof createAcpRuntime>[0]['startupOverrides'];
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
};

export function createCatalogProviderAcpRuntime<TBackendOptions extends object = Record<string, never>>(
  params: CatalogAcpProviderRuntimeParams<TBackendOptions>,
) {
  const sendPermissionPush = (evt: { permissionId: string; toolName: string }): void => {
    if (!params.pushSender) return;
    try {
      sendPermissionRequestPushNotificationForActiveAccount({
        pushSender: params.pushSender,
        sessionId: params.session.sessionId,
        sessionTitle: getSessionNotificationTitle(params.session.getMetadataSnapshot?.bind(params.session)) ?? params.session.sessionId,
        agentDisplayName: getProviderCliRuntimeSpec(params.provider).title,
        permissionId: evt.permissionId,
        toolName: evt.toolName,
        permissionMode: params.getPermissionMode?.(),
      });
    } catch {
      // best-effort
    }
  };
  const hooks = params.hooks
    ? {
        ...params.hooks,
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          try {
            params.hooks?.onPermissionRequest?.(evt);
          } catch {
            // ignore
          }
          sendPermissionPush(evt);
        },
      }
    : {
        onPermissionRequest: (evt: { permissionId: string; toolName: string; payload: unknown; reason: string }) => {
          sendPermissionPush(evt);
        },
      };
  const shouldPersistSessionMedia =
    process.env.HAPPIER_TRANSCRIPT_STORAGE !== 'direct' &&
    isAgentMediaCapabilitySupported(params.provider, 'emitsSessionMedia');
  const sessionIdentity = (() => {
    if (params.sessionIdentity.kind === 'manifest-metadata') {
      const publisher = createVendorResumeIdMetadataPublisher({
        agentId: params.provider,
        getMetadataSnapshot: () => params.session.getMetadataSnapshot(),
        updateMetadata: (updater) => params.session.updateMetadata(updater),
      });
      return { kind: 'persist-bound' as const, persistBound: publisher.persistBound };
    }
    if (params.sessionIdentity.kind === 'custom') {
      return { kind: 'persist-bound' as const, persistBound: params.sessionIdentity.persistBound };
    }
    if (params.sessionIdentity.kind === 'runtime-only'
      && AGENTS_CORE[params.provider].resume.vendorResume !== 'unsupported') {
      throw new Error(`Agent ${params.provider} advertises vendor resume and cannot use runtime-only session identity`);
    }
    return params.sessionIdentity;
  })();

  return createAcpRuntime({
    provider: params.provider,
    directory: params.directory,
    happierSessionId: params.session.sessionId,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    onThinkingChange: params.onThinkingChange,
    getSessionOpenAbortSignal: params.getSessionOpenAbortSignal,
    sessionIdentity,
    resolveExpectedVendorSessionIdForResume: params.resolveExpectedVendorSessionIdForResume,
    hooks,
    inFlightSteer: params.inFlightSteer,
    memoryRecallGuidance: params.memoryRecallGuidance,
    resolveSessionModelConfigUpdate: params.resolveSessionModelConfigUpdate,
    deriveSessionModelsFromConfigOptions: params.deriveSessionModelsFromConfigOptions,
    resolveSessionConfigOptionUpdate: params.resolveSessionConfigOptionUpdate,
    startupOverrides: params.startupOverrides,
    pendingQueue: {
      drainAfterStartOrLoad: true,
      // Exact pending actions such as send-now/interrupt must be claimable while a
      // turn is in flight even when this catalog provider cannot steer.
      drainDuringTurn: true,
      maxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
      inputConsumer: params.providerInputConsumer,
    },
    ...(shouldPersistSessionMedia
      ? {
          sessionMedia: createAgentSessionMediaPersister({
            workingDirectory: params.directory,
            sessionId: params.session.sessionId,
            accessPolicy: createSessionMediaAccessPolicy({
              workingDirectory: params.directory,
              providerMediaRoots: params.sessionMediaProviderRoots,
            }),
          }),
        }
      : {}),
    ensureBackend: async () => {
      const permissionModeRaw = params.resolvePermissionMode
        ? params.resolvePermissionMode({
            getPermissionMode: params.getPermissionMode,
            session: params.session,
          })
        : params.getPermissionMode?.();
      const permissionMode = typeof permissionModeRaw === 'string' ? permissionModeRaw : undefined;

      const resolvedBackendOptions = params.resolveBackendOptionsBeforeSpawn
        ? await params.resolveBackendOptionsBeforeSpawn({ session: params.session })
        : {};

      const created = await createCatalogAcpBackend<TBackendOptions>(params.provider, {
        ...(params.backendOptions ?? {}),
        ...(resolvedBackendOptions ?? {}),
        // Host-owned fields apply last and cannot be overridden by either options source.
        cwd: params.directory,
        mcpServers: params.mcpServers,
        permissionHandler: params.permissionHandler,
        permissionMode,
        happierSessionId: params.session.sessionId,
        ...(params.processEnv ? { env: params.processEnv } : {}),
      } as unknown as TBackendOptions);

      logger.debug(`[${params.loggerLabel}] Backend created`);
      return created.backend as unknown as AgentBackend;
    },
  });
}
