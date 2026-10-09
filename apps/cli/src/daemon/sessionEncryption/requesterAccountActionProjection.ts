import { randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1,
  type ExternalActionRequesterAccountProjectionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { fetchAccountProfile } from '@/api/accountProfile';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolvePublishedMachineEncryptionContext } from '@/api/machine/machineDataEncryptionKey';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1,
  type ExternalActionRequesterAccountContextPurposeV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import type { PrepareExternalActionRequesterAccountContext, ResolveExternalActionEncryption } from '../externalActions/executeExternalAction';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

export type RequesterAccountActionAuthorizationInput = Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  /** Observed stable identity for the admitted bootstrap's exact Home. */
  serverIdentityId: string;
  bootstrap: Pick<AdmittedRequesterSessionBootstrap,
    'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'isCurrent'> & Partial<Pick<AdmittedRequesterSessionBootstrap, 'getBoundSessionId'>>;
  signal?: AbortSignal;
}>;

/** Projects already-admitted custody; it neither mints authority nor reads a global Account snapshot. */
export async function projectRequesterAccountActionAuthorization(
  input: RequesterAccountActionAuthorizationInput,
): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  const { bootstrap } = input;
  const stamp = bootstrap.attribution;
  const source = parsed.success ? parsed.data.binding.sessionActionSource : undefined;
  const origin = parsed.success ? parsed.data.binding.sessionActionOrigin : undefined;
  const exactSource = source?.machineId === stamp.machineId && source.installationId === stamp.installationId
    && origin?.caller.kind === 'session' && bootstrap.getBoundSessionId?.() === origin.caller.sessionId;
  const handoff = parsed.success ? parsed.data.binding.handoffAdmission : undefined;
  const exactHandoffTarget = parsed.success && parsed.data.binding.handoffContinuation !== undefined && handoff !== undefined
    && handoff.targetMachineId === stamp.machineId && handoff.targetInstallationId === stamp.installationId
    && parsed.data.binding.machineId === stamp.machineId && parsed.data.binding.installationId === stamp.installationId
    && bootstrap.getBoundSessionId?.() === handoff.sessionId;
  if (!parsed.success || input.signal?.aborted
    || parsed.data.binding.accountId !== stamp.accountId
    || (source || origin ? !exactSource && !exactHandoffTarget : parsed.data.binding.machineId !== stamp.machineId
      || parsed.data.binding.installationId !== stamp.installationId)
    || parsed.data.binding.serverIdentityId !== input.serverIdentityId) return null;
  return await projectAdmittedAccountCustody(input);
}

/** Both admitted owners use these same Account ports; Session provenance stays in its caller guard. */
async function projectAdmittedAccountCustody(input: RequesterAccountActionAuthorizationInput): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  const { bootstrap } = input;
  const stamp = bootstrap.attribution;
  if (!parsed.success) return null;
  try {
    if (!await bootstrap.isCurrent() || input.signal?.aborted) return null;
    const currentness = await fetchAccountEncryptionCurrentness({ token: bootstrap.credentials.token,
      serverBaseUrl: bootstrap.serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) });
    const encryption = bootstrap.credentials.encryption;
    if (parsed.data.binding.accountEncryptionMode !== undefined
      && parsed.data.binding.accountEncryptionMode !== currentness.mode
      || currentness.mode === 'e2ee' && !encryption
      || !await bootstrap.isCurrent() || input.signal?.aborted) return null;
    const material: AccountScopedCryptoMaterial | null = currentness.mode === 'plain' ? null : encryption?.type === 'legacy'
        ? { type: 'legacy', secret: new Uint8Array(encryption.secret) }
        : encryption ? { type: 'dataKey', machineKey: new Uint8Array(encryption.machineKey) } : null;
    const cipher = createProjectAccountRowCipherV1({ mode: currentness.mode,
      material,
      randomBytes: length => new Uint8Array(randomBytes(length)) });
    const isCurrent = async (): Promise<boolean> => {
      try {
        if (input.signal?.aborted || !await bootstrap.isCurrent()) return false;
        const next = await fetchAccountEncryptionCurrentness({ token: bootstrap.credentials.token,
          serverBaseUrl: bootstrap.serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) });
        return next.mode === currentness.mode && next.version === currentness.version
          && next.signingKeyFingerprint === currentness.signingKeyFingerprint
          && next.contentKeyFingerprint === currentness.contentKeyFingerprint
          && !input.signal?.aborted && await bootstrap.isCurrent();
      } catch { return false; }
    };
    // Loaded only when a real admitted invocation asks for private Account ports.
    const { createCredentialedAccountArtifactStore } = await import('@/api/artifacts/accountArtifactStore');
    const artifacts = createCredentialedAccountArtifactStore(bootstrap.credentials);
    const { createProjectSetupTrustRowCipher } = await import('@/workspaces/projectSetup/projectSetupTrust');
    const { createAuthoringMemoryRowCipher } = await import('@/settings/authoringMemory/createAuthoringMemoryClient');
    const { projectAccountArtifactToPromptLibraryStoredArtifact } = await import('@/session/actions/approvals/artifactStore');
    const projection: ExternalActionRequesterAccountProjectionV1 = Object.freeze({
      accountId: stamp.accountId, serverId: stamp.serverId,
      accountEncryptionMode: currentness.mode, projectAccountRowCipher: cipher, isCurrent,
      projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode: currentness.mode, material }),
      authoringMemoryRowCipher: createAuthoringMemoryRowCipher({ accountMode: currentness.mode, material }),
      sealRequesterAccountContext: async request => {
        if (request.authorization.binding.accountId !== stamp.accountId
          || request.authorization.binding.serverIdentityId !== input.serverIdentityId || !await isCurrent()) return null;
        try {
          const sealed = sealExternalActionRequesterAccountContextV1({ ...request,
            credentials: { ...encodeStoredCredentials(bootstrap.credentials), token: bootstrap.credentials.token },
            randomBytes: length => new Uint8Array(randomBytes(length)) });
          return await isCurrent() ? sealed : null;
        } catch { return null; }
      },
      resolveMachineContentEncryptionContext: row => {
        const context = resolvePublishedMachineEncryptionContext({ credentials: bootstrap.credentials,
          machineId: row.id, expectedAccountMode: row.access?.resourceMode ?? row.storageMode ?? currentness.mode,
          access: row.access, publishedDataEncryptionKey: row.dataEncryptionKey, machineKind: row.kind,
          installationId: row.installationId, runnerContentKeyBinding: row.runnerContentKeyBinding });
        return context.encryptionMode === 'plain' ? { encryptionMode: 'plain' as const }
          : { ...context, encryptionMode: 'e2ee' as const };
      },
      readArtifact: async (ref, options) => {
        if (ref.serverId !== stamp.serverId || options?.signal?.aborted || !await isCurrent()) return null;
        try {
          const artifact = await runWithServerHttpBaseUrl(bootstrap.serverHttpBaseUrl,
            () => artifacts.read(ref.artifactId, { ...options, includeSharedAudience: false }));
          if (!artifact || artifact.artifactId !== ref.artifactId
            || options?.signal?.aborted || !await isCurrent()) return null;
          const promptLibraryArtifact = projectAccountArtifactToPromptLibraryStoredArtifact(artifact);
          return { artifactId: artifact.artifactId, header: artifact.header,
            ...(promptLibraryArtifact ? { promptLibraryArtifact } : {}) };
        } catch { return null; }
      },
    });
    const carrier: ExternalActionExecutionAuthorizationV1 = { ...parsed.data };
    const requesterHttpProjection = input.authorization.requesterHttpProjection;
    if (requesterHttpProjection) {
      Object.defineProperty(carrier, 'requesterHttpProjection', {
        value: requesterHttpProjection, enumerable: false,
      });
    }
    // Private ports must not enter JSON, signed wire bodies, approval records,
    // logs, or RPC forwarding. Strict wire parsing also drops this local facet.
    Object.defineProperty(carrier, 'requesterAccountProjection', { value: projection, enumerable: false });
    return Object.freeze(carrier);
  } catch { return null; }
}

/** Finite Account custody at an admitted ingress, never a Session or a credential store. */
export type RequesterAccountActionContext = Readonly<{
  credentials: StoredCredentials;
  accountSettingsContext: AccountSettingsContext;
  savedSecretOperationContext: SavedSecretOperationContextV1;
  authorization: ExternalActionExecutionAuthorizationV1;
  serverHttpBaseUrl: string;
  resolveEncryption: ResolveExternalActionEncryption;
  isCurrent(): Promise<boolean>;
  refreshAccountSettings(signal?: AbortSignal): Promise<boolean>;
  retain(): () => Promise<void>;
  dispose(): Promise<void>;
}>;

export async function admitRequesterAccountActionContext(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  credentials: StoredCredentials;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<RequesterAccountActionContext | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success || parsed.data.binding.serverIdentityId !== input.serverIdentityId
    || input.signal?.aborted || !await input.isCurrent()) return null;
  let live = true;
  let references = 1;
  let ingressReleased = false;
  const release = async () => { if (--references === 0) live = false; };
  const retain = () => {
    if (!live) throw new Error('requester_account_context_retired');
    references += 1;
    let released = false;
    return async () => { if (!released) { released = true; await release(); } };
  };
  const isCurrent = async () => live && !input.signal?.aborted && await input.isCurrent();
  try {
    const [profile, currentness] = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => Promise.all([
      fetchAccountProfile({ token: input.credentials.token, ...(input.signal ? { signal: input.signal } : {}) }),
      fetchAccountEncryptionCurrentness({ token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl,
        ...(input.signal ? { signal: input.signal } : {}) }),
    ]));
    if (profile.id !== parsed.data.binding.accountId || parsed.data.binding.accountEncryptionMode !== currentness.mode
      || (currentness.mode === 'plain' ? input.credentials.encryption !== null : input.credentials.encryption === null)
      || !await isCurrent()) return null;
    if (currentness.mode === 'e2ee' && currentness.contentKeyFingerprint && input.credentials.encryption) {
      const encryption = input.credentials.encryption;
      const key = encryption.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret) : encryption.machineKey;
      if (computeContentPublicKeyFingerprint(tweetnacl.box.keyPair.fromSecretKey(key).publicKey) !== currentness.contentKeyFingerprint) return null;
    }
    bindRequesterSessionCredentialScope(input.credentials, { serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl });
    const accountSettingsContext = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
      credentials: input.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
      honorAccountSettingsModeEnv: false, minSettingsVersion: currentness.settingsVersion, shouldCommit: () => live && !input.signal?.aborted,
    }));
    if (accountSettingsContext.source !== 'network' || !await isCurrent()) return null;
    const { requesterAccountContext: _sealed, managedFiniteWake, ...root } = parsed.data;
    const wakeFacts = managedFiniteWake ? (() => {
      const { requesterAccountContext: _controllerSealed, ...facts } = managedFiniteWake;
      return facts;
    })() : undefined;
    const wire = { ...root, ...(wakeFacts ? { managedFiniteWake: wakeFacts } : {}) };
    const authorization = await projectAdmittedAccountCustody({ authorization: wire,
      serverIdentityId: input.serverIdentityId, bootstrap: {
      credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent,
      attribution: { serverId: input.serverId, accountId: profile.id, machineId: wire.binding.machineId,
        installationId: wire.binding.installationId },
    }, ...(input.signal ? { signal: input.signal } : {}) });
    if (!authorization || !await isCurrent()) return null;
    const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials: input.credentials,
      snapshot: accountSettingsContext, serverHttpBaseUrl: input.serverHttpBaseUrl,
      isCurrent: authorization.requesterAccountProjection!.isCurrent });
    const refreshAccountSettings = async (signal?: AbortSignal): Promise<boolean> => {
      try {
        if (signal?.aborted || !await authorization.requesterAccountProjection!.isCurrent()) return false;
        const previous = savedSecretOperationContext.readSnapshot();
        if (!previous) return false;
        const next = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
          credentials: input.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation',
          honorAccountSettingsModeEnv: false, minSettingsVersion: previous.settingsVersion,
          shouldCommit: () => live && !input.signal?.aborted && !signal?.aborted,
        }));
        if (next.source !== 'network' || signal?.aborted
          || !await authorization.requesterAccountProjection!.isCurrent()) return false;
        return await savedSecretOperationContext.replaceAccountSettings(next)
          && !signal?.aborted && await authorization.requesterAccountProjection!.isCurrent();
      } catch { return false; }
    };
    const resolveEncryption: ResolveExternalActionEncryption = async signal => {
      if (signal?.aborted || !await authorization.requesterAccountProjection!.isCurrent() || !input.credentials.encryption) return null;
      const encryption = input.credentials.encryption;
      return { serverIdentityId: input.serverIdentityId, material: encryption.type === 'legacy'
        ? { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(encryption.secret) }
        : encryption };
    };
    return Object.freeze({ credentials: input.credentials, accountSettingsContext, savedSecretOperationContext, authorization, resolveEncryption,
      refreshAccountSettings,
      serverHttpBaseUrl: input.serverHttpBaseUrl,
      isCurrent: authorization.requesterAccountProjection!.isCurrent,
      retain,
      dispose: async () => { if (!ingressReleased) { ingressReleased = true; await release(); } },
    });
  } catch { live = false; return null; }
}

/** One installed ingress for both existing Action and Machine-RPC authorization carriers. */
export async function prepareRequesterAccountActionContext(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  machineId: string;
  installationId: string;
  installationPrivateKey: Uint8Array;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  /** Host-owned custody only; never admitted from a public request or selected by Account id. */
  ownCredentials?: StoredCredentials;
  isCurrent(): Promise<boolean>;
  createExecutor(context: RequesterAccountActionContext): NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountExecutor']>;
  signal?: AbortSignal;
}>): ReturnType<PrepareExternalActionRequesterAccountContext> {
  if (input.signal?.aborted || !await input.isCurrent()) return null;
  const root = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!root.success || root.data.binding.serverIdentityId !== input.serverIdentityId) return null;
  const finiteWake = input.purpose.kind === 'managed_finite_wake' ? root.data.managedFiniteWake : undefined;
  if (input.purpose.kind === 'managed_finite_wake' && (!finiteWake
    || !sameStrictJsonValue(finiteWake.target, input.purpose.target))) return null;
  const recipient = finiteWake?.target.controller ?? { machineId: root.data.binding.machineId,
    installationId: root.data.binding.installationId };
  if (recipient.machineId !== input.machineId || recipient.installationId !== input.installationId) return null;
  const regularOwnAccount = 'authentication' in root.data.binding && root.data.binding.authentication.kind === 'account'
    && !root.data.binding.sessionActionOrigin && !root.data.binding.workflowActionOrigin
    && root.data.binding.accountId === root.data.binding.custodianAccountId;
  const hasBox = finiteWake ? Boolean(finiteWake.requesterAccountContext) : Boolean(root.data.requesterAccountContext);
  const encoded = hasBox ? openExternalActionRequesterAccountContextV1(input) : null;
  const credentials = hasBox
    ? encoded ? decodeStoredCredentials(encoded) : null
    : !finiteWake && regularOwnAccount ? input.ownCredentials : null;
  if (!credentials) return null;
  const admitted = await admitRequesterAccountActionContext({ ...input, credentials });
  if (!admitted) return null;
  try {
    // Named native preparation proves controller custody, not a generic HTTP
    // effect grant for the unchanged guest-targeted original Action.
    const projected = finiteWake ? admitted.authorization : await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
      serverId: input.serverId, serverIdentityId: input.serverIdentityId, serverHttpBaseUrl: input.serverHttpBaseUrl,
      target: admitted.authorization.binding.target, installationId: input.installationId,
      privateKey: input.installationPrivateKey, isCurrent: admitted.isCurrent,
      ...(input.signal ? { signal: input.signal } : {}) });
    if (!projected) { await admitted.dispose(); return null; }
    const executor = input.createExecutor(Object.freeze({ ...admitted, authorization: projected }));
    const authorization: ExternalActionExecutionAuthorizationV1 = { ...projected };
    for (const [key, value] of Object.entries({ requesterAccountProjection: projected.requesterAccountProjection,
      requesterHttpProjection: projected.requesterHttpProjection, requesterAccountExecutor: executor })) {
      if (value) Object.defineProperty(authorization, key, { value, enumerable: false });
    }
    return { authorization: Object.freeze(authorization), executor, dispose: admitted.dispose, resolveEncryption: admitted.resolveEncryption };
  } catch { await admitted.dispose(); return null; }
}
