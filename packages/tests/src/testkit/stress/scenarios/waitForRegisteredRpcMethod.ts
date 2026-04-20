import { waitFor } from '../../timing';

type RpcCaller = Readonly<{
  rpcCall: <T = { ok?: boolean; result?: string; errorCode?: string }>(
    method: string,
    params: string,
    timeoutMs?: number,
  ) => Promise<T>;
}>;

type RpcCallResult = Readonly<{
  ok?: boolean;
  errorCode?: string;
}>;

function isMethodUnavailable(result: RpcCallResult): boolean {
  return result.ok !== true && result.errorCode === 'RPC_METHOD_NOT_AVAILABLE';
}

export async function waitForRegisteredRpcMethod(params: Readonly<{
  ui: RpcCaller;
  method: string;
  expectedMachineId: string;
  timeoutMs?: number;
}>): Promise<void> {
  await waitFor(
    async () => {
      const response = await params.ui.rpcCall<RpcCallResult & { result?: string }>(
        params.method,
        JSON.stringify({ healthcheck: true }),
        10_000,
      );
      if (isMethodUnavailable(response)) return false;
      if (!response.ok || typeof response.result !== 'string') {
        throw new Error(`RPC readiness check failed for ${params.method}: ${response.errorCode ?? 'unknown'}`);
      }
      const parsed = JSON.parse(response.result) as { ok?: boolean; machineId?: string };
      if (parsed.ok !== true || parsed.machineId !== params.expectedMachineId) {
        throw new Error(`RPC readiness check resolved to the wrong listener for ${params.method}`);
      }
      return true;
    },
    {
      timeoutMs: params.timeoutMs ?? 20_000,
      intervalMs: 250,
      shouldRetryOnError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes('RPC_METHOD_NOT_AVAILABLE');
      },
      context: `waitForRegisteredRpcMethod ${params.method}`,
    },
  );
}
