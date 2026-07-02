import type { CatalogAgentId } from '@/backends/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import type { Credentials } from '@/persistence';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { configuration } from '@/configuration';
import type { AccountSettings, BackendTargetRefV1, BackendTargetRefV2 } from '@happier-dev/protocol';
import {
  readAcpConfiguredBackendV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';
import { inferAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
  resolveConfiguredAcpBackendFromAccountSettingsOrPlugins,
  type ResolvedConfiguredAcpBackend,
} from '@/agent/acp/catalog/configured/resolveBackend';
import { resolveConcreteCompatBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
  isConcreteLegacyConfiguredBackendId,
  isLegacyConfiguredBackendVendorSessionCarrier,
} from '@/session/backendTargets/compat/legacyConfiguredBackend';

function isCatalogAgentId(value: string): value is CatalogAgentId {
  return (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readConfiguredAcpBackendIdFromFlavor(metadata: Record<string, unknown>): string | null {
  const raw = typeof metadata.flavor === 'string' ? metadata.flavor.trim() : '';
  if (!raw.startsWith('acp:')) return null;
  const backendId = raw.slice(4).trim();
  return backendId || null;
}

function readConfiguredAcpProviderSessionId(metadata: Record<string, unknown>, backendId: string): string | null {
  const descriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const providerId = typeof descriptor?.providerId === 'string' ? descriptor.providerId.trim() : '';
  if (!isLegacyConfiguredBackendVendorSessionCarrier({ providerId, backendId })) {
    return null;
  }
  const provider = asRecord(descriptor?.provider);
  const providerSessionId = typeof provider?.providerSessionId === 'string' ? provider.providerSessionId.trim() : '';
  return providerSessionId || null;
}

function buildConfiguredAcpMetadataOverlay(params: Readonly<{
  backendId: string;
  title: string;
}>): ReturnType<typeof buildConfiguredAcpBackendSessionMetadata> {
  return buildConfiguredAcpBackendSessionMetadata(params);
}

export type SessionForkBackendTargetResolution =
  | Readonly<{
      ok: true;
      providerAgentId: CatalogAgentId;
      providerHintProviderId: string;
      backendTargetV2: BackendTargetRefV2;
      backendTarget: BackendTargetRefV1;
      replayFlavor: string;
      metadataOverlay: Readonly<Record<string, unknown>>;
      configuredAcp: null;
    }>
  | Readonly<{
      ok: true;
      providerAgentId: null;
      providerHintProviderId: string;
      backendTargetV2: BackendTargetRefV2;
      backendTarget: Readonly<{ kind: 'configuredAcpBackend'; backendId: string }>;
      replayFlavor: string;
      metadataOverlay: Readonly<Record<string, unknown>>;
      configuredAcp: Readonly<{
        backendId: string;
        title: string;
        providerSessionId: string | null;
        resolvedBackend: ResolvedConfiguredAcpBackend | null;
        accountSettings: AccountSettings | null;
      }>;
    }>
  | Readonly<{
      ok: false;
      errorMessage: string;
    }>;

export async function resolveSessionForkBackendTarget(params: Readonly<{
  parentMetadata: Record<string, unknown>;
  credentials: Credentials;
}>): Promise<SessionForkBackendTargetResolution> {
  const metadataConfiguredBackend = readAcpConfiguredBackendV1FromMetadata(params.parentMetadata);
  const flavorConfiguredBackendId = readConfiguredAcpBackendIdFromFlavor(params.parentMetadata);
  const candidateConfiguredBackendId = metadataConfiguredBackend?.backendId ?? flavorConfiguredBackendId ?? null;

  if (candidateConfiguredBackendId) {
    if (!isConcreteLegacyConfiguredBackendId(candidateConfiguredBackendId)) {
      return {
        ok: false,
        errorMessage: 'Session metadata missing configured backend flavor',
      };
    }
    const accountSettings = await resolveAvailableAccountSettings({ credentials: params.credentials });
    const resolvedConfiguredBackend = await resolveConfiguredAcpBackendFromAccountSettingsOrPlugins({
      settings: accountSettings ?? {},
      backendId: candidateConfiguredBackendId,
      happyHomeDir: configuration.happyHomeDir,
    });

    if (metadataConfiguredBackend || resolvedConfiguredBackend) {
      const title = metadataConfiguredBackend?.title ?? resolvedConfiguredBackend?.title ?? candidateConfiguredBackendId;
      const backendTarget = { kind: 'configuredAcpBackend', backendId: candidateConfiguredBackendId } as const;
      const backendTargetRefs = resolveConcreteCompatBackendTargetRefs(backendTarget);
      if (!backendTargetRefs) {
        return {
          ok: false,
          errorMessage: 'Session metadata missing configured backend flavor',
        };
      }
      return {
        ok: true,
        providerAgentId: null,
        providerHintProviderId: `acp:${candidateConfiguredBackendId}`,
        backendTargetV2: backendTargetRefs.backendTargetV2,
        backendTarget,
        replayFlavor: `acp:${candidateConfiguredBackendId}`,
        metadataOverlay: buildConfiguredAcpMetadataOverlay({
          backendId: candidateConfiguredBackendId,
          title,
        }),
        configuredAcp: {
          backendId: candidateConfiguredBackendId,
          title,
          providerSessionId: readConfiguredAcpProviderSessionId(params.parentMetadata, candidateConfiguredBackendId),
          resolvedBackend: resolvedConfiguredBackend,
          accountSettings,
        },
      };
    }
  }

  const unknownAgentId = '__unknown__' as CatalogAgentId;
  const agentRaw = inferAgentIdFromSessionMetadata(params.parentMetadata, unknownAgentId);
  if (agentRaw === unknownAgentId || !isCatalogAgentId(agentRaw)) {
    return {
      ok: false,
      errorMessage: 'Session metadata missing agent flavor',
    };
  }

  return {
    ok: true,
    providerAgentId: agentRaw,
    providerHintProviderId: agentRaw,
    backendTargetV2: resolveConcreteCompatBackendTargetRefs({ kind: 'builtInAgent', agentId: agentRaw })!.backendTargetV2,
    backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
    replayFlavor: agentRaw,
    metadataOverlay: {},
    configuredAcp: null,
  };
}
