import { callMachineRpcWhenRegistered } from '../../machineRpcReadiness';

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

export async function waitForRegisteredRpcMethod(params: Readonly<{
  ui: RpcCaller;
  method: string;
  expectedMachineId: string;
  timeoutMs?: number;
}>): Promise<void> {
  const response = await callMachineRpcWhenRegistered({
    call: async () => await params.ui.rpcCall<RpcCallResult & { result?: string }>(
      params.method,
      JSON.stringify({ healthcheck: true }),
      10_000,
    ),
    timeoutMs: params.timeoutMs,
    context: `waitForRegisteredRpcMethod ${params.method}`,
  });
  if (!response.ok || typeof response.result !== 'string') {
    throw new Error(`RPC readiness check failed for ${params.method}: ${response.errorCode ?? 'unknown'}`);
  }
  const parsed = JSON.parse(response.result) as { ok?: boolean; machineId?: string };
  if (parsed.ok !== true || parsed.machineId !== params.expectedMachineId) {
    throw new Error(`RPC readiness check resolved to the wrong listener for ${params.method}`);
  }
}
