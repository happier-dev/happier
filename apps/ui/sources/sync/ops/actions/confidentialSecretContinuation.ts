import { PrivateSecretContinuationV1Schema, type PrivateSecretContinuationV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { SecretFillSettlementV1Schema, type SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';
import { applyAccountSettingsSavedSecretMutation } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { randomUUID } from '@/platform/randomUUID';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { captureLazyActionAccountContext } from './actionAccountContext';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';

export type ConfidentialSecretContinuationResult = Readonly<{
  fill: SecretFillSettlementV1;
  remember: 'not_requested' | 'saved' | 'failed' | 'unknown' | 'canceled';
}>;

/** The human prompt owns this mutable operand and clears its input when this returns. */
export async function continueConfidentialSecretFill(input: Readonly<{
  continuation: PrivateSecretContinuationV1;
  scope: AccountSettingsScope;
  /** Immutable reviewed Home identity, never inferred from a local profile alias. */
  expectedServerIdentityId?: string | null;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  /** Omitted by default. Never inferred from the fill choice. */
  remember?: Readonly<{ name: string }>;
}>): Promise<ConfidentialSecretContinuationResult> {
  let continuation: PrivateSecretContinuationV1 | null = null;
  let dispatched = false;
  let remember: ConfidentialSecretContinuationResult['remember'] = 'not_requested';
  let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
  try {
    const parsed = PrivateSecretContinuationV1Schema.safeParse(input.continuation);
    if (!parsed.success) {
      return { fill: { status: 'refused', code: 'approval_changed' }, remember };
    }
    continuation = parsed.data;
    if (input.signal?.aborted || !input.isCurrent()) return { fill: { status: 'canceled', code: 'canceled' }, remember };
    try {
      account = await captureLazyActionAccountContext(input.scope.serverId, input.signal);
      const expectedIdentity = input.expectedServerIdentityId?.trim() || null;
      if (account.accountId !== input.scope.accountId || account.serverId !== input.scope.serverId
        || (expectedIdentity && account.serverIdentityId !== expectedIdentity)
        || (continuation.request.serverId !== input.scope.serverId
          && (!expectedIdentity || account.serverIdentityId !== expectedIdentity))) {
        return { fill: { status: 'refused', code: 'approval_changed' }, remember };
      }
      const encryption = await account.resolveAccountEncryption();
      account.assertCurrent();
      if (encryption.accountMode !== continuation.accountEncryptionMode) {
        return { fill: { status: 'refused', code: 'approval_changed' }, remember };
      }
      if (!input.isCurrent()) return { fill: { status: 'canceled', code: 'canceled' }, remember };
    } catch {
      return { fill: input.signal?.aborted || !input.isCurrent()
        ? { status: 'canceled', code: 'canceled' } : { status: 'refused', code: 'target_unavailable' }, remember };
    }
    let fill: SecretFillSettlementV1;
    try {
      const result = await machineRpcWithServerScope<unknown, PrivateSecretContinuationV1>({
        machineId: continuation.request.machineId, serverId: input.scope.serverId,
        accountId: input.scope.accountId, method: RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE,
        payload: continuation, signal: input.signal, onDispatched: () => { dispatched = true; },
        ...(continuation.accountEncryptionMode === 'e2ee' ? { requireEncryptedPayload: true as const } : {}),
      });
      const settlement = SecretFillSettlementV1Schema.safeParse(result);
      fill = settlement.success ? settlement.data : { status: 'unknown', code: 'delivery_unknown' };
    } catch (error) {
      fill = dispatched || readRpcRequestDisposition(error) === 'outcomeUnknown'
        ? { status: 'unknown', code: 'delivery_unknown' }
        : input.signal?.aborted ? { status: 'canceled', code: 'canceled' }
          : { status: 'refused', code: 'target_unavailable' };
    }
    if (input.remember && continuation.choice.kind === 'once' && fill.status === 'filled') {
      if (input.signal?.aborted || !input.isCurrent()) remember = 'canceled';
      else {
        remember = 'failed';
        const name = input.remember.name.trim();
        if (name) {
          const now = Date.now();
          const secret = { id: randomUUID(), name, kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: continuation.choice.value },
            createdAt: now, updatedAt: now };
          try {
            // The incumbent CAS writer reads persisted Account mode and seals the same
            // material. Its failure never repeats the already settled physical fill.
            const account = await captureLazyActionAccountContext(input.scope.serverId, input.signal);
            try {
              const encryption = await account.resolveAccountEncryption();
              if (account.accountId !== input.scope.accountId || !input.isCurrent()
                || (input.expectedServerIdentityId && account.serverIdentityId !== input.expectedServerIdentityId)
                || encryption.accountMode !== continuation.accountEncryptionMode) throw new Error('account_changed');
              await account.mutateRawSettings(current => {
                if (!input.isCurrent()) throw new Error('account_changed');
                // The mutation owner intentionally retains the saved operand. Do not
                // alias it with the ephemeral object that this operation clears.
                const saved = { ...secret, encryptedValue: { ...secret.encryptedValue } };
                return { ...applyAccountSettingsSavedSecretMutation(current, { kind: 'add', secret: saved }).settings };
              });
            } finally { account.dispose(); }
            remember = 'saved';
          } catch (error) {
            remember = input.signal?.aborted || !input.isCurrent() ? 'canceled'
              : error !== null && typeof error === 'object'
                && Reflect.get(error, 'code') === 'account_settings_mutation_outcome_unknown' ? 'unknown' : 'failed';
          }
          finally { secret.encryptedValue.value = ''; }
        }
      }
    }
    return { fill, remember };
  } finally {
    account?.dispose();
    if (continuation?.choice.kind === 'once') continuation.choice.value = '';
    if (input.continuation.choice.kind === 'once') input.continuation.choice.value = '';
    continuation = null;
  }
}
