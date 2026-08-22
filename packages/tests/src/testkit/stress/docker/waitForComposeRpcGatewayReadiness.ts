import { createTestAuth } from '../../auth';
import { waitForOkHealth } from '../../http';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createSession } from '../../sessions';
import { createUserScopedSocketCollector } from '../../socketClient';
import { sleep } from '../../timing';
import { waitFor } from '../../timing';
import { waitForRegisteredRpcMethod } from '../scenarios/waitForRegisteredRpcMethod';

type RpcReadinessDeps = Readonly<{
  createTestAuth: typeof createTestAuth;
  waitForOkHealth: typeof waitForOkHealth;
  createSession: typeof createSession;
  createUserScopedSocketCollector: typeof createUserScopedSocketCollector;
  createMachineBoundSessionScopedSocketCollector: typeof createMachineBoundSessionScopedSocketCollector;
  waitFor: typeof waitFor;
  waitForRegisteredRpcMethod: typeof waitForRegisteredRpcMethod;
}>;

const defaultDeps: RpcReadinessDeps = {
  createTestAuth,
  waitForOkHealth,
  createSession,
  createUserScopedSocketCollector,
  createMachineBoundSessionScopedSocketCollector,
  waitFor,
  waitForRegisteredRpcMethod,
};

export async function waitForComposeRpcGatewayReadiness(
  params: Readonly<{
    baseUrl: string;
    timeoutMs?: number;
    attempts?: number;
    retryDelayMs?: number;
  }>,
  deps: RpcReadinessDeps = defaultDeps,
): Promise<void> {
  const attempts = Math.max(1, Math.trunc(params.attempts ?? 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let ui: ReturnType<typeof deps.createUserScopedSocketCollector> | undefined;
    let listener: Awaited<ReturnType<typeof deps.createMachineBoundSessionScopedSocketCollector>> | undefined;

    try {
      await deps.waitForOkHealth(
        params.baseUrl,
        { timeoutMs: params.timeoutMs ?? 30_000 },
      );
      const auth = await deps.createTestAuth(params.baseUrl);
      const { sessionId } = await deps.createSession(params.baseUrl, auth.token);
      const currentUi = deps.createUserScopedSocketCollector(params.baseUrl, auth.token, { transports: ['websocket'] });
      const currentListener = await deps.createMachineBoundSessionScopedSocketCollector({
        baseUrl: params.baseUrl,
        token: auth.token,
        sessionId,
        transports: ['websocket'],
      });
      ui = currentUi;
      listener = currentListener;
      const method = `${sessionId}:stress.rpc.gateway-readiness`;

      currentUi.connect();
      currentListener.socket.connect();
      await deps.waitFor(
        () => currentUi.isConnected() && currentListener.socket.isConnected(),
        {
          timeoutMs: params.timeoutMs ?? 30_000,
          context: 'waitForComposeRpcGatewayReadiness sockets connected',
        },
      );
      currentListener.socket.onRpcRequest(async () => JSON.stringify({
        ok: true,
        machineId: currentListener.machineId,
      }));
      await currentListener.socket.rpcRegister(method);
      await deps.waitForRegisteredRpcMethod({
        ui: currentUi,
        method,
        expectedMachineId: currentListener.machineId,
        timeoutMs: params.timeoutMs ?? 30_000,
      });
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      await sleep(params.retryDelayMs ?? 250);
    } finally {
      ui?.close();
      listener?.socket.close();
    }
  }
}
