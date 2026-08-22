import {
  resolveAgentIdFromSessionMetadata,
  evaluateVendorResumeEligibility,
  isLinkedVendorResumeIdentityCurrent,
  resolveVendorResumeIdFromSessionMetadata,
  type VendorResumeEligibility,
} from '@happier-dev/agents';
import {
  buildBackendTargetKey,
  readAcpConfiguredBackendV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
  readSystemSessionMetadataFromMetadata,
  type AccountSettings,
  type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveEngineRuntimeContribution } from '@/agent/runtime/registry/engineRegistry/contributions';

/**
 * What the CLI shows for a Session whose metadata declares no Agent. An
 * unreadable identity is displayed as unknown rather than as the default Agent,
 * which would be indistinguishable from a Session that really runs it.
 */
export const UNKNOWN_CLI_SESSION_AGENT_LABEL = 'unknown';

export type CliSessionRowModel = Readonly<{
  id: string;
  agentId: ReturnType<typeof resolveAgentIdFromSessionMetadata>;
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

type ResumeContributionRegistry = Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>;

function resolveLinkedSessionCurrentAgent(
  agentId: string | null,
  contributionRegistry: ResumeContributionRegistry | null,
) {
  const contribution = agentId ? contributionRegistry?.agentDefinitionsById.get(agentId) : null;
  const identity = contribution?.identity;
  const sources = contribution?.richDefinition?.definition.surfaces?.externalSession?.sources;
  if (!identity || !sources || sources.length === 0) return null;
  return {
    identity,
    sourceKinds: sources.map((source) => source.sourceKind),
  };
}

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
    ? resolveEngineRuntimeContribution(contributionRegistry, configuredBackendId)?.agentId ?? null
    : null;
  const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(metadata);
  const providerIdFromRuntimeDescriptor = typeof runtimeDescriptor?.agentId === 'string'
    ? runtimeDescriptor.agentId.trim() || null
    : null;
  const providerId = providerIdFromConfiguredBackend ?? providerIdFromRuntimeDescriptor;
  if (!providerId) return null;

  const providerContribution = contributionRegistry.agentDefinitionsById.get(providerId);
  if (!providerContribution || providerContribution.provenance !== 'external') return null;

  if (isConfiguredBackendDisabledByAccountSettings({ configuredBackendId, accountSettings: params.accountSettings })) {
    return { eligible: false, reasonCode: 'backend_disabled_by_account_settings' };
  }

  // A contributed Agent declares its native-resume support through the one
  // catalog-entry projection (`catalog.vendorResume`, else inferred from
  // `capabilities.sessions.open`). It has no second, definition-local resume
  // block: `PluginAgentContributionV2` is strict and declares no `session` key.
  const supportLevel = normalizeVendorResumeSupportLevel(
    providerContribution.catalogEntry?.vendorResumeSupport,
  );
  if (supportLevel === 'unsupported') {
    return { eligible: false, reasonCode: 'agent_unsupported' };
  }
  if (supportLevel === 'experimental') {
    return { eligible: false, reasonCode: 'experimental_disabled' };
  }

  // ONE owner decides what a Session's native resume id is, for a contributed
  // Agent exactly as for a bundled one. This row model used to re-derive it
  // from the runtime descriptor itself, which is how the CLI listing and the
  // daemon's spawn path came to disagree about whether a Session was resumable.
  const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(providerId, metadata);
  if (!vendorResumeId) {
    return { eligible: false, reasonCode: 'vendor_resume_id_missing' };
  }
  if (!isLinkedVendorResumeIdentityCurrent({
    agentId: providerId,
    metadata,
    // No catalog-declared flat slot exists for a contributed Agent; the shared
    // owner reads the agent-agnostic runtime-descriptor slot instead.
    vendorResumeIdField: null,
    linkedSessionCurrentAgent: resolveLinkedSessionCurrentAgent(providerId, contributionRegistry),
  })) {
    return { eligible: false, reasonCode: 'linked_session_identity_unverified' };
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
  credentials: StoredCredentials;
  rawSession: RawSessionListRow | RawSessionRecord;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
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

  const metadata = tryDecryptSessionPresentationMetadataView({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionMode,
    rawSession: params.rawSession,
  });
  const metaRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const agentPresentation = asRecord(metaRecord?.agentPresentation);
  const agentId = (agentPresentation
    ? readOptionalNonEmptyString(agentPresentation, 'agentId')
    : null) ?? resolveAgentIdFromSessionMetadata(metaRecord);

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
  const vendorResumeInput = {
    agentId,
    metadata: metaRecord,
    accountSettings: accountSettingsRecord,
    linkedSessionCurrentAgent: resolveLinkedSessionCurrentAgent(
      agentId,
      params.contributionRegistry ?? null,
    ),
  };
  const builtInVendorResume: VendorResumeEligibility = agentId
    ? evaluateVendorResumeEligibility({ ...vendorResumeInput, agentId })
    : { eligible: false, reasonCode: 'agent_unsupported' };
  const vendorResume = pluginVendorResume ?? builtInVendorResume;

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
