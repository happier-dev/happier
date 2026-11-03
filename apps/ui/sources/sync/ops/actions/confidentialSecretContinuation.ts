import { PrivateSecretContinuationV1Schema, PrivateActionInputContinuationV1Schema, type PrivateSecretContinuationV1,
  type PrivateActionInputContinuationV1, type PrivateConfidentialContinuationV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { ActionExecuteResultSchema, projectUnexpectedActionFailureV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SecretFillSettlementV1Schema, type SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { captureLazyActionAccountContext } from './actionAccountContext';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1, type SavedSecretVaultTargetV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { runTeamAction } from '@/sync/ops/teams/teamActionClient';

export type ConfidentialSecretContinuationResult = Readonly<{
  fill: SecretFillSettlementV1;
  remember: 'not_requested' | 'saved' | 'failed' | 'unknown' | 'canceled';
}>;

type ConfidentialContinuationContext = Readonly<{
  scope: AccountSettingsScope;
  /** Immutable reviewed Home identity, never inferred from a local profile alias. */
  expectedServerIdentityId?: string | null;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}>;

type PrivateDispatchResult = Readonly<{ kind: 'received'; result: unknown }>
  | Readonly<{ kind: 'refused'; code: 'approval_changed' | 'target_unavailable' }>
  | Readonly<{ kind: 'canceled' }>
  | Readonly<{ kind: 'unknown' }>;

/** Account capture and private transport have one policy for both continuation forms. */
async function dispatchConfidentialContinuation(continuation: PrivateConfidentialContinuationV1,
  input: ConfidentialContinuationContext): Promise<PrivateDispatchResult> {
  let dispatched = false;
  let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
  try {
    const target = 'kind' in continuation ? continuation : continuation.request;
    if (input.signal?.aborted || !input.isCurrent()) return { kind: 'canceled' };
    try {
      account = await captureLazyActionAccountContext(input.scope.serverId, input.signal);
      const expectedIdentity = input.expectedServerIdentityId?.trim() || null;
      if (account.accountId !== input.scope.accountId || account.serverId !== input.scope.serverId
        || (expectedIdentity && account.serverIdentityId !== expectedIdentity)
        || (target.serverId !== input.scope.serverId
          && (!expectedIdentity || account.serverIdentityId !== expectedIdentity))) {
        return { kind: 'refused', code: 'approval_changed' };
      }
      const encryption = await account.resolveAccountEncryption();
      account.assertCurrent();
      if (encryption.accountMode !== continuation.accountEncryptionMode) {
        return { kind: 'refused', code: 'approval_changed' };
      }
      if (!input.isCurrent()) return { kind: 'canceled' };
    } catch {
      return input.signal?.aborted || !input.isCurrent()
        ? { kind: 'canceled' } : { kind: 'refused', code: 'target_unavailable' };
    }
    try {
      const result = await machineRpcWithServerScope<unknown, PrivateConfidentialContinuationV1>({
        machineId: target.machineId, serverId: input.scope.serverId,
        accountId: input.scope.accountId, method: RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE,
        payload: continuation, signal: input.signal, onDispatched: () => { dispatched = true; },
        // Setup stays bounded; admitted delivery follows the human caller's lifetime.
        operationTimeoutMs: null,
        ...(continuation.accountEncryptionMode === 'e2ee' ? { requireEncryptedPayload: true as const } : {}),
      });
      return { kind: 'received', result };
    } catch (error) {
      return dispatched || readRpcRequestDisposition(error) === 'outcomeUnknown'
        ? { kind: 'unknown' }
        : input.signal?.aborted ? { kind: 'canceled' }
          : { kind: 'refused', code: 'target_unavailable' };
    }
  } finally {
    account?.dispose();
  }
}

type SavedSecretCreated = ReturnType<typeof PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create']['parse']>;
type RememberResult = Readonly<{ status: 'saved'; saved: SavedSecretCreated }>
  | Readonly<{ status: Exclude<ConfidentialSecretContinuationResult['remember'], 'saved'> }>;

/** Remember is a separate explicit mutation after consumption; it never retries the effect. */
async function rememberOnceValue(input: ConfidentialContinuationContext, value: string, nameRaw: string,
  storeIn?: SavedSecretVaultTargetV1): Promise<RememberResult> {
  if (input.signal?.aborted || !input.isCurrent()) return { status: 'canceled' };
  const name = nameRaw.trim();
  if (!name) return { status: 'failed' };
  try {
    const created = await runTeamAction({
      scope: input.scope, actionId: 'secrets.create', input: { name, kind: 'apiKey', value, ...(storeIn ? { storeIn } : {}) },
      parse: value => PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(value),
      approval: 'surface_confirmed', signal: input.signal,
    });
    return created.kind === 'succeeded' ? { status: 'saved', saved: created.value }
      : { status: created.failure.kind === 'outcome_unknown' ? 'unknown' : 'failed' };
  } catch (error) {
    return { status: input.signal?.aborted || !input.isCurrent() ? 'canceled'
      : error !== null && typeof error === 'object'
        && Reflect.get(error, 'code') === 'outcome_unknown' ? 'unknown' : 'failed' };
  }
}

/** The human prompt owns this mutable operand and clears its input when this returns. */
export async function continueConfidentialSecretFill(input: ConfidentialContinuationContext & Readonly<{
  continuation: PrivateSecretContinuationV1;
  /** Omitted by default. Never inferred from the fill choice. */
  remember?: Readonly<{ name: string; storeIn?: SavedSecretVaultTargetV1 }>;
}>): Promise<ConfidentialSecretContinuationResult> {
  let continuation: PrivateSecretContinuationV1 | null = null;
  let remember: ConfidentialSecretContinuationResult['remember'] = 'not_requested';
  try {
    const parsed = PrivateSecretContinuationV1Schema.safeParse(input.continuation);
    if (!parsed.success) return { fill: { status: 'refused', code: 'approval_changed' }, remember };
    continuation = parsed.data;
    const dispatched = await dispatchConfidentialContinuation(continuation, input);
    let fill: SecretFillSettlementV1;
    if (dispatched.kind === 'received') {
      const settlement = SecretFillSettlementV1Schema.safeParse(dispatched.result);
      fill = settlement.success ? settlement.data : { status: 'unknown', code: 'delivery_unknown' };
    } else {
      fill = dispatched.kind === 'refused' ? { status: 'refused', code: dispatched.code }
        : dispatched.kind === 'canceled' ? { status: 'canceled', code: 'canceled' }
          : { status: 'unknown', code: 'delivery_unknown' };
    }
    if (input.remember && continuation.choice.kind === 'once' && fill.status === 'filled') {
      remember = (await rememberOnceValue(input, continuation.choice.value, input.remember.name, input.remember.storeIn)).status;
    }
    return { fill, remember };
  } finally {
    if (continuation?.choice.kind === 'once') continuation.choice.value = '';
    if (input.continuation.choice.kind === 'once') input.continuation.choice.value = '';
    continuation = null;
  }
}

export type ConfidentialActionInputsContinuationResult = Readonly<{
  execution: ActionExecuteResult;
  remember: readonly (Readonly<{ path: string }> & RememberResult)[];
}>;

/** Supplies every declared secret input privately to its already-admitted consuming Action. */
export async function continueConfidentialActionInputs(input: ConfidentialContinuationContext & Readonly<{
  continuation: PrivateActionInputContinuationV1;
  remember?: readonly Readonly<{ path: string; name: string; storeIn?: SavedSecretVaultTargetV1 }>[];
}>): Promise<ConfidentialActionInputsContinuationResult> {
  let continuation: PrivateActionInputContinuationV1 | null = null;
  const remember: Array<Readonly<{ path: string }> & RememberResult> = input.continuation.choices.map(({ path }) => ({ path, status: 'not_requested' }));
  const failure = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
  try {
    const parsed = PrivateActionInputContinuationV1Schema.safeParse(input.continuation);
    if (!parsed.success) return { execution: failure('approval_changed'), remember };
    continuation = parsed.data;
    const dispatched = await dispatchConfidentialContinuation(continuation, input);
    let execution: ActionExecuteResult;
    if (dispatched.kind === 'received') {
      const result = ActionExecuteResultSchema.safeParse(dispatched.result);
      execution = result.success ? result.data : projectUnexpectedActionFailureV1(null);
    } else {
      execution = dispatched.kind === 'unknown' ? projectUnexpectedActionFailureV1(null)
        : failure(dispatched.kind === 'canceled' ? 'approval_canceled' : dispatched.code);
    }
    if (execution.ok && input.remember) {
      const choices = new Map(input.remember.map(entry => [entry.path, entry]));
      for (const [index, entry] of continuation.choices.entries()) {
        const choice = choices.get(entry.path);
        if (choice !== undefined && entry.choice.kind === 'once') {
          remember[index] = { path: entry.path, ...await rememberOnceValue(input, entry.choice.value, choice.name, choice.storeIn) };
        }
      }
    }
    return { execution, remember };
  } finally {
    for (const entry of continuation?.choices ?? []) if (entry.choice.kind === 'once') entry.choice.value = '';
    for (const entry of input.continuation.choices) if (entry.choice.kind === 'once') entry.choice.value = '';
    continuation = null;
  }
}
