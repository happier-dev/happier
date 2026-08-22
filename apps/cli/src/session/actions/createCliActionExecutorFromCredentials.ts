import { importHistoricalSessionTranscript } from '@/session/transport/http/sessionsHttp';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ResolveAutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventActionExecutor';
import type {
  RevalidatePluginActionCallerImmutableGeneration,
  RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';

import { createCliActionExecutor } from './createCliActionExecutor';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: StoredCredentials;
  readCredentials?: () => Promise<StoredCredentials | null>;
  readRegisteredPromptAssetAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerImmutableGeneration?: RevalidatePluginActionCallerImmutableGeneration;
  runtimeActionExecute?: RuntimeActionExecute;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  machineAdmissionTransport?: NonNullable<
    Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
  >;
  sessionLogAccess?: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
  }>;
}>): ReturnType<typeof createCliActionExecutor> & Readonly<{
  bindInvocation(signal: AbortSignal): ReturnType<typeof createCliActionExecutor>;
}> {
  const createFollowLeaseRegistry = () => createSessionTranscriptFollowLeaseRegistry({
    maxLeases: 16,
    idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  });
  const createExecutor = (
    credentials: StoredCredentials,
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
  ): ReturnType<typeof createCliActionExecutor> => {
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
    const cryptoContext = ctx
      ? { mode: 'e2ee' as const, ctx }
      : { mode: 'plain' as const, ctx: null };

    return createCliActionExecutor({
      ...cryptoContext,
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      ...(params.readRegisteredPromptAssetAdapters
        ? { readRegisteredPromptAssetAdapters: params.readRegisteredPromptAssetAdapters }
        : {}),
      ...(params.resolveAutomationEventAdoptedDefinitionSet
        ? { resolveAutomationEventAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet }
        : {}),
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidatePluginActionCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerImmutableGeneration
        ? { revalidatePluginActionCallerImmutableGeneration: params.revalidatePluginActionCallerImmutableGeneration }
        : {}),
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      ...(params.externalSessionPluginAdmissionOwner
        ? {
            externalSessionPluginAdmissionOwner:
              params.externalSessionPluginAdmissionOwner,
          }
        : {}),
      ...(params.machineAdmissionTransport
        ? { machineAdmissionTransport: params.machineAdmissionTransport }
        : {}),
      resolveTranscriptStore: async (sessionId) => {
        const transport = await resolveSessionTransportContext({
          credentials,
          idOrPrefix: sessionId,
        });
        if (!transport.ok) {
          throw Object.assign(new Error(transport.code), { code: transport.code });
        }
        return createServerBackedSessionTranscriptStore({
          token: credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
        });
      },
      transcriptFollowLeaseRegistry,
      writeTranscriptItems: async (sessionId: string, items: readonly SessionTranscriptActionItem[]) =>
        await importHistoricalSessionTranscript({
          token: credentials.token,
          sessionId,
          items,
        }),
      ...(params.sessionLogAccess ? { sessionLogAccess: params.sessionLogAccess } : {}),
    });
  };

  const createCredentialRefreshingExecutor = (
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
  ): ReturnType<typeof createCliActionExecutor> => {
    const fixedExecutor = params.readCredentials
      ? null
      : createExecutor(params.credentials, transcriptFollowLeaseRegistry);
    return {
      execute: async (...args) => {
        const credentials = params.readCredentials
          ? await params.readCredentials().catch(() => null)
          : params.credentials;
        if (!credentials) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        await ensureCliActionPolicySettings(credentials);
        return await executor.execute(...args);
      },
    };
  };

  const executor = createCredentialRefreshingExecutor(createFollowLeaseRegistry());
  return Object.freeze({
    ...executor,
    bindInvocation(signal: AbortSignal) {
      const transcriptFollowLeaseRegistry = createFollowLeaseRegistry();
      const dispose = (): void => {
        void transcriptFollowLeaseRegistry.dispose().catch(() => undefined);
      };
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
      return createCredentialRefreshingExecutor(transcriptFollowLeaseRegistry);
    },
  });
}
