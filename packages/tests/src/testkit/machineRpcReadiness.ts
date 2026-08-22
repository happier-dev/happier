import { waitFor } from './timing';

type MachineRpcEnvelope = Readonly<{
  ok?: unknown;
  errorCode?: unknown;
}>;

function asMachineRpcEnvelope(value: unknown): MachineRpcEnvelope | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as MachineRpcEnvelope
    : null;
}

export async function callMachineRpcWhenRegistered<T>(params: Readonly<{
  call: () => Promise<T>;
  timeoutMs?: number;
  context: string;
}>): Promise<T> {
  let response!: T;
  let settled = false;
  await waitFor(async () => {
    const candidate = await params.call();
    const envelope = asMachineRpcEnvelope(candidate);
    if (envelope?.ok !== true && envelope?.errorCode === 'RPC_METHOD_NOT_AVAILABLE') {
      return false;
    }
    response = candidate;
    settled = true;
    return true;
  }, {
    timeoutMs: params.timeoutMs ?? 20_000,
    intervalMs: 250,
    shouldRetryOnError: () => false,
    context: params.context,
  });

  if (!settled) {
    throw new Error(`RPC readiness completed without a response (${params.context})`);
  }
  return response;
}
