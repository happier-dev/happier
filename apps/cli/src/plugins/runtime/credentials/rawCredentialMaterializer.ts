import { createHash } from 'node:crypto';

import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountMaterialization as PluginConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import type { VoiceRawCredentialAccess } from '@happier-dev/plugin-sdk/voice';
import {
  CredentialAccessDeclarationDigestSchema,
  CredentialAccessSelectedAuthorityDigestSchema,
  CredentialAccessSelectedRawAccessDigestSchema,
  ConnectedAccountMaterializationRequestSchema,
  ConnectedServiceCredentialRevisionV1Schema,
  PluginCredentialAccessSlotIdSchema,
  PluginPermissionInstalledGenerationIdSchema,
  PluginPermissionGrantListActionInputV1Schema,
  PluginPermissionGrantListActionOutputV1Schema,
  PluginMachineMaterializationRefV1Schema,
  PluginPermissionSubjectV1Schema,
  QualifiedConnectedAccountRefSchema,
  SavedSecretSchema,
  decryptSecretValueWithKeysV1,
  deriveVoiceCredentialBindingIdentityV1,
  resolveAccountSettingsVoiceCredentialSource,
  type PluginContributionIdentityV1,
  type ConnectedServiceCredentialRevisionV1,
  type PluginInstallReviewPrincipalDigest,
  type PluginInstallReviewPrincipalPresentationV1,
  type PluginMachineMaterializationRefV1,
  type PluginPermissionGrantAuthoritySourceV1,
  type PluginPermissionSubjectV1,
  type QualifiedConnectedAccountRef,
  type VoiceCredentialAccessPhase,
  type VoiceCredentialSource,
  type VoiceProviderContribution,
} from '@happier-dev/protocol';

import type {
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';
import { evaluatePluginPermissionGrant } from '@/plugins/runtime/lifecycle/permissions/evaluatePluginPermissionGrant';
import type { PluginPermissionGrantListReader } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantListReader';

type VoiceRawCredentialMaterializationRequest = Parameters<
  VoiceRawCredentialAccess['materialize']
>[0];
type VoiceRawCredentialMaterialization = PluginConnectedAccountMaterialization;

/**
 * Host-private receipt bridge for one raw-credential callback. The receipt is
 * opaque to the callback consumer and may come from any selected source.
 */
type RawCredentialCallbackRevisionBasis = Readonly<{
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  captureCredentialRevision(credentialRevision: ConnectedServiceCredentialRevisionV1): void;
}>;

const RAW_CREDENTIAL_CAPABILITY = 'credentials.materialize.raw' as const;
const ACCOUNT_TARGET_SCOPE = Object.freeze({ kind: 'account' as const });
const DECLARATION_DIGEST_DOMAIN = 'happier.plugin.credential-access-disclosure.v1\0';
const SELECTED_AUTHORITY_DIGEST_DOMAIN = 'happier.plugin.credential-access-selected-authority.v1\0';
const SELECTED_RAW_ACCESS_DIGEST_DOMAIN = 'happier.plugin.credential-access-selected-raw-access.v1\0';
const RAW_CREDENTIAL_CALLBACK_REVISION_DOMAIN = 'happier.plugin.raw-credential-callback-revision.v1\0';

export type { PluginPermissionGrantListReader } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantListReader';

/** Read-only port over the daemon install-record principal owner. */
export type CurrentPluginInstallReviewPrincipal = Readonly<{
  digest: PluginInstallReviewPrincipalDigest;
  presentation: PluginInstallReviewPrincipalPresentationV1 | null;
}>;

export type CurrentPluginInstallReviewPrincipalReader = Readonly<{
  readCurrent(input: Readonly<{
    pluginId: string;
    signal: AbortSignal;
  }>): Promise<CurrentPluginInstallReviewPrincipal | null>;
}>;

/**
 * Read-only port over the daemon's own machine-installation identity. A raw
 * credential approval is recorded against the exact installation whose person
 * granted it, so disclosure has to know which installation is asking.
 */
export type CurrentPluginPermissionGrantAuthoritySourceReader =
  () => Promise<PluginPermissionGrantAuthoritySourceV1 | null>;

export type PluginRawCredentialMaterializerBinding = Readonly<{
  /** Exact installed/admitted G manifest. Desired-H inequality alone does not retire this authority. */
  manifest: CanonicalPluginManifest;
  contribution: PluginContributionIdentityV1;
  realm: 'web' | 'ios' | 'android' | 'daemon';
  phase: VoiceCredentialAccessPhase;
  machineId: string | null;
  /** Exact host-stamped plugin materialization whose runtime is requesting disclosure. */
  materialization?: PluginMachineMaterializationRefV1;
  /** Immutable registry-owned generation that admitted this exact runtime. */
  immutableGenerationId: string;
  /** Host-owned exact admitted-runtime policy, including generation retirement. */
  isRuntimeAuthorityCurrent(): boolean;
}>;

export type PluginRawCredentialMaterializer = Readonly<{
  inspectAuthorization(
    request: VoiceRawCredentialMaterializationRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginRawCredentialAuthorizationInspection>;
  materialize(
    request: VoiceRawCredentialMaterializationRequest,
    options?: PluginRawCredentialMaterializationOptions,
  ): Promise<VoiceRawCredentialMaterialization>;
}>;

/** Host-only options; plugin-facing raw access retains exactly `{ materialize }`. */
export type PluginRawCredentialMaterializationOptions = Readonly<{
  signal?: AbortSignal;
  credentialRevisionBasis?: RawCredentialCallbackRevisionBasis;
}>;

export type PluginRawCredentialAuthorizationInspection = Readonly<{
  pluginId: string;
  capability: 'credentials.materialize.raw';
  targetScope: Readonly<{ kind: 'account' }>;
  subject: PluginPermissionSubjectV1;
  /** The machine installation this authorization is scoped to. */
  authoritySource: PluginPermissionGrantAuthoritySourceV1;
  disclosures: readonly PluginRawCredentialDisclosureRow[];
}>;

export type PluginRawCredentialAuthorizationInspector = Readonly<{
  inspectAuthorization(
    request: VoiceRawCredentialMaterializationRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginRawCredentialAuthorizationInspection>;
}>;

export type PluginRawCredentialDisclosureSourceClass =
  | Readonly<{
      kind: 'savedSecret';
      secretKinds: readonly ('apiKey' | 'token' | 'password' | 'other')[];
    }>
  | Readonly<{
      kind: 'connectedAccount';
      service: PluginContributionIdentityV1;
    }>;

export type PluginRawCredentialDisclosureRow = Readonly<{
  sourceClass: PluginRawCredentialDisclosureSourceClass;
  realm: 'web' | 'ios' | 'android' | 'daemon';
  phase: VoiceCredentialAccessPhase;
  materialization: 'httpHeaders' | 'environment' | 'files';
  origin?: string;
  destination: string;
}>;

type DeclarationAuthority = Readonly<{
  contribution: VoiceProviderContribution;
  identity: NonNullable<ReturnType<typeof deriveVoiceCredentialBindingIdentityV1>>;
}>;

type SelectedSource = Readonly<{
  source: VoiceCredentialSource;
  qualifiedConnectedAccountService: PluginContributionIdentityV1 | null;
  expectedConnectedAccount: QualifiedConnectedAccountRef | null;
  savedSecretCustody: Readonly<{
    snapshot: ActiveAccountSettingsSnapshot;
    secretId: string;
    /** Opaque, source-neutral callback receipt; never carries secret material. */
    callbackCredentialRevision: ConnectedServiceCredentialRevisionV1;
  }> | null;
  selectedAuthorityDigest: ReturnType<typeof CredentialAccessSelectedAuthorityDigestSchema.parse>;
  fingerprint: string;
}>;

type Authorization = Readonly<{
  selected: SelectedSource;
  subject: ReturnType<typeof PluginPermissionSubjectV1Schema.parse>;
  /** Exact approving daemon installation read in the selected-source bracket. */
  authoritySource: Extract<PluginPermissionGrantAuthoritySourceV1, Readonly<{
    kind: 'machine_installation';
  }>>;
}>;

function unavailable(): PluginError {
  return new PluginError({
    code: 'plugin_voice_credential_access_unavailable',
    message: 'Voice credential access is unavailable',
  });
}

function invalidRequest(): PluginError {
  return new PluginError({
    code: 'plugin_voice_provider_result_invalid',
    message: 'Voice provider result is invalid',
  });
}

function providerOperationFailed(): PluginError {
  return new PluginError({
    code: 'plugin_voice_provider_operation_failed',
    message: 'Voice provider operation failed',
  });
}

/**
 * The raw materializer retains host-only inspection for review and admission.
 * Plugin-facing Voice contexts receive this exact, invocation-bounded shape
 * instead, so a retained capability cannot outlive the host operation.
 */
export function createInvocationVoiceRawCredentialAccess(input: Readonly<{
  materializer: Pick<PluginRawCredentialMaterializer, 'materialize'>;
  signal: AbortSignal;
  /** Captured settings/source currentness for this exact host invocation. */
  isCurrent(): boolean;
}>): VoiceRawCredentialAccess {
  let expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
  // The revision basis belongs to the whole provider callback, not to one
  // individual materialization. Serialize only this invocation's calls so two
  // concurrent first reads cannot both admit a null basis and return different
  // credential revisions. A rejected call is deliberately absorbed by the tail
  // so later calls can still prove the already-captured basis.
  let materializationTail: Promise<void> = Promise.resolve();
  const assertInvocationCurrent = () => {
    if (input.signal.aborted || !input.isCurrent()) throw unavailable();
  };
  return Object.freeze({
    async materialize(request, options = {}) {
      const operation = materializationTail.then(async () => {
        assertInvocationCurrent();
        const signal = options.signal && options.signal !== input.signal
          ? AbortSignal.any([input.signal, options.signal])
          : input.signal;
        let capturedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
        try {
          signal.throwIfAborted();
          const result = await input.materializer.materialize(request, {
            signal,
            credentialRevisionBasis: Object.freeze({
              expectedCredentialRevision,
              captureCredentialRevision(credentialRevision) {
                capturedCredentialRevision = credentialRevision;
              },
            }),
          });
          assertInvocationCurrent();
          options.signal?.throwIfAborted();
          if (capturedCredentialRevision === null) throw unavailable();
          if (
            expectedCredentialRevision !== null
            && capturedCredentialRevision !== expectedCredentialRevision
          ) throw unavailable();
          expectedCredentialRevision = capturedCredentialRevision;
          return result;
        } catch (error) {
          assertInvocationCurrent();
          options.signal?.throwIfAborted();
          throw error;
        }
      });
      materializationTail = operation.then(() => undefined, () => undefined);
      return await operation;
    },
  });
}

class InvalidConnectedAccountMaterialization extends Error {}
class UndeclaredRawCredentialTuple extends Error {}

function throwInvalidConnectedAccountMaterialization(): never {
  throw new InvalidConnectedAccountMaterialization();
}

function contributionKey(value: Readonly<{ pluginId: string; localId: string }>): string {
  return `${value.pluginId}\0${value.localId}`;
}

function canonicalRequest(
  raw: VoiceRawCredentialMaterializationRequest,
): VoiceRawCredentialMaterializationRequest {
  const parsed = ConnectedAccountMaterializationRequestSchema.safeParse(raw);
  if (!parsed.success) throw invalidRequest();
  if (parsed.data.kind === 'httpHeaders') {
    return Object.freeze({
      ...parsed.data,
      headerNames: [...parsed.data.headerNames].sort(),
    });
  }
  if (parsed.data.kind === 'environment') {
    return Object.freeze({
      ...parsed.data,
      keys: [...parsed.data.keys].sort(),
    });
  }
  return Object.freeze({
    ...parsed.data,
    fileIds: [...parsed.data.fileIds].sort(),
  });
}

function requestKey(request: VoiceRawCredentialMaterializationRequest): string {
  return JSON.stringify(canonicalRequest(request));
}

function qualifyContributionReference(
  ownerPluginId: string,
  reference: string | Readonly<{ pluginId: string; localId: string }>,
): PluginContributionIdentityV1 {
  return typeof reference === 'string'
    ? Object.freeze({ pluginId: ownerPluginId, localId: reference })
    : Object.freeze({ ...reference });
}

function sourceDisclosureClass(
  ownerPluginId: string,
  source: VoiceCredentialSource,
): PluginRawCredentialDisclosureSourceClass {
  if (source.kind === 'savedSecret') {
    return Object.freeze({
      kind: 'savedSecret',
      secretKinds: Object.freeze([...source.secretKinds].sort()),
    });
  }
  return Object.freeze({
    kind: 'connectedAccount',
    service: qualifyContributionReference(ownerPluginId, source.service),
  });
}

function exactDisclosureRows(
  ownerPluginId: string,
  selected: VoiceCredentialSource,
  binding: Pick<PluginRawCredentialMaterializerBinding, 'realm' | 'phase'>,
  request: VoiceRawCredentialMaterializationRequest,
): readonly PluginRawCredentialDisclosureRow[] {
  const sourceClass = sourceDisclosureClass(ownerPluginId, selected);
  const canonical = canonicalRequest(request);
  const common = Object.freeze({
    sourceClass,
    realm: binding.realm,
    phase: binding.phase,
  });
  if (canonical.kind === 'httpHeaders') {
    return Object.freeze(canonical.headerNames.map((destination) => Object.freeze({
      ...common,
      materialization: 'httpHeaders' as const,
      origin: canonical.origin,
      destination,
    })));
  }
  if (canonical.kind === 'environment') {
    return Object.freeze(canonical.keys.map((destination) => Object.freeze({
      ...common,
      materialization: 'environment' as const,
      destination,
    })));
  }
  return Object.freeze(canonical.fileIds.map((destination) => Object.freeze({
    ...common,
    materialization: 'files' as const,
    destination,
  })));
}

function deriveDeclarationAuthorityUnsafe(
  binding: PluginRawCredentialMaterializerBinding,
): DeclarationAuthority {
  if (binding.manifest.id !== binding.contribution.pluginId) throw invalidRequest();
  const contribution = binding.manifest.contributes.voiceProviders?.find((candidate) => (
    candidate.id === binding.contribution.localId
  ));
  if (!contribution?.credentials) throw invalidRequest();
  const seenConnectedServices = new Set<string>();
  for (const source of contribution.credentials.sources) {
    if (source.kind !== 'connectedAccount') continue;
    const key = contributionKey(qualifyContributionReference(
      binding.manifest.id,
      source.service,
    ));
    if (seenConnectedServices.has(key)) throw invalidRequest();
    seenConnectedServices.add(key);
  }
  const identity = deriveVoiceCredentialBindingIdentityV1({
    pluginId: binding.manifest.id,
    contribution,
  });
  if (!identity) throw invalidRequest();
  PluginPermissionInstalledGenerationIdSchema.parse(binding.immutableGenerationId);
  if (!contribution.credentials.sources.some((source) => source.rawGrants?.some((grant) => (
    grant.realm === binding.realm && grant.phase === binding.phase
  )))) {
    throw invalidRequest();
  }
  return Object.freeze({ contribution, identity });
}

function deriveDeclarationAuthority(
  binding: PluginRawCredentialMaterializerBinding,
): DeclarationAuthority {
  try {
    return deriveDeclarationAuthorityUnsafe(binding);
  } catch {
    throw invalidRequest();
  }
}

function assertRuntimeCurrent(binding: PluginRawCredentialMaterializerBinding): void {
  let current = false;
  try {
    current = binding.isRuntimeAuthorityCurrent();
  } catch {
    throw unavailable();
  }
  if (!current) throw unavailable();
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function selectedRawAccessDigest(
  binding: Pick<PluginRawCredentialMaterializerBinding, 'realm' | 'phase'>,
  request: VoiceRawCredentialMaterializationRequest,
): ReturnType<typeof CredentialAccessSelectedRawAccessDigestSchema.parse> {
  return CredentialAccessSelectedRawAccessDigestSchema.parse(digest(
    SELECTED_RAW_ACCESS_DIGEST_DOMAIN,
    Object.freeze({
      v: 1,
      realm: binding.realm,
      phase: binding.phase,
      request: canonicalRequest(request),
    }),
  ));
}

function selectedAuthorityDigest(
  value: Readonly<Record<string, unknown>>,
): ReturnType<typeof CredentialAccessSelectedAuthorityDigestSchema.parse> {
  return CredentialAccessSelectedAuthorityDigestSchema.parse(digest(
    SELECTED_AUTHORITY_DIGEST_DOMAIN,
    Object.freeze({ v: 1, ...value }),
  ));
}

function savedSecretCallbackCredentialRevision(input: Readonly<{
  selectedAuthorityDigest: ReturnType<typeof CredentialAccessSelectedAuthorityDigestSchema.parse>;
  updatedAt: number;
}>): ConnectedServiceCredentialRevisionV1 {
  // Callback callers must be able to fence a reused raw-access object without
  // learning the selected source, secret id, timestamp, or secret bytes.
  return ConnectedServiceCredentialRevisionV1Schema.parse(`csr_${digest(
    RAW_CREDENTIAL_CALLBACK_REVISION_DOMAIN,
    Object.freeze({ v: 1, ...input }),
  )}`);
}

async function selectedSourceFromSnapshot(
  binding: PluginRawCredentialMaterializerBinding,
  authority: DeclarationAuthority,
  connectedAccounts: Pick<StablePluginConnectedAccountsOwner, 'getBinding'> | undefined,
  snapshot: ActiveAccountSettingsSnapshot | null,
  accountSettingsLifetimeToken: number,
  signal: AbortSignal,
): Promise<SelectedSource> {
  if (!snapshot) throw unavailable();
  let resolved: ReturnType<typeof resolveAccountSettingsVoiceCredentialSource>;
  try {
    resolved = resolveAccountSettingsVoiceCredentialSource(
      snapshot.settings as unknown as Readonly<Record<string, unknown>>,
      {
        contribution: authority.identity.contribution,
        credentialSlotId: authority.identity.credentialSlotId,
        purpose: authority.identity.purpose,
        machineId: binding.machineId,
      },
    );
  } catch {
    throw unavailable();
  }
  // Account Settings' version is a whole-document CAS revision. It advances
  // for unrelated settings mutations, so it is not part of one selected Voice
  // credential's authority. The exact selected binding, source, secret/account,
  // declaration grant, and account scope below are the currentness facts.
  const selectedAccountScopeKey = snapshot.scopeKey ?? '';
  if (resolved.selection.kind === 'savedSecret') {
    if (!resolved.savedSecret) throw unavailable();
    const source = authority.contribution.credentials?.sources.find((candidate) => (
      candidate.kind === 'savedSecret'
    ));
    if (!source || source.kind !== 'savedSecret') throw unavailable();
    const rawSecrets = (snapshot.settings as unknown as Readonly<Record<string, unknown>>).secrets;
    const savedSecret = Array.isArray(rawSecrets)
      ? rawSecrets.map((candidate) => SavedSecretSchema.safeParse(candidate))
          .flatMap((parsed) => parsed.success ? [parsed.data] : [])
          .find((candidate) => candidate.id === resolved.savedSecret?.secretId)
      : undefined;
    if (!savedSecret || !source.secretKinds.includes(savedSecret.kind)) throw unavailable();
    const selectedAuthority = selectedAuthorityDigest({
      source: 'savedSecret',
      accountSettingsScopeKey: snapshot.scopeKey ?? null,
      bindingSource: resolved.savedSecret.source,
      secretId: resolved.savedSecret.secretId,
      secretKind: savedSecret.kind,
    });
    return Object.freeze({
      source,
      qualifiedConnectedAccountService: null,
      expectedConnectedAccount: null,
      savedSecretCustody: Object.freeze({
        snapshot,
        secretId: resolved.savedSecret.secretId,
        callbackCredentialRevision: savedSecretCallbackCredentialRevision({
          selectedAuthorityDigest: selectedAuthority,
          updatedAt: savedSecret.updatedAt,
        }),
      }),
      selectedAuthorityDigest: selectedAuthority,
      fingerprint: [
        accountSettingsLifetimeToken,
        selectedAccountScopeKey,
        'savedSecret',
        resolved.savedSecret.source,
        resolved.savedSecret.secretId,
        savedSecret.kind,
        savedSecret.updatedAt,
      ].join('\0'),
    });
  }
  if (resolved.selection.kind !== 'connectedAccount') throw unavailable();
  const targetService = resolved.selection.target.kind === 'account'
    ? resolved.selection.target.account.service
    : resolved.selection.target.service;
  const source = authority.contribution.credentials?.sources.find((candidate) => {
    if (candidate.kind !== 'connectedAccount') return false;
    return contributionKey(qualifyContributionReference(
      binding.manifest.id,
      candidate.service,
    )) === contributionKey(targetService);
  });
  if (!source || source.kind !== 'connectedAccount') throw unavailable();
  if (!connectedAccounts) throw unavailable();
  const qualifiedConnectedAccountService = qualifyContributionReference(
    binding.manifest.id,
    source.service,
  );
  let resolvedBinding: Awaited<ReturnType<StablePluginConnectedAccountsOwner['getBinding']>>;
  try {
    resolvedBinding = await connectedAccounts.getBinding({
      purpose: authority.identity.purpose,
      serviceRefs: Object.freeze([{ ...qualifiedConnectedAccountService }]),
      signal,
    });
  } catch {
    throw unavailable();
  }
  signal.throwIfAborted();
  if (
    !resolvedBinding
    || resolvedBinding.purpose !== authority.identity.purpose.purpose
    || contributionKey(resolvedBinding.service) !== contributionKey(qualifiedConnectedAccountService)
  ) {
    throw unavailable();
  }
  const effectiveAccount = QualifiedConnectedAccountRefSchema.safeParse(resolvedBinding.account);
  if (
    !effectiveAccount.success
    || contributionKey(effectiveAccount.data.service)
      !== contributionKey(qualifiedConnectedAccountService)
  ) {
    throw unavailable();
  }
  return Object.freeze({
    source,
    qualifiedConnectedAccountService,
    expectedConnectedAccount: effectiveAccount.data,
    savedSecretCustody: null,
    selectedAuthorityDigest: selectedAuthorityDigest({
      source: 'connectedAccount',
      accountSettingsScopeKey: snapshot.scopeKey ?? null,
      target: resolved.selection.target.kind === 'account'
        ? { kind: 'account', id: resolved.selection.target.account.accountId }
        : { kind: 'group', id: resolved.selection.target.groupId },
      service: effectiveAccount.data.service,
      accountId: effectiveAccount.data.accountId,
    }),
    fingerprint: [
      accountSettingsLifetimeToken,
      selectedAccountScopeKey,
      'connectedAccount',
      JSON.stringify(resolved.selection.target),
      contributionKey(effectiveAccount.data.service),
      effectiveAccount.data.accountId,
    ].join('\0'),
  });
}

function assertDeclaredTuple(
  selected: SelectedSource,
  binding: PluginRawCredentialMaterializerBinding,
  request: VoiceRawCredentialMaterializationRequest,
): void {
  const key = requestKey(request);
  const declared = selected.source.rawGrants?.some((grant) => (
    grant.realm === binding.realm
    && grant.phase === binding.phase
    && requestKey(grant.request) === key
  ));
  if (!declared) throw new UndeclaredRawCredentialTuple();
}

function sameAuthorization(left: Authorization, right: Authorization): boolean {
  return left.selected.fingerprint === right.selected.fingerprint
    && JSON.stringify(left.subject) === JSON.stringify(right.subject)
    && left.authoritySource.machineId === right.authoritySource.machineId
    && left.authoritySource.installationId === right.authoritySource.installationId;
}

function exactStringRecord(
  raw: unknown,
  expectedKeys: readonly string[],
  normalizeKey: (key: string) => string,
): Readonly<Record<string, string>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throwInvalidConnectedAccountMaterialization();
  }
  const entries = Object.entries(raw);
  const normalized = new Map<string, string>();
  for (const [key, value] of entries) {
    if (typeof value !== 'string') throwInvalidConnectedAccountMaterialization();
    const normalizedKey = normalizeKey(key);
    if (normalized.has(normalizedKey)) throwInvalidConnectedAccountMaterialization();
    normalized.set(normalizedKey, value);
  }
  const expected = [...expectedKeys].map(normalizeKey).sort();
  if (JSON.stringify([...normalized.keys()].sort()) !== JSON.stringify(expected)) {
    throwInvalidConnectedAccountMaterialization();
  }
  return Object.freeze(Object.fromEntries(normalized));
}

function exactConnectedMaterialization(
  request: VoiceRawCredentialMaterializationRequest,
  result: VoiceRawCredentialMaterialization,
): VoiceRawCredentialMaterialization {
  if (request.kind !== result.kind) throwInvalidConnectedAccountMaterialization();
  if (request.kind === 'httpHeaders' && result.kind === 'httpHeaders') {
    return Object.freeze({
      kind: 'httpHeaders',
      headers: exactStringRecord(result.headers, request.headerNames, (key) => key.toLowerCase()),
    });
  }
  if (request.kind === 'environment' && result.kind === 'environment') {
    return Object.freeze({
      kind: 'environment',
      env: exactStringRecord(result.env, request.keys, (key) => key),
    });
  }
  if (request.kind === 'files' && result.kind === 'files') {
    const keys = Object.keys(result.files).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...request.fileIds].sort())) {
      throwInvalidConnectedAccountMaterialization();
    }
    if (!Object.values(result.files).every((value) => value instanceof Uint8Array)) {
      throwInvalidConnectedAccountMaterialization();
    }
    return Object.freeze({
      kind: 'files',
      files: Object.freeze(Object.fromEntries(
        Object.entries(result.files).map(([fileId, bytes]) => [fileId, new Uint8Array(bytes)]),
      )),
    });
  }
  throwInvalidConnectedAccountMaterialization();
}

function materializeSavedSecret(
  request: VoiceRawCredentialMaterializationRequest,
  secret: string,
): VoiceRawCredentialMaterialization {
  if (request.kind === 'httpHeaders') {
    return Object.freeze({
      kind: 'httpHeaders',
      headers: Object.freeze(Object.fromEntries(request.headerNames.map((name) => [name, secret]))),
    });
  }
  if (request.kind === 'environment') {
    return Object.freeze({
      kind: 'environment',
      env: Object.freeze(Object.fromEntries(request.keys.map((key) => [key, secret]))),
    });
  }
  const bytes = new TextEncoder().encode(secret);
  return Object.freeze({
    kind: 'files',
    files: Object.freeze(Object.fromEntries(request.fileIds.map((fileId) => [
      fileId,
      new Uint8Array(bytes),
    ]))),
  });
}

async function materializeCurrentSavedSecret(input: Readonly<{
  binding: PluginRawCredentialMaterializerBinding;
  authority: DeclarationAuthority;
  before: Authorization;
  request: VoiceRawCredentialMaterializationRequest;
  getSnapshot: () => ActiveAccountSettingsSnapshot | null;
  getAccountSettingsSnapshotLifetimeToken: () => number;
  connectedAccounts: Pick<StablePluginConnectedAccountsOwner, 'getBinding'> | undefined;
  signal: AbortSignal;
}>): Promise<VoiceRawCredentialMaterialization> {
  const snapshot = input.getSnapshot();
  const current = await selectedSourceFromSnapshot(
    input.binding,
    input.authority,
    input.connectedAccounts,
    snapshot,
    input.getAccountSettingsSnapshotLifetimeToken(),
    input.signal,
  );
  if (
    current.fingerprint !== input.before.selected.fingerprint
    || current.source.kind !== 'savedSecret'
    || !current.savedSecretCustody
  ) {
    throw unavailable();
  }
  const encryptedValue = indexSavedSecretsByIdFromAccountSettings(
    current.savedSecretCustody.snapshot.settings,
  ).get(current.savedSecretCustody.secretId);
  if (!encryptedValue) throw unavailable();
  let secret: string | null = null;
  try {
    secret = decryptSecretValueWithKeysV1(
      encryptedValue,
      current.savedSecretCustody.snapshot.settingsSecretsReadKeys,
    );
  } catch {
    throw unavailable();
  }
  if (secret === null) throw unavailable();
  return materializeSavedSecret(input.request, secret);
}

type RawCredentialAuthorizationDependencies = Readonly<{
  binding: PluginRawCredentialMaterializerBinding;
  currentInstallReviewPrincipal: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource: CurrentPluginPermissionGrantAuthoritySourceReader;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding'>;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  getAccountSettingsSnapshotLifetimeToken: () => number;
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>;

async function readSelectedSource(
  input: RawCredentialAuthorizationDependencies,
  authority: DeclarationAuthority,
  signal: AbortSignal,
  allowWarm: boolean,
): Promise<SelectedSource> {
  let snapshot = input.getAccountSettingsSnapshot();
  if (!snapshot && allowWarm && input.ensureAccountSettingsSnapshot) {
    await input.ensureAccountSettingsSnapshot();
    signal.throwIfAborted();
    assertRuntimeCurrent(input.binding);
    snapshot = input.getAccountSettingsSnapshot();
  }
  const accountSettingsLifetimeToken = input.getAccountSettingsSnapshotLifetimeToken();
  return await selectedSourceFromSnapshot(
    input.binding,
    authority,
    input.connectedAccounts,
    snapshot,
    accountSettingsLifetimeToken,
    signal,
  );
}

function permissionSubject(
  binding: PluginRawCredentialMaterializerBinding,
  authority: DeclarationAuthority,
  selected: SelectedSource,
  principal: CurrentPluginInstallReviewPrincipal,
  request: VoiceRawCredentialMaterializationRequest,
): ReturnType<typeof PluginPermissionSubjectV1Schema.parse> {
  const canonical = canonicalRequest(request);
  const exactRawAccessDigest = selectedRawAccessDigest(binding, canonical);
  const exactAccessDeclarationDigest = CredentialAccessDeclarationDigestSchema.parse(digest(
    DECLARATION_DIGEST_DOMAIN,
    Object.freeze({
      v: 1,
      sourceClass: sourceDisclosureClass(binding.manifest.id, selected.source),
      realm: binding.realm,
      phase: binding.phase,
      request: canonical,
    }),
  ));
  return PluginPermissionSubjectV1Schema.parse({
    kind: 'credential_access_disclosure',
    contribution: authority.identity.contribution,
    credentialSlotId: PluginCredentialAccessSlotIdSchema.parse(
      authority.identity.credentialSlotId,
    ),
    purpose: authority.identity.purpose.purpose,
    accessDeclarationDigest: exactAccessDeclarationDigest,
    selectedAuthorityDigest: selected.selectedAuthorityDigest,
    selectedRawAccessDigest: exactRawAccessDigest,
    installedGenerationId: PluginPermissionInstalledGenerationIdSchema.parse(
      binding.immutableGenerationId,
    ),
    installReviewPrincipalDigest: principal.digest,
  });
}

type CurrentAuthorizationInspection = Readonly<{
  authorization: Authorization;
  inspection: PluginRawCredentialAuthorizationInspection;
}>;

async function inspectCurrentAuthorization(
  input: RawCredentialAuthorizationDependencies,
  authority: DeclarationAuthority,
  signal: AbortSignal,
  allowWarm: boolean,
  request: VoiceRawCredentialMaterializationRequest,
): Promise<CurrentAuthorizationInspection> {
  signal.throwIfAborted();
  assertRuntimeCurrent(input.binding);
  // The selected source and the install-review principal come from two stores,
  // so the composite is read inside one selected-source bracket: the principal
  // is read once, between two reads of the selection that must still agree.
  // Re-reading the principal itself would bracket nothing — no authorization
  // step runs between two adjacent reads of the same registry snapshot — and
  // every effect this inspection feeds is already re-inspected against a fresh
  // read by `authorize` around the grant list and by `materialize` around the
  // credential use.
  const firstSelected = await readSelectedSource(input, authority, signal, allowWarm);
  assertDeclaredTuple(firstSelected, input.binding, request);
  signal.throwIfAborted();
  assertRuntimeCurrent(input.binding);
  const principal = await input.currentInstallReviewPrincipal.readCurrent({
    pluginId: input.binding.manifest.id,
    signal,
  });
  signal.throwIfAborted();
  assertRuntimeCurrent(input.binding);
  const currentSelected = await readSelectedSource(input, authority, signal, false);
  signal.throwIfAborted();
  assertRuntimeCurrent(input.binding);
  if (!principal || currentSelected.fingerprint !== firstSelected.fingerprint) {
    throw unavailable();
  }
  const authoritySource = await input.readCurrentGrantAuthoritySource();
  signal.throwIfAborted();
  assertRuntimeCurrent(input.binding);
  if (authoritySource?.kind !== 'machine_installation') throw unavailable();
  const parsedSubject = permissionSubject(
    input.binding,
    authority,
    firstSelected,
    principal,
    request,
  );
  if (parsedSubject.kind !== 'credential_access_disclosure') throw unavailable();
  const subject = Object.freeze({
    ...parsedSubject,
    contribution: Object.freeze({ ...parsedSubject.contribution }),
  });
  const authorization = Object.freeze({
    selected: firstSelected,
    subject,
    authoritySource: Object.freeze({ ...authoritySource }),
  });
  return Object.freeze({
    authorization,
    inspection: Object.freeze({
      pluginId: input.binding.manifest.id,
      capability: RAW_CREDENTIAL_CAPABILITY,
      targetScope: ACCOUNT_TARGET_SCOPE,
      subject,
      authoritySource: authorization.authoritySource,
      disclosures: exactDisclosureRows(
        input.binding.manifest.id,
        firstSelected.source,
        input.binding,
        request,
      ),
    }),
  });
}

function createAuthorizationInspector(
  input: RawCredentialAuthorizationDependencies,
  authority: DeclarationAuthority,
): PluginRawCredentialAuthorizationInspector {
  return Object.freeze({
    async inspectAuthorization(request, options = {}) {
      const signal = options.signal ?? new AbortController().signal;
      try {
        return (await inspectCurrentAuthorization(
          input,
          authority,
          signal,
          true,
          canonicalRequest(request),
        )).inspection;
      } catch {
        signal.throwIfAborted();
        throw unavailable();
      }
    },
  });
}

export function createPluginRawCredentialAuthorizationInspector(input: Readonly<{
  binding: PluginRawCredentialMaterializerBinding;
  currentInstallReviewPrincipal: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource: CurrentPluginPermissionGrantAuthoritySourceReader;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding'>;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  getAccountSettingsSnapshotLifetimeToken?: () => number;
  /** Joins the canonical daemon snapshot warm only before initial source admission. */
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>): PluginRawCredentialAuthorizationInspector {
  return createAuthorizationInspector({
    ...input,
    getAccountSettingsSnapshot: input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot,
    getAccountSettingsSnapshotLifetimeToken:
      input.getAccountSettingsSnapshotLifetimeToken
      ?? getActiveAccountSettingsSnapshotLifetimeToken,
  }, deriveDeclarationAuthority(input.binding));
}

export function createPluginRawCredentialMaterializer(input: Readonly<{
  binding: PluginRawCredentialMaterializerBinding;
  currentInstallReviewPrincipal: CurrentPluginInstallReviewPrincipalReader;
  readCurrentGrantAuthoritySource: CurrentPluginPermissionGrantAuthoritySourceReader;
  grants: PluginPermissionGrantListReader;
  connectedAccounts?: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'materialize'>;
  getAccountSettingsSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  getAccountSettingsSnapshotLifetimeToken?: () => number;
  /** Joins the canonical daemon snapshot warm only before initial source admission. */
  ensureAccountSettingsSnapshot?: () => Promise<void>;
}>): PluginRawCredentialMaterializer {
  const authority = deriveDeclarationAuthority(input.binding);
  const getSnapshot = input.getAccountSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
  const getSnapshotLifetimeToken = input.getAccountSettingsSnapshotLifetimeToken
    ?? getActiveAccountSettingsSnapshotLifetimeToken;
  const authorizationDependencies: RawCredentialAuthorizationDependencies = Object.freeze({
    binding: input.binding,
    currentInstallReviewPrincipal: input.currentInstallReviewPrincipal,
    readCurrentGrantAuthoritySource: input.readCurrentGrantAuthoritySource,
    ...(input.connectedAccounts ? { connectedAccounts: input.connectedAccounts } : {}),
    getAccountSettingsSnapshot: getSnapshot,
    getAccountSettingsSnapshotLifetimeToken: getSnapshotLifetimeToken,
    ...(input.ensureAccountSettingsSnapshot
      ? { ensureAccountSettingsSnapshot: input.ensureAccountSettingsSnapshot }
      : {}),
  });
  const authorizationInspector = createAuthorizationInspector(authorizationDependencies, authority);

  const authorize = async (
    request: VoiceRawCredentialMaterializationRequest,
    signal: AbortSignal,
  ): Promise<Authorization> => {
    signal.throwIfAborted();
    assertRuntimeCurrent(input.binding);
    const caller = PluginMachineMaterializationRefV1Schema.safeParse(
      input.binding.materialization,
    );
    if (
      !caller.success
      || caller.data.pluginId !== input.binding.manifest.id
      || (
        input.binding.machineId !== null
        && caller.data.machineId !== input.binding.machineId
      )
    ) {
      throw unavailable();
    }
    const inspected = await inspectCurrentAuthorization(
      authorizationDependencies,
      authority,
      signal,
      true,
      request,
    );
    const { subject } = inspected.authorization;
    const currentAuthoritySource = inspected.authorization.authoritySource;
    if (subject.kind !== 'credential_access_disclosure') throw unavailable();
    const listInput = PluginPermissionGrantListActionInputV1Schema.parse({
      pluginId: input.binding.manifest.id,
      capability: RAW_CREDENTIAL_CAPABILITY,
      targetScope: ACCOUNT_TARGET_SCOPE,
      subject,
      caller: caller.data,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
    });
    const listed = PluginPermissionGrantListActionOutputV1Schema.parse(
      await input.grants.list(listInput, { signal }),
    );
    signal.throwIfAborted();
    assertRuntimeCurrent(input.binding);
    const current = await inspectCurrentAuthorization(
      authorizationDependencies,
      authority,
      signal,
      false,
      request,
    );
    if (
      !sameAuthorization(inspected.authorization, current.authorization)
    ) {
      throw unavailable();
    }
    if (!listed.grants.some((grant) => evaluatePluginPermissionGrant({
      grant,
      pluginId: input.binding.manifest.id,
      capability: RAW_CREDENTIAL_CAPABILITY,
      targetScope: ACCOUNT_TARGET_SCOPE,
      subject,
      currentAuthoritySource,
      currentInstallReviewPrincipalDigest: subject.installReviewPrincipalDigest,
    }))) {
      throw unavailable();
    }
    return inspected.authorization;
  };

  return Object.freeze({
    inspectAuthorization: authorizationInspector.inspectAuthorization,
    async materialize(rawRequest, options = {}) {
      const request = canonicalRequest(rawRequest);
      const signal = options.signal ?? new AbortController().signal;
      let before: Authorization;
      try {
        before = await authorize(request, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof UndeclaredRawCredentialTuple) throw invalidRequest();
        throw unavailable();
      }
      let result: VoiceRawCredentialMaterialization | null = null;
      let connectedAccountResultInvalid = false;
      let capturedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
      let callbackCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
      if (before.selected.source.kind === 'savedSecret') {
        const custody = before.selected.savedSecretCustody;
        if (!custody) throw unavailable();
        callbackCredentialRevision = custody.callbackCredentialRevision;
        if (
          options.credentialRevisionBasis?.expectedCredentialRevision !== null
          && options.credentialRevisionBasis?.expectedCredentialRevision !== undefined
          && callbackCredentialRevision !== options.credentialRevisionBasis.expectedCredentialRevision
        ) throw unavailable();
        result = await materializeCurrentSavedSecret({
          binding: input.binding,
          authority,
          before,
          request,
          getSnapshot,
          getAccountSettingsSnapshotLifetimeToken: getSnapshotLifetimeToken,
          connectedAccounts: input.connectedAccounts,
          signal,
        });
      } else {
        const serviceRef = before.selected.qualifiedConnectedAccountService;
        const connectedAccounts = input.connectedAccounts;
        if (!serviceRef || !connectedAccounts) throw unavailable();
        let produced: VoiceRawCredentialMaterialization;
        try {
          produced = await connectedAccounts.materialize({
            purpose: authority.identity.purpose,
            serviceRefs: Object.freeze([{ ...serviceRef }]),
            ...(before.selected.expectedConnectedAccount
              ? { expectedAccount: before.selected.expectedConnectedAccount }
              : {}),
            ...(options.credentialRevisionBasis
              ? {
                  credentialRevisionBasis: Object.freeze({
                    expectedCredentialRevision:
                      options.credentialRevisionBasis.expectedCredentialRevision,
                    captureCredentialRevision(credentialRevision) {
                      capturedCredentialRevision = credentialRevision;
                    },
                  }),
                }
              : {}),
            request,
            signal,
          });
        } catch {
          signal.throwIfAborted();
          try {
            const current = await authorize(request, signal);
            if (!sameAuthorization(before, current)) throw unavailable();
          } catch {
            signal.throwIfAborted();
            throw unavailable();
          }
          throw providerOperationFailed();
        }
        signal.throwIfAborted();
        try {
          result = exactConnectedMaterialization(request, produced);
          callbackCredentialRevision = capturedCredentialRevision;
        } catch {
          signal.throwIfAborted();
          connectedAccountResultInvalid = true;
        }
      }
      let after: Authorization;
      try {
        after = await authorize(request, signal);
      } catch {
        signal.throwIfAborted();
        throw unavailable();
      }
      if (!sameAuthorization(before, after)) throw unavailable();
      if (connectedAccountResultInvalid) throw invalidRequest();
      if (!result) throw providerOperationFailed();
      if (options.credentialRevisionBasis) {
        if (callbackCredentialRevision === null) throw unavailable();
        if (
          options.credentialRevisionBasis.expectedCredentialRevision !== null
          && callbackCredentialRevision
            !== options.credentialRevisionBasis.expectedCredentialRevision
        ) {
          throw unavailable();
        }
        options.credentialRevisionBasis.captureCredentialRevision(
          callbackCredentialRevision,
        );
      }
      return result;
    },
  });
}
