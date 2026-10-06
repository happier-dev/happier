import type { VoiceCredentialBindingIdentityV1, VoiceCredentialSourceSelection } from '@happier-dev/protocol';
import { resolveAccountSettingsVoiceCredentialSource } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  createSavedSecretMaterializerFromSnapshotV1,
  type SavedSecretResolutionV1,
} from '@/settings/secrets/savedSecretCatalog';
import {
  SavedSecretOperationAdmissionError,
  savedSecretOperationAdmissionStatus,
  refreshSavedSecretCatalogForOperation,
} from '@/settings/secrets/hydrateSavedSecretCatalog';

export type VoiceCredentialResolutionSource = 'account' | 'machine_override';

type VoiceCredentialReference = Readonly<{
  secretId: string;
  source: VoiceCredentialResolutionSource;
  materialFingerprint: string;
  /** Retained only for unscoped snapshots, which cannot prove Account identity. */
  snapshot: ActiveAccountSettingsSnapshot;
}>;

export type VoiceCredentialMaterialStatus = SavedSecretResolutionV1['status'];

type VoiceCredentialReferenceInspection =
  | Readonly<{ status: 'ready'; reference: VoiceCredentialReference }>
  | Readonly<{ status: Exclude<VoiceCredentialMaterialStatus, 'ready'> }>;

export type VoiceCredentialResolver = Readonly<{
  /** Current Account-settings source selection before any secret materialization. */
  resolveSelectedSource(identity: VoiceCredentialBindingIdentityV1): VoiceCredentialSourceSelection | null;
  status(identity: VoiceCredentialBindingIdentityV1): Readonly<{
    available: boolean;
    source: VoiceCredentialResolutionSource | null;
    materialStatus: VoiceCredentialMaterialStatus;
  }>;
  withSecret<T>(params: Readonly<{
    identity: VoiceCredentialBindingIdentityV1;
    recipientContractDigest?: string;
    use: (secret: string) => Promise<T>;
  }>): Promise<T>;
}>;

function unavailable(materialStatus: Exclude<VoiceCredentialMaterialStatus, 'ready'> = 'missing'):
  Error & {
    code: 'credential_unavailable';
    materialStatus: Exclude<VoiceCredentialMaterialStatus, 'ready'>;
    admissionReason?: SavedSecretOperationAdmissionError['reason'];
  } {
  return Object.assign(new Error('credential_unavailable'), {
    code: 'credential_unavailable' as const,
    materialStatus,
  });
}

/**
 * Resolve the SavedSecret this Voice target may use right now.
 *
 * The selected credential source is owned by Account Settings: a target whose
 * source is `none` or `connectedAccount` deliberately keeps its dormant
 * SavedSecret bindings, so only the canonical resolution may decide that the
 * saved-secret arm is the effective one. Any invalid or ambiguous stored shape
 * fails closed rather than falling back to a raw binding read.
 */
function inspectReference(params: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
  identity: VoiceCredentialBindingIdentityV1;
  recipientContractDigest?: string;
}>): VoiceCredentialReferenceInspection {
  if (!params.snapshot) return { status: 'missing' };
  let resolved: ReturnType<typeof resolveAccountSettingsVoiceCredentialSource>;
  try {
    resolved = resolveAccountSettingsVoiceCredentialSource(
      params.snapshot.settings as unknown as Readonly<Record<string, unknown>>,
      {
        contribution: params.identity.contribution,
        credentialSlotId: params.identity.credentialSlotId,
        purpose: params.identity.purpose,
        machineId: params.machineId,
      },
    );
  } catch {
    return { status: 'missing' };
  }
  if (resolved.selection.kind !== 'savedSecret' || !resolved.savedSecret) return { status: 'missing' };
  if (
    params.recipientContractDigest
    && resolved.approvedRecipientContractDigest !== params.recipientContractDigest
  ) {
    return { status: 'missing' };
  }
  const secretId = resolved.savedSecret.secretId;
  const inspected = createSavedSecretMaterializerFromSnapshotV1(params.snapshot).inspect(secretId);
  if (inspected.status !== 'ready') return inspected;
  return {
    status: 'ready',
    reference: Object.freeze({
      secretId,
      source: resolved.savedSecret.source,
      materialFingerprint: inspected.fingerprint,
      snapshot: params.snapshot,
    }),
  };
}

/**
 * A Settings version is the whole-document CAS revision, so unrelated Account
 * settings writes advance it.  This resolver instead fences the exact
 * selected SavedSecret record and source.  Unscoped snapshots cannot prove
 * they belong to the same Account and therefore retain the stricter identity
 * check; Account-lifetime changes are fenced separately by the publisher.
 */
function sameCredentialReference(
  before: VoiceCredentialReference,
  after: VoiceCredentialReference,
): boolean {
  const beforeScopeKey = before.snapshot.scopeKey;
  const afterScopeKey = after.snapshot.scopeKey;
  if (beforeScopeKey === undefined || afterScopeKey === undefined) {
    return before.snapshot === after.snapshot;
  }
  return beforeScopeKey === afterScopeKey
    && before.secretId === after.secretId
    && before.source === after.source
    && before.materialFingerprint === after.materialFingerprint;
}

function readSelectedSource(params: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
  identity: VoiceCredentialBindingIdentityV1;
}>): VoiceCredentialSourceSelection | null {
  if (!params.snapshot) return null;
  try {
    return resolveAccountSettingsVoiceCredentialSource(
      params.snapshot.settings as unknown as Readonly<Record<string, unknown>>,
      {
        contribution: params.identity.contribution,
        credentialSlotId: params.identity.credentialSlotId,
        purpose: params.identity.purpose,
        machineId: params.machineId,
      },
    ).selection;
  } catch {
    return null;
  }
}

/**
 * The Voice vocabulary for a refused operation admission.
 *
 * The admission owner speaks in reference reasons and this resolver speaks in
 * material statuses; only the translation lives here, never a second decision
 * about whether the reference is current.
 */
export function createVoiceCredentialResolver(params: Readonly<{
  /** Null selects the account-only client realm and deliberately ignores machine overrides. */
  machineId: string | null;
  getSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  getLifetimeToken?: () => number;
  /** The canonical operation-admission refresh; injectable for tests only. */
  refreshForOperation?: typeof refreshSavedSecretCatalogForOperation;
}>): VoiceCredentialResolver {
  const getSnapshot = params.getSnapshot ?? getActiveAccountSettingsSnapshot;
  const getLifetimeToken = params.getLifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken;
  const refreshForOperation = params.refreshForOperation ?? refreshSavedSecretCatalogForOperation;

  /**
   * Admit this Voice operation against Home-current shared material.
   *
   * A hydrated catalog row is not authorization for a *new* operation:
   * `AccountChange` is only a wake-up hint, so a revocation whose hint was
   * never delivered would otherwise let this operation use the old plaintext.
   * The batch refresh in `hydrateSavedSecretCatalog` is the single owner of
   * that decision, and it returns the cached snapshot untouched when the
   * operation's references are personal-only, so a personal-secret Voice
   * session still never touches the network.
   */
  async function admitOperation(
    snapshot: ActiveAccountSettingsSnapshot,
    ref: string,
  ): Promise<ActiveAccountSettingsSnapshot> {
    const expectedScopeKey = snapshot.scopeKey;
    if (expectedScopeKey === undefined) return snapshot;
    try {
      return await refreshForOperation({ expectedScopeKey, references: [{ ref }] });
    } catch (error) {
      if (error instanceof SavedSecretOperationAdmissionError) {
        throw Object.assign(
          unavailable(savedSecretOperationAdmissionStatus(error.reason)),
          { admissionReason: error.reason },
        );
      }
      throw unavailable('temporarily_unavailable');
    }
  }

  return Object.freeze({
    resolveSelectedSource(identity) {
      return identity
        ? readSelectedSource({
            snapshot: getSnapshot(),
            machineId: params.machineId,
            identity,
          })
        : null;
    },
    status(identity) {
      const inspected = identity
        ? inspectReference({ snapshot: getSnapshot(), machineId: params.machineId, identity })
        : { status: 'missing' as const };
      return inspected.status === 'ready'
        ? { available: true, source: inspected.reference.source, materialStatus: 'ready' }
        : { available: false, source: null, materialStatus: inspected.status };
    },
    async withSecret<T>(input: Readonly<{
      identity: VoiceCredentialBindingIdentityV1;
      recipientContractDigest?: string;
      use: (secret: string) => Promise<T>;
    }>): Promise<T> {
      if (!input.identity) throw unavailable();
      const snapshot = getSnapshot();
      const lifetimeToken = getLifetimeToken();
      const inspected = inspectReference({
        snapshot,
        machineId: params.machineId,
        identity: input.identity,
        ...(input.recipientContractDigest
          ? { recipientContractDigest: input.recipientContractDigest }
          : {}),
      });
      if (!snapshot) throw unavailable();
      if (inspected.status !== 'ready') throw unavailable(inspected.status);
      const admittedSnapshot = await admitOperation(snapshot, inspected.reference.secretId);
      const admittedInspection = admittedSnapshot === snapshot
        ? inspected
        : inspectReference({
            snapshot: admittedSnapshot,
            machineId: params.machineId,
            identity: input.identity,
            ...(input.recipientContractDigest
              ? { recipientContractDigest: input.recipientContractDigest }
              : {}),
          });
      if (admittedInspection.status !== 'ready') throw unavailable(admittedInspection.status);
      const resolved = admittedInspection.reference;
      // The SavedSecret catalog is the only owner of "the material behind this
      // fingerprint moved"; ask it rather than re-deciding drift locally.
      const material = createSavedSecretMaterializerFromSnapshotV1(admittedSnapshot)
        .recheck(resolved.secretId, resolved.materialFingerprint);
      if (material.status !== 'ready') throw unavailable(material.status);
      const result = await input.use(material.value);
      const currentSnapshot = getSnapshot();
      const currentInspection = inspectReference({
        snapshot: currentSnapshot,
        machineId: params.machineId,
        identity: input.identity,
        ...(input.recipientContractDigest
          ? { recipientContractDigest: input.recipientContractDigest }
          : {}),
      });
      // A client artifact minted from a superseded selected credential must
      // not escape after an Account switch, source change, removal, rotation,
      // or recipient-approval change. Account Settings' whole-document CAS
      // version is deliberately not an authority fence here.
      if (
        getLifetimeToken() !== lifetimeToken
        || !currentSnapshot
        || currentInspection.status !== 'ready'
        || !sameCredentialReference(resolved, currentInspection.reference)
      ) {
        throw unavailable(currentInspection.status === 'ready' ? 'repair_required' : currentInspection.status);
      }
      const rechecked = createSavedSecretMaterializerFromSnapshotV1(currentSnapshot)
        .recheck(resolved.secretId, resolved.materialFingerprint);
      if (rechecked.status !== 'ready') throw unavailable(rechecked.status);
      return result;
    },
  });
}
