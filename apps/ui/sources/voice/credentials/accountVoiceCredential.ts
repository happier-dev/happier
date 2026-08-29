import {
  applyAccountSettingsSavedSecretMutation,
  applyAccountSettingsVoiceCredentialSourceMutation,
  buildQualifiedPluginContributionKey,
  deriveVoiceCredentialBindingIdentityV1,
  resolveAccountSettingsVoiceCredentialSecret,
  resolveAccountSettingsVoiceCredentialSource,
  normalizeRecipientContractV1,
  type AccountSettingsSavedSecretMutation,
  type AccountSettingsVoiceCredentialSourceMutation,
  type AccountSettingsVoiceCredentialSourceMutationResult,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountPurposeV1,
  type SecretStringV1,
  type VoiceCredentialSourceSelection,
  type VoiceProviderContribution,
  type VoiceRawCredentialGrantDeclaration,
  VoiceProviderContributionSchema,
} from '@happier-dev/protocol';

import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type AccountVoiceCredentialSource = 'account' | 'machine_override';
/**
 * `unknown` is not a fourth flavour of absence. The account-settings readers
 * are all-or-nothing over whole collections (`voiceSettingsV1.credentialBindings`,
 * `secrets`, `connectedAccountPurposeBindingsV1`): a single unreadable entry
 * makes the resolver throw for every credential at once. Reporting that as
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
}>;

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
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets' | 'connectedAccountPurposeBindingsV1'>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  machineId?: string | null;
}>): AccountVoiceCredentialSourceSelectionResolution {
  const resolution = resolveAccountSettingsVoiceCredentialSource(params.settings, {
    contribution: params.contribution,
    credentialSlotId: params.credentialSlotId,
    purpose: params.purpose,
    machineId: params.machineId ?? null,
  });
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
  mutation: AccountSettingsVoiceCredentialSourceMutation;
  currentDeclaration: VoiceProviderContribution;
}>): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
  selection: VoiceCredentialSourceSelection;
  binding: ReturnType<typeof applyAccountSettingsVoiceCredentialSourceMutation>['binding'];
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsVoiceCredentialSourceMutation(
    accountSettings,
    params.mutation,
    params.currentDeclaration,
  );
  return Object.freeze({
    accountSettings: { ...result.settings },
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

function qualifyCredentialService(
  service: string | PluginContributionIdentityV1,
  pluginId: string,
): PluginContributionIdentityV1 {
  return typeof service === 'string'
    ? Object.freeze({ pluginId, localId: service })
    : service;
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
    const sourceService = qualifyCredentialService(source.service, params.contribution.pluginId);
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
      ? { service: qualifyCredentialService(source.service, declaringPluginId) }
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
              qualifyCredentialService(source.service, mutation.contribution.pluginId),
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
  mutation: AccountSettingsVoiceCredentialSourceMutation;
  expectedDeclaration: VoiceProviderContribution;
  resolveCurrentDeclaration: (
    contribution: PluginContributionIdentityV1,
  ) => VoiceProviderContribution | null;
  mutateAccountSettingsOnce: <T>(input: Readonly<{
    expectedSettingsVersion: number;
    mutate: (
      raw: Readonly<Record<string, unknown>>,
    ) => Readonly<{ settings: Record<string, unknown>; value: T }>;
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
          mutation: params.mutation,
          currentDeclaration,
        });
        return Object.freeze({
          settings: applied.accountSettings,
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
  return Object.freeze({
    status: params.requiredRecipientContractDigest
      && binding.approvedRecipientContractDigest !== params.requiredRecipientContractDigest
      ? 'review_required'
      : 'ready',
    reference,
  });
}

export function materializeAccountVoiceCredential(params: Readonly<{
  settings: Pick<Settings, 'voiceSettingsV1' | 'secrets'>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId?: string | null;
  requiredRecipientContractDigest?: string | null;
  decrypt: (value: SecretStringV1) => string | null;
}>): string | null {
  const reference = resolveAccountVoiceCredential(
    params.settings,
    params.contribution,
    params.credentialSlotId,
    params.machineId,
    params.requiredRecipientContractDigest,
  );
  if (!reference) return null;
  const record = params.settings.secrets.find((secret) => secret.id === reference.secretId);
  return record ? params.decrypt(record.encryptedValue) : null;
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
  const value = params.value.trim();
  if (!value) throw new TypeError('Voice credential value must not be empty');
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
  params: AccountVoiceCredentialBindingTarget & Readonly<{ settings: Settings }>,
): Readonly<{
  settings: Settings;
  accountSettings: Record<string, unknown>;
}> {
  const { voice: _runtimeVoiceProjection, ...accountSettings } = params.settings;
  const result = applyAccountSettingsSavedSecretMutation(
    accountSettings,
    createAccountVoiceCredentialBindingMutation(params),
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
