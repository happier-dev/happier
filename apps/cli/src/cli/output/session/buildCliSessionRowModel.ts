import { inferAgentIdFromSessionMetadata, evaluateVendorResumeEligibility, type VendorResumeEligibility } from '@happier-dev/agents';
import {
  buildBackendTargetKey,
  readAcpConfiguredBackendV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
  readSystemSessionMetadataFromMetadata,
  type AccountSettings,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type CliSessionRowModel = Readonly<{
  id: string;
  agentId: ReturnType<typeof inferAgentIdFromSessionMetadata>;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  activeAt: number;
  archivedAt: number | null;
  tag: string | null;
  title: string | null;
  path: string | null;
  isSystem: boolean;
  systemPurpose: string | null;
  vendorResume: VendorResumeEligibility;
  encryptionMode: 'plain' | 'e2ee';
}>;

type ResumeContributionRegistry = Pick<ResolvedContributionRegistry, 'providerDefinitionsById' | 'backendDefinitionsById'>;

function readOptionalNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const raw = record[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readConfiguredAcpBackendIdFromFlavor(metadata: Record<string, unknown>): string | null {
  const flavor = readOptionalNonEmptyString(metadata, 'flavor');
  if (!flavor || !flavor.startsWith('acp:')) return null;
  const backendId = flavor.slice(4).trim();
  return backendId || null;
}

function resolveConfiguredAcpBackendId(metadata: Record<string, unknown>): string | null {
  return readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId
    ?? readConfiguredAcpBackendIdFromFlavor(metadata);
}

function normalizeVendorResumeSupportLevel(value: unknown): 'supported' | 'experimental' | 'unsupported' {
  return value === 'supported' || value === 'experimental' || value === 'unsupported'
    ? value
    : 'unsupported';
}

function readPluginProviderResumeConfig(providerDefinition: unknown): Readonly<{
  supportLevel: 'supported' | 'experimental' | 'unsupported';
  vendorResumeIdField: string | null;
}> {
  const providerRecord = asRecord(providerDefinition);
  const sessionRecord = asRecord(providerRecord?.session);
  const resumeRecord = asRecord(sessionRecord?.resume);
  return {
    supportLevel: normalizeVendorResumeSupportLevel(resumeRecord?.supportLevel),
    vendorResumeIdField: resumeRecord ? readOptionalNonEmptyString(resumeRecord, 'vendorResumeIdField') : null,
  };
}

function isConfiguredBackendDisabledByAccountSettings(params: Readonly<{
  configuredBackendId: string | null;
  accountSettings: Record<string, unknown> | null;
}>): boolean {
  if (!params.configuredBackendId) return false;
  const backendEnabledByTargetKey = asRecord(params.accountSettings?.backendEnabledByTargetKey);
  if (!backendEnabledByTargetKey) return false;
  return backendEnabledByTargetKey[buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: params.configuredBackendId })] === false;
}

function evaluatePluginVendorResumeEligibility(params: Readonly<{
  metadata: Record<string, unknown> | null;
  accountSettings: Record<string, unknown> | null;
  contributionRegistry: ResumeContributionRegistry | null;
}>): VendorResumeEligibility | null {
  const metadata = params.metadata;
  const contributionRegistry = params.contributionRegistry;
  if (!metadata || !contributionRegistry) return null;

  const configuredBackendId = resolveConfiguredAcpBackendId(metadata);
  const providerIdFromConfiguredBackend = configuredBackendId
    ? contributionRegistry.backendDefinitionsById.get(configuredBackendId)?.providerId ?? null
    : null;
  const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const providerIdFromRuntimeDescriptor = typeof runtimeDescriptor?.providerId === 'string'
    ? runtimeDescriptor.providerId.trim() || null
    : null;
  const providerId = providerIdFromConfiguredBackend ?? providerIdFromRuntimeDescriptor;
  if (!providerId) return null;

  const providerContribution = contributionRegistry.providerDefinitionsById.get(providerId);
  if (!providerContribution || providerContribution.provenance !== 'external') return null;

  if (isConfiguredBackendDisabledByAccountSettings({ configuredBackendId, accountSettings: params.accountSettings })) {
    return { eligible: false, reasonCode: 'backend_disabled_by_account_settings' };
  }

  // Plugin providers have a minimal contract definition plus an optional rich definition
  // that preserves additional (still internal) plugin-specific fields such as session.resume.
  const pluginResumeDefinition = providerContribution.richDefinition?.provenance === 'external'
    ? providerContribution.richDefinition.definition
    : providerContribution.definition;
  const resumeConfig = readPluginProviderResumeConfig(pluginResumeDefinition);
  const supportLevel = resumeConfig.supportLevel !== 'unsupported'
    ? resumeConfig.supportLevel
    : normalizeVendorResumeSupportLevel(providerContribution.catalogEntry?.vendorResumeSupport);
  if (supportLevel === 'unsupported') {
    return { eligible: false, reasonCode: 'agent_unsupported' };
  }
  if (supportLevel === 'experimental') {
    return { eligible: false, reasonCode: 'experimental_disabled' };
  }

  const runtimeProviderRecord = asRecord(runtimeDescriptor?.provider);
  const runtimeDescriptorVendorResumeId = runtimeDescriptor?.providerId === providerId && runtimeProviderRecord
    ? readOptionalNonEmptyString(runtimeProviderRecord, 'providerSessionId')
    : null;
  const metadataVendorResumeId = resumeConfig.vendorResumeIdField
    ? readOptionalNonEmptyString(metadata, resumeConfig.vendorResumeIdField)
    : null;
  const vendorResumeId = runtimeDescriptorVendorResumeId ?? metadataVendorResumeId;
  if (!vendorResumeId) {
    return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
  }

  return { eligible: true, vendorResumeId };
}

function readTitleFromMetadata(metadata: Record<string, unknown>): string | null {
  const summary = metadata.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const summaryRecord = summary as Record<string, unknown>;
  const text = summaryRecord.text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveArchivedAtValue(raw: RawSessionListRow | RawSessionRecord): number | null {
  const archivedAt = raw.archivedAt;
  if (archivedAt === null) return null;
  if (typeof archivedAt !== 'number' || !Number.isFinite(archivedAt) || archivedAt < 0) return null;
  return archivedAt;
}

export function buildCliSessionRowModel(params: Readonly<{
  credentials: Credentials;
  rawSession: RawSessionListRow | RawSessionRecord;
  accountSettings?: AccountSettings | null;
  contributionRegistry?: ResumeContributionRegistry | null;
}>): CliSessionRowModel {
  const raw = params.rawSession;
  const id = raw.id.trim();
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;
  const active = raw.active;
  const activeAt = raw.activeAt;
  const archivedAt = resolveArchivedAtValue(raw);

  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession });
  const metaRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const agentId = inferAgentIdFromSessionMetadata(metaRecord);

  const tag = metaRecord ? readOptionalNonEmptyString(metaRecord, 'tag') : null;
  const title = metaRecord ? readTitleFromMetadata(metaRecord) : null;
  const path = metaRecord ? readOptionalNonEmptyString(metaRecord, 'path') : null;

  const system = metaRecord ? readSystemSessionMetadataFromMetadata({ metadata: metaRecord }) : null;
  const isSystem = system !== null;
  const systemPurpose = system?.key ?? null;

  const accountSettingsRecord = asRecord(params.accountSettings) ?? null;
  const pluginVendorResume = evaluatePluginVendorResumeEligibility({
    metadata: metaRecord,
    accountSettings: accountSettingsRecord,
    contributionRegistry: params.contributionRegistry ?? null,
  });
  const vendorResume = pluginVendorResume ?? evaluateVendorResumeEligibility({
    agentId,
    metadata: metaRecord,
    accountSettings: accountSettingsRecord,
  });

  const encryptionMode: 'plain' | 'e2ee' = raw.encryptionMode === 'plain' ? 'plain' : 'e2ee';

  return {
    id,
    agentId,
    createdAt,
    updatedAt,
    active,
    activeAt,
    archivedAt,
    tag,
    title,
    path,
    isSystem,
    systemPurpose,
    vendorResume,
    encryptionMode,
  };
}
