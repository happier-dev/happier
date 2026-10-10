import { applyAccountSettingsSavedSecretMutation, applyAccountSettingsVoiceCredentialSourceMutation, resolveAccountSettingsVoiceCredentialSecret, resolveAccountSettingsVoiceCredentialSource, type AccountSettingsSavedSecretMutation, type AccountSettingsVoiceCredentialSourceMutation, type AccountSettingsVoiceCredentialSourceMutationResult, type VoiceCredentialSourceSelection } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { deriveVoiceCredentialBindingIdentityV1, type VoiceProviderContribution, type VoiceRawCredentialGrantDeclaration, VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { normalizeRecipientContractV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { applySavedSecretCatalogVoiceCredentialSourceMutationV1, resolveSavedSecretCatalogVoiceCredentialSourceV1, listSavedSecretVoiceCredentialMutationReferencesV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { ConnectedPurposeCatalogV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { SavedSecretReferenceCatalogsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { withConnectedAccountCatalogAccount, readConnectedAccountCatalogInContext, writeConnectedAccountCatalogRecordAndPublishInContext, ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import type { OneShotAccountSettingsMutationResult } from '@/sync/engine/settings/syncSettings';
import type { SavedSecretFullReferenceResourceCreationParams, SavedSecretFullReferenceResourceCreationResult, SavedSecretFullReferenceResourceMutationCapture } from '@/sync/ops/settings/savedSecretResourceOperations';

export type RecoverableVoiceCredentialMutationResult<TResult extends object> = TResult & Readonly<{
  verifyOutcome?: () => Promise<RecoverableVoiceCredentialMutationResult<TResult>>;
}>;

function voiceCredentialResourceReceipt<TResult extends object>(
  result: SavedSecretFullReferenceResourceCreationResult,
  applied: (settingsVersion: number) => TResult,
  changed: () => TResult,
  unknown: () => TResult,
): RecoverableVoiceCredentialMutationResult<TResult> {
  if (result.ok) return applied(result.settingsVersion);
  if (result.reason === 'changed') return changed();
  if (result.reason === 'outcome_unknown') return {
    ...unknown(),
    ...(result.verifyOutcome ? { verifyOutcome: async () => voiceCredentialResourceReceipt(
      await result.verifyOutcome!(), applied, changed, unknown,
    ) } : {}),
  };
  throw Object.assign(new Error('voice_credential_resource_unavailable'), { code: 'voice_credential_resource_unavailable' });
}

export type AccountVoiceCredentialSource = 'account' | 'machine_override';
/**
 * `unknown` is not a fourth flavour of absence. Unreadable Account Voice or
 * SavedSecret data and an unavailable qualified-purpose catalog cannot prove
 * that a credential is absent. Reporting those states as
 * `missing` tells the user to add a credential that may already be stored, so
 * the unresolvable case carries its own value.
 */
export type AccountVoiceCredentialUseStatus = 'ready' | 'missing' | 'review_required' | 'unknown';

export type AccountVoiceCredentialStatus = Readonly<{
  status: AccountVoiceCredentialUseStatus;
  reference: Readonly<{
    secretId: string;
    source: AccountVoiceCredentialSource;
  }> | null;
  savedSecret?: SavedSecretReferenceResolution;
}>;

export function resolveAccountVoiceCredentialApprovalDigest(params: Readonly<{
  requiredRecipientContractDigest: string | null | undefined;
  savedSecret: Pick<SavedSecretReferenceResolution, 'kind' | 'fingerprint'> | null | undefined;
}>): string | null {
  const required = params.requiredRecipientContractDigest;
  if (!required) return null;
  if (params.savedSecret?.kind !== 'shared_resource') return required;
  if (!params.savedSecret.fingerprint) return null;
  return `sha256:${bytesToHex(sha256(utf8ToBytes(
    `happier.voice.shared-secret-approval.v1\u0000${required}\u0000${params.savedSecret.fingerprint}`,
  )))}`;
}

export type AccountVoiceCredentialSourceSelectionResolution = ReturnType<
  typeof resolveAccountSettingsVoiceCredentialSource
> & Readonly<{ persisted: boolean }>;

/**
 * An explicit SavedSecret gesture must use the combined source owner unless
 * the current, resolved source is definitely a Connected Account. That is the
 * only state in which editing the dormant SavedSecret slot must not rewrite
 * the selected source or its qualified purpose binding. `null`/`undefined`
 * deliberately mean resolution was unavailable, not that Connected Account
 * is effective; routing those repairable states through the source owner keeps
 * its source, slot, and purpose roots atomic.
 */
export function shouldUseVoiceCredentialSourceMutationForSavedSecret(
  selection: Pick<VoiceCredentialSourceSelection, 'kind'> | null | undefined,
): boolean {
  return selection?.kind !== 'connectedAccount';
}

type AccountVoiceCredentialSourceMutationValue = Readonly<{
  selection: VoiceCredentialSourceSelection;
  binding: ReturnType<typeof applyAccountSettingsVoiceCredentialSourceMutation>['binding'];
}>;

function hasPersistedAccountVoiceCredentialSource(
  settings: Pick<Settings, 'voiceSettingsV1'>,
  contribution: PluginContributionIdentityV1,
  credentialSlotId: string,
): boolean {
  return settings.voiceSettingsV1.credentialBindings.some((binding) => (
    'contribution' in binding
    && binding.contribution.pluginId === contribution.pluginId
    && binding.contribution.localId === contribution.localId
    && binding.credentialSlotId === credentialSlotId
  ));
}

export function resolveAccountVoiceCredentialSourceSelection(params: Readonly<{
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  connectedPurposes: ConnectedPurposeCatalogV1 | null;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  machineId?: string | null;
}>): AccountVoiceCredentialSourceSelectionResolution {
  if (!params.connectedPurposes) throw new Error('connected_purpose_catalog_unavailable');
  const resolution = resolveSavedSecretCatalogVoiceCredentialSourceV1(params.settings, {
    contribution: params.contribution,
    credentialSlotId: params.credentialSlotId,
    purpose: params.purpose,
    machineId: params.machineId ?? null,
  }, { connectedPurposes: params.connectedPurposes });
  return Object.freeze({
    ...resolution,
    persisted: hasPersistedAccountVoiceCredentialSource(
      params.settings,
      params.contribution,
      params.credentialSlotId,
    ),
  });
}

export function applyAccountVoiceCredentialSourceSelection(params: Readonly<{
  settings: Settings;
  connectedPurposes: ConnectedPurposeCatalogV1 | null;
  mutation: AccountSettingsVoiceCredentialSourceMutation;
  catalogs?: SavedSecretReferenceCatalogsV1;
  currentDeclaration: VoiceProviderContribution;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  connectedPurposes: ConnectedPurposeCatalogV1;
  selection: VoiceCredentialSourceSelection;
  binding: ReturnType<typeof applyAccountSettingsVoiceCredentialSourceMutation>['binding'];
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  if (!params.connectedPurposes) throw new Error('connected_purpose_catalog_unavailable');
  const result = applySavedSecretCatalogVoiceCredentialSourceMutationV1(
    accountSettings,
    params.mutation,
    params.currentDeclaration,
    { ...params.catalogs, connectedPurposes: params.connectedPurposes },
  );
  if (!result.connectedPurposes) throw new Error('connected_purpose_catalog_unavailable');
  return Object.freeze({
    accountSettings: { ...result.settings },
    connectedPurposes: result.connectedPurposes,
    settings: settingsParse(result.settings),
    selection: result.selection,
    binding: result.binding,
  });
}

function sameContribution(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Raw grants belong to the exact source the user selected for this credential
 * slot. Keeping that source matching here prevents readiness and disclosure UI
 * from independently treating any declaration alternative as current.
 */
export function resolveSelectedVoiceCredentialRawGrants(params: Readonly<{
  declaration: VoiceProviderContribution;
  contribution: PluginContributionIdentityV1;
  selection: VoiceCredentialSourceSelection;
  /**
   * Optional exact disclosure scope. Realm and phase are always paired; when
   * the caller knows the concrete materialization request it may narrow to
   * that complete tuple as well. This keeps settings, readiness and execution
   * from each rebuilding a slightly different grant filter.
   */
  access?: Readonly<{
    realm: VoiceRawCredentialGrantDeclaration['realm'];
    phase: VoiceRawCredentialGrantDeclaration['phase'];
    request?: VoiceRawCredentialGrantDeclaration['request'];
  }>;
}>): readonly VoiceRawCredentialGrantDeclaration[] {
  if (!params.declaration.credentials || params.selection.kind === 'none') return Object.freeze([]);
  const selectedService = params.selection.kind === 'connectedAccount'
    ? params.selection.target.kind === 'account'
      ? params.selection.target.account.service
      : params.selection.target.service
    : null;
  const grants = params.declaration.credentials.sources.flatMap((source) => {
    if (params.selection.kind === 'savedSecret') {
      return source.kind === 'savedSecret' ? source.rawGrants ?? [] : [];
    }
    if (source.kind !== 'connectedAccount' || selectedService === null) return [];
    const sourceService = qualifyPluginContributionReferenceV1(
      source.service,
      params.contribution.pluginId,
    );
    return sourceService.pluginId === selectedService.pluginId
      && sourceService.localId === selectedService.localId
      ? source.rawGrants ?? []
      : [];
  });
  const access = params.access;
  const scoped = access
    ? grants.filter((grant) => (
        grant.realm === access.realm
        && grant.phase === access.phase
        && (access.request === undefined
          || stableJsonStringify(canonicalVoiceCredentialRequest(grant.request))
            === stableJsonStringify(canonicalVoiceCredentialRequest(access.request)))
      ))
    : grants;
  return Object.freeze(scoped);
}

function sortByCanonicalJson<T>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalVoiceCredentialRequest<T extends Readonly<{
  kind: 'httpHeaders' | 'environment' | 'files';
}>>(request: T): T {
  return (request.kind === 'httpHeaders'
    ? { ...request, headerNames: [...(request as T & Readonly<{ headerNames: readonly string[] }>).headerNames].sort() }
    : request.kind === 'environment'
      ? { ...request, keys: [...(request as T & Readonly<{ keys: readonly string[] }>).keys].sort() }
      : { ...request, fileIds: [...(request as T & Readonly<{ fileIds: readonly string[] }>).fileIds].sort() }) as T;
}

function canonicalVoiceCredentialSource(
  source: NonNullable<VoiceProviderContribution['credentials']>['sources'][number],
  declaringPluginId: string,
): Readonly<Record<string, unknown>> {
  const operationProjections = source.operationProjections?.map((projection) => (
    projection.kind === 'materializedHttpHeaders'
      ? {
          ...projection,
          request: canonicalVoiceCredentialRequest(projection.request),
          requiredHeaderNames: [...projection.requiredHeaderNames].sort(),
          allowedHeaderNames: [...projection.allowedHeaderNames].sort(),
        }
      : projection
  ));
  const rawGrants = source.rawGrants?.map((grant) => ({
    ...grant,
    request: canonicalVoiceCredentialRequest(grant.request),
  }));
  return Object.freeze({
    ...source,
    ...(source.kind === 'connectedAccount'
      ? { service: qualifyPluginContributionReferenceV1(source.service, declaringPluginId) }
      : { secretKinds: [...source.secretKinds].sort() }),
    ...(operationProjections
      ? { operationProjections: sortByCanonicalJson(operationProjections) }
      : {}),
    ...(rawGrants ? { rawGrants: sortByCanonicalJson(rawGrants) } : {}),
  });
}

function canonicalVoiceHostMediatedOperations(
  declaration: VoiceProviderContribution,
): readonly unknown[] | null {
  const credentials = declaration.credentials;
  if (!credentials?.hostMediated) return null;
  return normalizeRecipientContractV1({
    version: 1,
    package: {
      pluginId: 'happier.voice.contract-key',
      source: { kind: 'bundled', locator: 'happier.voice.contract-key' },
    },
    publisher: { trust: 'bundled', identity: 'happier.voice.contract-key' },
    contribution: {
      pluginId: 'happier.voice.contract-key',
      localId: declaration.id,
    },
    credentialSlot: { id: credentials.slot.id, scope: 'account' },
    operations: credentials.hostMediated.operations,
  }).operations;
}

/**
 * Canonical manifest facts consumed by one source gesture. Parsing first makes
 * equivalent rehydrations compare equally while slot, purpose, and selected
 * source contract changes invalidate the gesture.
 */
function voiceCredentialSourceMutationContractKey(
  declaration: VoiceProviderContribution,
  mutation: AccountSettingsVoiceCredentialSourceMutation,
): string | null {
  try {
    const normalized = VoiceProviderContributionSchema.parse(declaration);
    const identity = deriveVoiceCredentialBindingIdentityV1({
      pluginId: mutation.contribution.pluginId,
      contribution: normalized,
    });
    if (!identity
      || !sameContribution(identity.contribution, mutation.contribution)
      || identity.credentialSlotId !== mutation.credentialSlotId) return null;
    const selection = mutation.selection;
    const selectedSource = selection.kind === 'savedSecret'
      ? normalized.credentials?.sources.find((source) => source.kind === 'savedSecret') ?? null
      : selection.kind === 'connectedAccount'
        ? normalized.credentials?.sources.find((source) => {
            if (source.kind !== 'connectedAccount') return false;
            const selectedService = selection.target.kind === 'account'
              ? selection.target.account.service
              : selection.target.service;
            return sameContribution(
              qualifyPluginContributionReferenceV1(source.service, mutation.contribution.pluginId),
              selectedService,
            );
          }) ?? null
        : undefined;
    if (selectedSource === null) return null;
    return JSON.stringify({
      contribution: identity.contribution,
      credentialSlotId: identity.credentialSlotId,
      purpose: identity.purpose,
      hostMediated: canonicalVoiceHostMediatedOperations(normalized),
      ...(selectedSource === undefined
        ? {}
        : {
            source: canonicalVoiceCredentialSource(
              selectedSource,
              mutation.contribution.pluginId,
            ),
          }),
    });
  } catch {
    return null;
  }
}

function staleVoiceCredentialSourceMutation(
  mutation: AccountSettingsVoiceCredentialSourceMutation,
  currentSettingsVersion = mutation.expectedSettingsVersion,
): AccountSettingsVoiceCredentialSourceMutationResult {
  return Object.freeze({
    status: 'conflict',
    currentSettingsVersion,
  });
}

export async function mutateAccountVoiceCredentialSource(params: Readonly<{
  connectedPurposes: ConnectedPurposeCatalogV1 | null;
  catalogs?: SavedSecretReferenceCatalogsV1;
  mutation: AccountSettingsVoiceCredentialSourceMutation;
  expectedDeclaration: VoiceProviderContribution;
  resolveCurrentDeclaration: (
    contribution: PluginContributionIdentityV1,
  ) => VoiceProviderContribution | null;
  mutateAccountSettingsOnce: <T>(input: Readonly<{
    expectedSettingsVersion: number;
    mutate: (
      raw: Readonly<Record<string, unknown>>,
    ) => Readonly<{ settings: Record<string, unknown>; connectedPurposes: ConnectedPurposeCatalogV1; value: T }>;
  }>) => Promise<
    | Readonly<{ status: 'applied'; settingsVersion: number; value: T }>
    | Readonly<{ status: 'conflict'; currentSettingsVersion: number }>
    | Readonly<{
        status: 'outcomeUnknown';
        lastKnownSettingsVersion: number;
        safeSnapshotVersion?: number;
      }>
  >;
}>): Promise<AccountSettingsVoiceCredentialSourceMutationResult> {
  const expectedContractKey = voiceCredentialSourceMutationContractKey(
    params.expectedDeclaration,
    params.mutation,
  );
  if (!expectedContractKey) return staleVoiceCredentialSourceMutation(params.mutation);
  let result:
    | Readonly<{
        status: 'applied';
        settingsVersion: number;
        value: AccountVoiceCredentialSourceMutationValue;
      }>
    | Readonly<{
        status: 'conflict';
        currentSettingsVersion: number;
      }>
    | Readonly<{
        status: 'outcomeUnknown';
        lastKnownSettingsVersion: number;
        safeSnapshotVersion?: number;
      }>;
  try {
    result = await params.mutateAccountSettingsOnce<AccountVoiceCredentialSourceMutationValue>({
      expectedSettingsVersion: params.mutation.expectedSettingsVersion,
      mutate: (raw) => {
        const currentDeclaration = params.resolveCurrentDeclaration(
          params.mutation.contribution,
        );
        if (!currentDeclaration
          || voiceCredentialSourceMutationContractKey(
            currentDeclaration,
            params.mutation,
          ) !== expectedContractKey) {
          throw Object.assign(new Error('voice_credential_source_stale'), {
            code: 'voice_credential_source_stale',
          });
        }
        const applied = applyAccountVoiceCredentialSourceSelection({
          settings: settingsParse(raw),
          connectedPurposes: params.connectedPurposes,
          ...(params.catalogs ? { catalogs: params.catalogs } : {}),
          mutation: params.mutation,
          currentDeclaration,
        });
        return Object.freeze({
          settings: applied.accountSettings,
          connectedPurposes: applied.connectedPurposes,
          value: Object.freeze({
            selection: applied.selection,
            binding: applied.binding,
          }),
        });
      },
    });
  } catch (error) {
    if (error instanceof Error
      && (error as Error & Readonly<{ code?: string }>).code === 'voice_credential_source_stale') {
      return staleVoiceCredentialSourceMutation(params.mutation);
    }
    throw error;
  }
  if (result.status === 'conflict') {
    return Object.freeze({
      status: 'conflict',
      currentSettingsVersion: result.currentSettingsVersion,
    });
  }
  if (result.status === 'outcomeUnknown') {
    return Object.freeze({
      status: 'outcomeUnknown',
      lastKnownSettingsVersion: result.lastKnownSettingsVersion,
      ...(result.safeSnapshotVersion === undefined
        ? {}
        : { safeSnapshotVersion: result.safeSnapshotVersion }),
    });
  }
  return Object.freeze({
    status: 'applied',
    settingsVersion: result.settingsVersion,
    selection: result.value.selection,
    binding: result.value.binding,
  });
}

type VoiceCredentialReplacement = Extract<AccountSettingsSavedSecretMutation, { kind: 'replaceVoiceCredentialSecret' }>;

/** Both new-key gestures share the canonical full reference transaction. */
async function saveScopedAccountVoiceCredentialResource(params: Readonly<{
  scope: AccountSettingsScope;
  replacement: VoiceCredentialReplacement;
  expectedSettingsVersion: number;
  requiredRecipientContractDigest?: string | null;
  mutate: (capture: SavedSecretFullReferenceResourceMutationCapture, replacement: VoiceCredentialReplacement)
    => ReturnType<SavedSecretFullReferenceResourceCreationParams['mutateCatalogs']>;
  onApprovalSucceeded?: SavedSecretFullReferenceResourceCreationParams['onApprovalSucceeded'];
  onApprovalFailed?: SavedSecretFullReferenceResourceCreationParams['onApprovalFailed'];
}>) {
  const { createSavedSecretResourcesWithCatalogMutation } = await import('@/sync/ops/settings/savedSecretResourceOperations');
  return createSavedSecretResourcesWithCatalogMutation({
    scope: params.scope,
    referenceScope: 'full',
    resources: [params.replacement.secret],
    mutateCatalogs: capture => {
      if (capture.settingsVersion !== params.expectedSettingsVersion) return { ok: false, reason: 'changed' };
      const approvalDigest = params.requiredRecipientContractDigest === undefined
        ? params.replacement.approvedRecipientContractDigest
        : resolveAccountVoiceCredentialApprovalDigest({
            requiredRecipientContractDigest: params.requiredRecipientContractDigest,
            savedSecret: { kind: 'shared_resource', fingerprint: capture.resourceFingerprints.get(params.replacement.secret.id) ?? null },
          });
      if (params.requiredRecipientContractDigest && !approvalDigest) return { ok: false, reason: 'unavailable' };
      return params.mutate(capture, { ...params.replacement,
        ...(approvalDigest ? { approvedRecipientContractDigest: approvalDigest } : {}),
      });
    },
    ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
    ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
  });
}

/** Replaces only the dormant SavedSecret slot, preserving source and purpose selection. */
export async function replaceScopedAccountVoiceCredential(params: Readonly<{
  scope: AccountSettingsScope | null;
  replacement: VoiceCredentialReplacement;
  expectedSettingsVersion: number;
  requiredRecipientContractDigest?: string | null;
  onApprovalSucceeded?: (result: Extract<OneShotAccountSettingsMutationResult<undefined>, { status: 'applied' }>) => void | Promise<void>;
  onApprovalFailed?: (code: string) => void;
}>): Promise<RecoverableVoiceCredentialMutationResult<OneShotAccountSettingsMutationResult<undefined>>> {
  if (!params.scope) throw new Error('account_settings_scope_unavailable');
  const applied = (settingsVersion: number) => ({ status: 'applied' as const, settingsVersion, value: undefined });
  const result = await saveScopedAccountVoiceCredentialResource({
    scope: params.scope,
    replacement: params.replacement,
    expectedSettingsVersion: params.expectedSettingsVersion,
    requiredRecipientContractDigest: params.requiredRecipientContractDigest,
    mutate: ({ rawSettings, catalogs }, replacement) => ({
      settings: applyAccountSettingsSavedSecretMutation(rawSettings, replacement, catalogs).settings,
      catalogs,
    }),
    ...(params.onApprovalSucceeded ? { onApprovalSucceeded: receipt => params.onApprovalSucceeded!(applied(receipt.settingsVersion)) } : {}),
    ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
  });
  return voiceCredentialResourceReceipt<OneShotAccountSettingsMutationResult<undefined>>(result, applied,
    () => ({ status: 'conflict', currentSettingsVersion: params.expectedSettingsVersion }),
    () => ({ status: 'outcomeUnknown', lastKnownSettingsVersion: params.expectedSettingsVersion }));
}

/** One captured Account pairs the source selection with its qualified-purpose row. */
export async function mutateScopedAccountVoiceCredentialSource(params: Readonly<{
  scope: AccountSettingsScope | null;
  mutation: AccountSettingsVoiceCredentialSourceMutation;
  expectedDeclaration: VoiceProviderContribution;
  resolveCurrentDeclaration: (contribution: PluginContributionIdentityV1) => VoiceProviderContribution | null;
  observeProducedSettings?: (settings: Settings) => void;
  requiredRecipientContractDigest?: string | null;
  onApprovalSucceeded?: (result: Extract<AccountSettingsVoiceCredentialSourceMutationResult, { status: 'applied' }>) => void | Promise<void>;
  onApprovalFailed?: (code: string) => void;
}>): Promise<RecoverableVoiceCredentialMutationResult<AccountSettingsVoiceCredentialSourceMutationResult>> {
  if (!params.scope) throw new Error('connected_purpose_catalog_unavailable');
  const replacement = params.mutation.savedSecretMutation;
  if (replacement?.kind === 'replaceVoiceCredentialSecret') {
    const expectedContractKey = voiceCredentialSourceMutationContractKey(params.expectedDeclaration, params.mutation);
    if (!expectedContractKey) return staleVoiceCredentialSourceMutation(params.mutation);
    let produced: AccountVoiceCredentialSourceMutationValue | null = null;
    const appliedResult = (settingsVersion: number): Extract<AccountSettingsVoiceCredentialSourceMutationResult, { status: 'applied' }> => {
      if (!produced) throw new Error('voice_credential_source_unavailable');
      return { status: 'applied', settingsVersion, ...produced };
    };
    const result = await saveScopedAccountVoiceCredentialResource({
      scope: params.scope,
      replacement,
      expectedSettingsVersion: params.mutation.expectedSettingsVersion,
      requiredRecipientContractDigest: params.requiredRecipientContractDigest,
      mutate: ({ rawSettings, catalogs }, preparedReplacement) => {
        const declaration = params.resolveCurrentDeclaration(params.mutation.contribution);
        if (!declaration
          || voiceCredentialSourceMutationContractKey(declaration, params.mutation) !== expectedContractKey) {
          return { ok: false, reason: 'changed' };
        }
        if (catalogs.connectedPurposes === undefined) return { ok: false, reason: 'unavailable' };
        const candidate = applySavedSecretCatalogVoiceCredentialSourceMutationV1(rawSettings, {
          ...params.mutation,
          savedSecretMutation: preparedReplacement,
        }, declaration, catalogs);
        produced = { selection: candidate.selection, binding: candidate.binding };
        return { settings: candidate.settings, catalogs: { ...catalogs, connectedPurposes: candidate.connectedPurposes } };
      },
      ...(params.onApprovalSucceeded ? { onApprovalSucceeded: value => params.onApprovalSucceeded!(appliedResult(value.settingsVersion)) } : {}),
      ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    return voiceCredentialResourceReceipt<AccountSettingsVoiceCredentialSourceMutationResult>(result, appliedResult,
      () => staleVoiceCredentialSourceMutation(params.mutation),
      () => ({ status: 'outcomeUnknown', lastKnownSettingsVersion: params.mutation.expectedSettingsVersion }));
  }
  const { sync } = await import('@/sync/sync');
  return withConnectedAccountCatalogAccount(params.scope, undefined, async (context) => {
    const snapshot = await readConnectedAccountCatalogInContext(context, 'purposes');
    if (snapshot.status !== 'ready' || snapshot.record.key !== 'purposes') {
      throw new Error('connected_purpose_catalog_unavailable');
    }
    let purposes: ConnectedPurposeCatalogV1 | null = null;
    let voiceCredentialMutation: Readonly<{
      currentSettings: Readonly<Record<string, unknown>>;
      nextSettings: Readonly<Record<string, unknown>>;
    }> | null = null;
    let referencedSavedSecretIds: string[] = [];
    return mutateAccountVoiceCredentialSource({
      ...params,
      connectedPurposes: snapshot.record.value,
      mutateAccountSettingsOnce: (input) => sync.mutateAccountSettingsOnce({
        expectedSettingsScope: params.scope,
        expectedSettingsVersion: input.expectedSettingsVersion,
        mutate: (raw) => {
          context.assertCurrent();
          const produced = input.mutate(raw);
          purposes = produced.connectedPurposes;
          voiceCredentialMutation = { currentSettings: raw, nextSettings: produced.settings };
          const gesture = params.mutation.savedSecretMutation;
          referencedSavedSecretIds = [...listSavedSecretVoiceCredentialMutationReferencesV1(raw, produced.settings, {
            ...(gesture?.kind === 'bindVoiceCredentialSavedSecret' ? { requestedReferences: [gesture.secretId] } : {}),
          })];
          params.observeProducedSettings?.(settingsParse(produced.settings));
          return produced;
        },
        commitPrepared: async (prepared) => {
          if (!purposes || !voiceCredentialMutation) throw new Error('connected_purpose_catalog_unavailable');
          try {
            const result = await writeConnectedAccountCatalogRecordAndPublishInContext(context, {
              record: { key: 'purposes', value: purposes },
              expectedRevision: snapshot.revision,
              voiceCredentialMutation,
              referencedSavedSecretIds,
              settingsMutation: {
                content: prepared.content,
                expectedSettingsVersion: prepared.expectedSettingsVersion,
                ...(prepared.remoteAlertPolicy === undefined ? {} : { remoteAlertPolicy: prepared.remoteAlertPolicy }),
              },
            });
            if (result.status === 'updated') return result.settingsVersion === undefined
              ? { status: 'outcomeUnknown', lastKnownSettingsVersion: prepared.expectedSettingsVersion }
              : { status: 'applied', settingsVersion: result.settingsVersion };
            if (result.status === 'settings-conflict') return {
              status: 'conflict', currentSettingsVersion: result.revision,
            };
            if (result.status === 'conflict') return {
              status: 'conflict', currentSettingsVersion: prepared.expectedSettingsVersion,
            };
            throw new ConnectedAccountCatalogOperationError(result.status, result);
          } catch (error) {
            if (error instanceof ConnectedAccountCatalogOperationError && error.code === 'outcome_unknown') {
              return { status: 'outcomeUnknown', lastKnownSettingsVersion: prepared.expectedSettingsVersion };
            }
            return { status: 'rejected', error: error instanceof Error ? error : new Error('connected_purpose_mutation_failed') };
          }
        },
      }),
    });
  });
}

export function resolveAccountVoiceCredential(
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>,
  contribution: PluginContributionIdentityV1,
  credentialSlotId: string,
  machineId?: string | null,
  requiredRecipientContractDigest?: string | null,
): Readonly<{ secretId: string; source: AccountVoiceCredentialSource }> | null {
  const resolved = resolveAccountSettingsVoiceCredentialSecret(settings, {
    contribution,
    credentialSlotId,
    machineId: machineId ?? null,
  });
  if (requiredRecipientContractDigest
    && resolved.approvedRecipientContractDigest !== requiredRecipientContractDigest) return null;
  return resolved.reference;
}

export function isAccountVoiceCredentialRecipientApprovalRequired(params: Readonly<{
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  requiredRecipientContractDigest?: string | null;
}>): boolean {
  return resolveAccountVoiceCredentialStatus(params).status === 'review_required';
}

export function resolveAccountVoiceCredentialStatus(params: Readonly<{
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  requiredRecipientContractDigest?: string | null;
  resolveSavedSecret?: (ref: string) => SavedSecretReferenceResolution;
}>): AccountVoiceCredentialStatus {
  let reference: ReturnType<typeof resolveAccountVoiceCredential>;
  let binding: ReturnType<typeof resolveAccountSettingsVoiceCredentialSecret>;
  try {
    reference = resolveAccountVoiceCredential(
      params.settings,
      params.contribution,
      params.credentialSlotId,
      params.machineId,
    );
    binding = resolveAccountSettingsVoiceCredentialSecret(params.settings, {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    });
  } catch {
    // The snapshot could not be resolved at all. Fail closed, but say so
    // instead of claiming the credential is absent.
    return Object.freeze({ status: 'unknown', reference: null });
  }
  if (!reference) return Object.freeze({ status: 'missing', reference: null });
  const savedSecret = params.resolveSavedSecret?.(reference.secretId);
  if (reference.secretId.startsWith('happier:shared-secret:v1:')) {
    if (!savedSecret || savedSecret.kind !== 'shared_resource' || savedSecret.status !== 'ready') {
      return Object.freeze({
        status: savedSecret?.status === 'access_removed' || savedSecret?.status === 'deleted'
          ? 'missing'
          : 'unknown',
        reference,
        ...(savedSecret ? { savedSecret } : {}),
      });
    }
  }
  const requiredApprovalDigest = resolveAccountVoiceCredentialApprovalDigest({
    requiredRecipientContractDigest: params.requiredRecipientContractDigest,
    savedSecret,
  });
  return Object.freeze({
    status: params.requiredRecipientContractDigest
      && (!requiredApprovalDigest
        || binding.approvedRecipientContractDigest !== requiredApprovalDigest)
      ? 'review_required'
      : 'ready',
    reference,
    ...(savedSecret?.kind === 'shared_resource' ? { savedSecret } : {}),
  });
}

export function resolveExactAccountVoiceCredentialSecretId(params: Readonly<{
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
}>): string | null {
  return resolveAccountSettingsVoiceCredentialSecret(params.settings, {
    contribution: params.contribution,
    credentialSlotId: params.credentialSlotId,
    machineId: params.machineId ?? null,
  }).exactSecretId;
}

export function upsertAccountVoiceCredential(params: Readonly<{
  settings: Settings;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  value: string;
  generateId: () => string;
  now: number;
  expectedSecretId: string | null;
  expectedSecretUpdatedAt: number | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  secretId: string;
}> {
  const replacement = createAccountVoiceCredentialReplacementMutation(params);
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(accountSettings, replacement.mutation);
  return {
    secretId: replacement.secretId,
    accountSettings: { ...result.settings },
    settings: settingsParse(result.settings),
  };
}

export function createAccountVoiceCredentialReplacementMutation(params: Readonly<{
  settings: Settings;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  value: string;
  generateId: () => string;
  now: number;
  expectedSecretId: string | null;
  expectedSecretUpdatedAt: number | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<{
  secretId: string;
  mutation: Extract<AccountSettingsSavedSecretMutation, { kind: 'replaceVoiceCredentialSecret' }>;
}> {
  const value = params.value;
  if (value.length === 0) throw new TypeError('Voice credential value must not be empty');
  const secretId = params.generateId();
  const existing = params.expectedSecretId
    ? params.settings.secrets.find((secret) => secret.id === params.expectedSecretId)
    : null;
  const mutation = {
    kind: 'replaceVoiceCredentialSecret',
    target: {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
    secret: {
      id: secretId,
      name: existing?.name ?? `Voice: ${buildQualifiedPluginContributionKey(params.contribution)}`,
      kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value },
      createdAt: params.now,
      updatedAt: params.now,
    },
    ...(params.approvedRecipientContractDigest === undefined
      ? {}
      : {
          approvedRecipientContractDigest:
            params.approvedRecipientContractDigest,
        }),
  } satisfies Extract<AccountSettingsSavedSecretMutation, { kind: 'replaceVoiceCredentialSecret' }>;
  return Object.freeze({
    secretId,
    mutation,
  });
}

export type AccountVoiceCredentialBindingTarget = Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  /** An existing SavedSecret id. No secret material crosses this boundary. */
  secretId: string;
  expectedSecretId: string | null;
  expectedSecretUpdatedAt: number | null;
  approvedRecipientContractDigest?: string;
}>;

export function createAccountVoiceCredentialBindingMutation(
  params: AccountVoiceCredentialBindingTarget,
): Extract<AccountSettingsSavedSecretMutation, { kind: 'bindVoiceCredentialSavedSecret' }> {
  return Object.freeze({
    kind: 'bindVoiceCredentialSavedSecret',
    target: {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
    secretId: params.secretId,
    ...(params.approvedRecipientContractDigest === undefined
      ? {}
      : {
          approvedRecipientContractDigest:
            params.approvedRecipientContractDigest,
        }),
  } satisfies Extract<AccountSettingsSavedSecretMutation, { kind: 'bindVoiceCredentialSavedSecret' }>);
}

/**
 * Points the slot at a SavedSecret the account already stores. The Voice
 * source selection is untouched here; use the source mutation when the
 * contribution declares a credential-source purpose.
 */
export function bindAccountVoiceCredentialSavedSecret(
  params: AccountVoiceCredentialBindingTarget & Readonly<{ settings: Settings; catalogs?: SavedSecretReferenceCatalogsV1 }>,
): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(
    accountSettings,
    createAccountVoiceCredentialBindingMutation(params),
    params.catalogs,
  );
  return Object.freeze({
    accountSettings: { ...result.settings },
    settings: settingsParse(result.settings),
  });
}

export function saveAndUseAccountVoiceCredential(params: Readonly<{
  settings: Settings;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  expectedSettingsVersion: number;
  currentDeclaration: VoiceProviderContribution;
  machineId?: string | null;
  value: string;
  generateId: () => string;
  now: number;
  expectedSecretId: string | null;
  expectedSecretUpdatedAt: number | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  secretId: string;
}> {
  const replacement = createAccountVoiceCredentialReplacementMutation(params);
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsVoiceCredentialSourceMutation(
    accountSettings,
    {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      expectedSettingsVersion: params.expectedSettingsVersion,
      selection: { kind: 'savedSecret' },
      savedSecretMutation: replacement.mutation,
    },
    params.currentDeclaration,
  );
  return Object.freeze({
    secretId: replacement.secretId,
    accountSettings: { ...result.settings },
    settings: settingsParse(result.settings),
  });
}

export function approveAccountVoiceCredentialRecipientContract(params: Readonly<{
  settings: Settings;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  expectedSecretId: string;
  expectedSecretUpdatedAt: number;
  approvedRecipientContractDigest: string;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(accountSettings, {
    kind: 'approveVoiceCredentialRecipientContract',
    target: {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
    approvedRecipientContractDigest:
      params.approvedRecipientContractDigest,
  });
  return {
    accountSettings: { ...result.settings },
    settings: settingsParse(result.settings),
  };
}

export function removeAccountVoiceCredential(params: Readonly<{
  settings: Settings;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  expectedSecretId: string;
  expectedSecretUpdatedAt: number;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  deletedSecret: boolean;
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(accountSettings, {
    kind: 'removeVoiceCredentialSecret',
    target: {
      contribution: params.contribution,
      credentialSlotId: params.credentialSlotId,
      machineId: params.machineId ?? null,
    },
    expectedSecretId: params.expectedSecretId,
    expectedSecretUpdatedAt: params.expectedSecretUpdatedAt,
  });
  const settings = settingsParse(result.settings);
  return {
    accountSettings: { ...result.settings },
    deletedSecret: !settings.secrets.some(
      (candidate) => candidate.id === params.expectedSecretId,
    ),
    settings,
  };
}
