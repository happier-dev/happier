import type { SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretResolutionFailureStatusV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation, SavedSecretOperationAdmissionError, savedSecretOperationAdmissionStatus } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

/** A verified physical target retained only by the current confidential invocation. */
export type ConfidentialSecretFillTarget = Readonly<{
  /** Established only by the actual managed producer, never by public request data. */
  nativeObservation?: 'not_observable';
  recheck(): Promise<boolean>;
  isSafe?(): Promise<boolean>;
  fill(value: Uint8Array, signal?: AbortSignal, beforeDelivery?: () => Promise<boolean>): Promise<SecretFillSettlementV1>;
  submit?(signal?: AbortSignal, beforeDelivery?: () => Promise<boolean>): Promise<NonNullable<Extract<SecretFillSettlementV1, { status: 'filled' }>['submit']>>;
  /** Cleanup does not release observation while the filled document can reveal material. */
  finish(): Promise<void>;
}>;

type ConfidentialFillArgs = Parameters<NonNullable<ActionExecutorDeps['confidentialSecretFill']>>[0];
type RefusalCode = Extract<SecretFillSettlementV1, { status: 'refused' }>['code'];
const refused = (code: RefusalCode): SecretFillSettlementV1 => ({ status: 'refused', code });
const catalogRefusal: Record<SavedSecretResolutionFailureStatusV1, RefusalCode> = {
  missing: 'saved_secret_missing', temporarily_unavailable: 'saved_secret_unavailable', forbidden: 'saved_secret_forbidden',
  repair_required: 'saved_secret_repair_required', deleted: 'saved_secret_deleted',
  mode_incompatible: 'saved_secret_mode_incompatible', corrupt: 'saved_secret_corrupt',
};

/** The existing Saved Secret catalog is the material authority; the physical owner supplies its hold. */
export function createConfidentialSecretFillExecutor(input: Readonly<{
  expectedScopeKey: string;
  /** Account whose existing snapshot/materializer this executor can consume. */
  expectedAccountId: string | null;
  serverId: string;
  machineId: string | (() => string | null);
  readHostIdentity?(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
  readAccountMode(signal?: AbortSignal): Promise<'plain' | 'e2ee'>;
  prepareTarget(args: Pick<ConfidentialFillArgs, 'actionId' | 'request' | 'context'>): Promise<ConfidentialSecretFillTarget | SecretFillSettlementV1>;
}>): NonNullable<ActionExecutorDeps['confidentialSecretFill']> {
  return async (args) => {
    const machineId = typeof input.machineId === 'function' ? input.machineId() : input.machineId;
    if (args.context.authority !== 'present_user') return refused('approval_required');
    // A personal reference is meaningful only in its deciding Account. Until a
    // requester-scoped catalog is supplied, never fall back to custodian material.
    if (args.choice.kind === 'saved'
      && (!input.expectedAccountId || args.context.runtimeAccountId !== input.expectedAccountId)) {
      return refused('saved_secret_forbidden');
    }
    const signal = args.context.signal;
    const hostIsCurrent = async () => {
      if (args.request.machineId !== machineId
        || (typeof input.machineId === 'function' ? input.machineId() : input.machineId) !== machineId) return false;
      if (!input.readHostIdentity) return args.request.serverId === input.serverId;
      const identity = await input.readHostIdentity(signal);
      return identity !== null && identity.machineId === machineId
        && identity.serverIdentityId === args.context.serverIdentityId;
    };
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const currentSnapshot = () => {
      const snapshot = getActiveAccountSettingsSnapshot();
      return snapshot?.scopeKey === input.expectedScopeKey
        && getActiveAccountSettingsSnapshotLifetimeToken() === lifetime ? snapshot : null;
    };
    if (signal?.aborted) return { status: 'canceled', code: 'canceled' };
    if (!currentSnapshot() || !await args.isCurrent()) return refused('approval_changed');
    let target: ConfidentialSecretFillTarget | null = null;
    let bytes: Uint8Array | null = null;
    let issued = false;
    try {
      // Home profile ids are client-local. Only the host's fresh immutable Home identity
      // may bind a different profile alias to the already-reviewed execution origin.
      if (!await hostIsCurrent()) return refused('target_changed');
      const mode = await input.readAccountMode(signal);
      if (mode !== args.accountEncryptionMode) return refused('saved_secret_mode_incompatible');
      if (!currentSnapshot() || !await args.isCurrent()) return refused('approval_changed');
      const prepared = await input.prepareTarget({ actionId: args.actionId, request: args.request, context: args.context });
      if ('status' in prepared) return prepared;
      target = prepared;
      if (args.actionId === 'browser.automation.secret.fill' && target.nativeObservation !== 'not_observable') {
        return refused('observation_unavailable');
      }
      // Preparation has synchronously blocked and drained every unsafe observation before any material is resolved.
      if (!currentSnapshot() || !await args.isCurrent() || !await target.recheck()) return refused('target_changed');
      if (args.choice.kind === 'saved') {
        await refreshSavedSecretCatalogForOperation({ expectedScopeKey: input.expectedScopeKey,
          references: [{ ref: args.choice.ref, ...(args.choice.revision === null ? {} : { revision: args.choice.revision }) }],
          ...(signal ? { signal } : {}) });
      }
      if (signal?.aborted) return { status: 'canceled', code: 'canceled' };
      if (!await args.isCurrent() || !await target.recheck()) return refused('target_changed');
      if (await input.readAccountMode(signal) !== mode) return refused('saved_secret_mode_incompatible');
      if (!await args.isCurrent()) return refused('approval_changed');
      const snapshot = currentSnapshot();
      if (!snapshot) return refused('approval_changed');
      let value: string;
      let savedMaterialFingerprint: string | null = null;
      if (args.choice.kind === 'saved') {
        const materializer = createSavedSecretMaterializerFromSnapshotV1(snapshot);
        const inspection = materializer.inspect(args.choice.ref);
        if (inspection.status !== 'ready') return refused(catalogRefusal[inspection.status]);
        if (inspection.catalogFingerprint !== args.choice.fingerprint
          || (args.choice.revision !== null && !materializer.matchesSharedResourceRevision(args.choice.ref, args.choice.revision))) {
          return refused('saved_secret_changed');
        }
        if ((mode === 'plain' && inspection.storage === 'settings_encrypted')
          || (mode === 'e2ee' && inspection.storage === 'settings_plain')) return refused('saved_secret_mode_incompatible');
        savedMaterialFingerprint = inspection.fingerprint;
        const material = materializer.recheck(args.choice.ref, savedMaterialFingerprint);
        if (material.status !== 'ready') return refused(catalogRefusal[material.status]);
        value = material.value;
      } else value = args.choice.value;
      bytes = Buffer.from(value, 'utf8');
      value = '';
      if (!currentSnapshot() || signal?.aborted) return { status: 'canceled', code: 'canceled' };
      issued = true;
      const beforeDelivery = async () => {
        if (signal?.aborted || await input.readAccountMode(signal) !== mode || !await args.isCurrent()) return false;
        if (!await hostIsCurrent()) return false;
        const latest = currentSnapshot();
        if (!latest) return false;
        if (args.choice.kind !== 'saved') return true;
        const materializer = createSavedSecretMaterializerFromSnapshotV1(latest);
        const inspection = materializer.inspect(args.choice.ref);
        return inspection.status === 'ready' && inspection.catalogFingerprint === args.choice.fingerprint
          && inspection.fingerprint === savedMaterialFingerprint
          && (args.choice.revision === null || materializer.matchesSharedResourceRevision(args.choice.ref, args.choice.revision));
      };
      const filled = await target.fill(bytes, signal, beforeDelivery);
      if (filled.status !== 'filled' || !args.submit) return filled;
      try {
        if (!args.request.submit || !target.submit || !currentSnapshot()
          || !await args.isCurrent() || !await target.recheck()
          || await input.readAccountMode(signal) !== mode) {
          return { ...filled, submit: { status: 'refused', code: 'submit_refused' } };
        }
        return { ...filled, submit: await target.submit(signal, beforeDelivery) };
      } catch {
        // A separately approved submit cannot erase the acknowledged fill. Its
        // unknown settlement is terminal too, never a reason to repeat either effect.
        return { ...filled, submit: { status: 'unknown', code: 'submit_unknown' } };
      }
    } catch (error) {
      if (!issued && error instanceof SavedSecretOperationAdmissionError) {
        return refused(error.reason === 'reference_stale' ? 'saved_secret_changed'
          : catalogRefusal[savedSecretOperationAdmissionStatus(error.reason)]);
      }
      return issued ? { status: 'unknown', code: 'delivery_unknown' }
        : signal?.aborted ? { status: 'canceled', code: 'canceled' } : refused('saved_secret_unavailable');
    } finally {
      bytes?.fill(0);
      bytes = null;
      await target?.finish().catch(() => undefined);
      target = null;
    }
  };
}
