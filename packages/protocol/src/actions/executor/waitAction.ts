import { WaitActionResultV1Schema, WaitOwnerResultV1Schema, type WaitActionInputV1, type WaitActionResultV1, type WaitOwnerResultV1, type WaitTargetV1 } from '../specs/wait.js';
import { ExecutionRunWaitResultSchema } from '../../execution/runs/responseSchemas.js';
import { WorkflowRunWaitResultV1Schema } from '../../workflows/actionsV1.js';
import { normalizeStrictJsonValue } from '../../json/strictJsonValue.js';

export type WaitOwnerOptionsV1 = Readonly<{
  condition: WaitActionInputV1['condition'];
  timeoutMs: number | null;
  deadlineMs: number | null;
  signal?: AbortSignal;
  onSnapshot?: (snapshot: unknown) => void | Promise<void>;
}>;
export type WaitActionPortsV1 = Readonly<{
  execution?: (target: Extract<WaitTargetV1, { kind: 'execution_run' }>, options: WaitOwnerOptionsV1) => Promise<unknown>;
  session?: (request: WaitActionInputV1, options: WaitOwnerOptionsV1) => Promise<WaitOwnerResultV1>;
  workflow?: (target: Extract<WaitTargetV1, { kind: 'workflow_run' }>, options: WaitOwnerOptionsV1) => Promise<unknown>;
  plugin?: (request: WaitActionInputV1, options: WaitOwnerOptionsV1) => Promise<unknown>;
}>;

export async function executeWaitActionV1(
  input: WaitActionInputV1,
  ports: WaitActionPortsV1,
  options: Readonly<{ signal?: AbortSignal; onSnapshot?: (snapshot: unknown) => void | Promise<void> }> = {},
): Promise<WaitActionResultV1> {
  let deadlineReached = false;
  const complete = (result: WaitOwnerResultV1) => WaitActionResultV1Schema.parse({
    target: input.target, condition: input.condition, ...result,
    ...(options.signal?.aborted ? { disposition: 'cancelled' }
      : deadlineReached ? { disposition: 'observation_timeout' } : {}),
  });
  if (options.signal?.aborted) return complete({ disposition: 'cancelled' });
  const timeoutMs = input.timeout?.durationMs ?? null;
  const deadlineMs = timeoutMs === null ? null : Date.now() + timeoutMs;
  const deadlineAbort = deadlineMs === null ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    if (deadlineMs === null) return;
    // Node's signed 32-bit delay is a timer boundary, not an observation cap.
    timer = setTimeout(() => {
      if (Date.now() < deadlineMs) { armDeadline(); return; }
      deadlineReached = true;
      deadlineAbort?.abort();
    }, Math.min(Math.max(0, deadlineMs - Date.now()), 2_147_483_647));
  };
  const ownerOptions = { ...options, condition: input.condition, timeoutMs, deadlineMs,
    ...(deadlineAbort ? { signal: options.signal
      ? AbortSignal.any([options.signal, deadlineAbort.signal]) : deadlineAbort.signal } : {}),
  };
  try {
    armDeadline();
    if (input.target.kind === 'session') {
      if (!ports.session) return complete({ disposition: 'target_unavailable' });
      return complete(await ports.session(input, ownerOptions));
    }
    if (input.target.kind === 'execution_run') {
      if (input.condition.kind !== 'terminal' && input.condition.kind !== 'needs_attention'
        && input.condition.kind !== 'terminal_or_needs_attention') return complete({ disposition: 'unsupported_condition' });
      if (!ports.execution) return complete({ disposition: 'target_unavailable' });
      const raw = await ports.execution(input.target, ownerOptions);
      const parsed = ExecutionRunWaitResultSchema.safeParse(raw);
      if (!parsed.success) {
        const failure = waitFailureDispositionV1(raw);
        if (failure) return complete({ disposition: failure });
        throw new Error('execution_run_wait_result_invalid');
      }
      const waited = parsed.data;
      if (!waited.ok) return complete({ disposition: waitFailureDispositionV1(waited) ?? 'target_unavailable' });
      return complete({
        disposition: 'disposition' in waited && waited.disposition === 'observation_timeout' ? 'observation_timeout' : 'matched',
        snapshot: normalizeStrictJsonValue(waited),
      });
    }
    if (input.target.kind === 'workflow_run') {
      if (input.condition.kind !== 'terminal' && input.condition.kind !== 'needs_attention'
        && input.condition.kind !== 'terminal_or_needs_attention') return complete({ disposition: 'unsupported_condition' });
      if (!ports.workflow) return complete({ disposition: 'target_unavailable' });
      const raw = await ports.workflow(input.target, ownerOptions);
      const parsed = WorkflowRunWaitResultV1Schema.safeParse(raw);
      if (!parsed.success) {
        const failure = waitFailureDispositionV1(raw);
        if (failure) return complete({ disposition: failure });
        throw new Error('workflow_run_wait_result_invalid');
      }
      const waited = parsed.data;
      return complete({ disposition: waited.observation === 'timeout' ? 'observation_timeout'
        : waited.observation === 'paused' ? 'unsupported_condition'
        : waited.observation === 'not_matched_terminal' ? 'target_unavailable' : 'matched', snapshot: normalizeStrictJsonValue(waited) });
    }
    if (input.condition.kind !== 'plugin' || options.onSnapshot) return complete({ disposition: 'unsupported_condition' });
    if (!ports.plugin) return complete({ disposition: 'target_unavailable' });
    const raw = await ports.plugin(input, ownerOptions);
    const parsed = WaitOwnerResultV1Schema.safeParse(raw);
    if (parsed.success) return complete(parsed.data);
    const failure = waitFailureDispositionV1(raw);
    if (failure) return complete({ disposition: failure });
    throw new Error('plugin_source_wait_result_invalid');
  } catch (error) {
    if (options.signal?.aborted) return complete({ disposition: 'cancelled' });
    if (deadlineReached) return complete({ disposition: 'observation_timeout' });
    const disposition = waitFailureDispositionV1(error);
    if (disposition) return complete({ disposition });
    throw error;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Translation of existing owner/transport failures, never target lifecycle. */
export function waitFailureDispositionV1(value: unknown): WaitActionResultV1['disposition'] | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Readonly<Record<string, unknown>>;
  const code = record.errorCode ?? record.code;
  const response = record.response;
  const status = response && typeof response === 'object' && 'status' in response ? response.status : undefined;
  if (status === 401 || status === 403 || code === 'permission_denied' || code === 'not_authenticated'
    || code === 'execution_run_not_allowed' || code === 'server_target_mismatch'
    || code === 'action_disabled' || code === 'session_scope_denied') return 'permission_denied';
  if (code === 'credential_scope_denied') return 'permission_denied';
  if (code === 'cancelled') return 'cancelled';
  if (code === 'timeout' || code === 'observation_timeout') return 'observation_timeout';
  if (code === 'unsupported_condition' || code === 'unsupported_action') return 'unsupported_condition';
  if (code === 'target_unavailable' || code === 'session_not_found' || code === 'run_not_found'
    || code === 'contributed_action_unavailable'
    || code === 'execution_run_not_found' || code === 'execution_run_target_unavailable'
    || code === 'encryption_material_unavailable' || code === 'content_unavailable') return 'target_unavailable';
  if (code === 'disconnected' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') return 'disconnected';
  return null;
}
