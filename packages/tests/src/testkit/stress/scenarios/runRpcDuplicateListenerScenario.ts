import type { RunDirs } from '../../runDir';
import { createSession } from '../../sessions';
import { FailureArtifacts } from '../../failureArtifacts';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createUserScopedSocketCollector } from '../../socketClient';
import { waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import {
  buildRpcDuplicateListenerScopeCases,
  classifyRpcDuplicateListenerOutcome,
  type RpcDuplicateListenerOutcome,
  type RpcDuplicateListenerScope,
} from './rpcDuplicateListenerPolicy';
import { resolveStressSocketTransports, summarizeLatencySamples } from './stressScenarioRuntime';

export async function runRpcDuplicateListenerScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('rpc-duplicate-listener-policy');
  const startedAt = new Date().toISOString();
  const { sessionId } = await createSession(params.target.baseUrl, params.token);
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  const ui = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const userListenerA = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const userListenerB = createUserScopedSocketCollector(params.target.baseUrl, params.token, { transports });
  const sessionListenerA = await createMachineBoundSessionScopedSocketCollector({
    baseUrl: params.target.baseUrl,
    token: params.token,
    sessionId,
    transports,
  });
  const sessionListenerB = await createMachineBoundSessionScopedSocketCollector({
    baseUrl: params.target.baseUrl,
    token: params.token,
    sessionId,
    transports,
  });
  const latencies: number[] = [];
  let failure: unknown;
  const machineScopedMethodOwnerId = 'machine_duplicate_listener_scope';
  const scopeCases = buildRpcDuplicateListenerScopeCases({
    sessionId,
    machineId: machineScopedMethodOwnerId,
  });
  const scopeOutcomes = new Map<RpcDuplicateListenerScope, {
    outcome: RpcDuplicateListenerOutcome;
    responderIds: string[];
  }>();
  const artifacts = new FailureArtifacts();
  artifacts.json('ui.events.json', () => ui.getEvents());
  artifacts.json('userListenerA.events.json', () => userListenerA.getEvents());
  artifacts.json('userListenerB.events.json', () => userListenerB.getEvents());
  artifacts.json('sessionListenerA.events.json', () => sessionListenerA.socket.getEvents());
  artifacts.json('sessionListenerB.events.json', () => sessionListenerB.socket.getEvents());

  try {
    ui.connect();
    userListenerA.connect();
    userListenerB.connect();
    sessionListenerA.socket.connect();
    sessionListenerB.socket.connect();
    await waitFor(
      () =>
        ui.isConnected()
        && userListenerA.isConnected()
        && userListenerB.isConnected()
        && sessionListenerA.socket.isConnected()
        && sessionListenerB.socket.isConnected(),
      { timeoutMs: 20_000 },
    );

    userListenerA.onRpcRequest(async () => JSON.stringify({ ok: true, responderId: 'user-listener-a' }));
    userListenerB.onRpcRequest(async () => JSON.stringify({ ok: true, responderId: 'user-listener-b' }));
    sessionListenerA.socket.onRpcRequest(async () =>
      JSON.stringify({ ok: true, responderId: sessionListenerA.machineId }),
    );
    sessionListenerB.socket.onRpcRequest(async () =>
      JSON.stringify({ ok: true, responderId: sessionListenerB.machineId }),
    );

    for (const scopeCase of scopeCases) {
      const responderIds = new Set<string>();
      const listeners = scopeCase.scope === 'session'
        ? [sessionListenerA.socket, sessionListenerB.socket]
        : [userListenerA, userListenerB];
      let secondRegistrationRejected = false;

      await listeners[0].rpcRegister(scopeCase.method);
      try {
        await listeners[1].rpcRegister(scopeCase.method);
      } catch {
        secondRegistrationRejected = true;
      }

      if (!secondRegistrationRejected) {
        for (let index = 0; index < 12; index += 1) {
          const started = Date.now();
          const response = await ui.rpcCall<{ ok: boolean; result?: string; errorCode?: string }>(
            scopeCase.method,
            JSON.stringify({ index, scope: scopeCase.scope }),
          );
          latencies.push(Date.now() - started);
          if (!response.ok || typeof response.result !== 'string') {
            throw new Error(`Duplicate-listener RPC failed (${scopeCase.scope}): ${response.errorCode ?? 'unknown'}`);
          }
          const parsed = JSON.parse(response.result) as { responderId?: string };
          if (typeof parsed.responderId !== 'string') {
            throw new Error(`Duplicate-listener RPC did not return a responder id (${scopeCase.scope})`);
          }
          responderIds.add(parsed.responderId);
        }
      }

      const outcome = classifyRpcDuplicateListenerOutcome({
        secondRegistrationRejected,
        responderIds,
      });
      scopeOutcomes.set(scopeCase.scope, {
        outcome,
        responderIds: [...responderIds],
      });

      if (outcome === 'ambiguous') {
        throw new Error(`Duplicate listener routing was ambiguous for ${scopeCase.scope}-scoped RPC`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const outcomeCounts = {
      rejected: [...scopeOutcomes.values()].filter((entry) => entry.outcome === 'rejected').length,
      deterministic: [...scopeOutcomes.values()].filter((entry) => entry.outcome === 'deterministic').length,
      ambiguous: [...scopeOutcomes.values()].filter((entry) => entry.outcome === 'ambiguous').length,
    };
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'rpc.duplicateListenerPolicy',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds: [sessionId],
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        scopesTested: scopeCases.length,
        rejectedScopes: outcomeCounts.rejected,
        deterministicScopes: outcomeCounts.deterministic,
        ambiguousScopes: outcomeCounts.ambiguous,
      },
      latencies: summarizeLatencySamples(latencies),
      errors: {
        buckets: {
          rejectedScopes: outcomeCounts.rejected,
          deterministicScopes: outcomeCounts.deterministic,
          ambiguousScopes: outcomeCounts.ambiguous,
        },
        details: {
          duplicatePolicyByScope: Object.fromEntries(
            scopeCases.flatMap((scopeCase) => {
              const outcome = scopeOutcomes.get(scopeCase.scope)?.outcome;
              return [
                [`${scopeCase.scope}Rejected`, outcome === 'rejected' ? 1 : 0],
                [`${scopeCase.scope}Deterministic`, outcome === 'deterministic' ? 1 : 0],
                [`${scopeCase.scope}Ambiguous`, outcome === 'ambiguous' ? 1 : 0],
              ];
            }),
          ),
        },
      },
    });
    await artifacts.dumpAll(testDir, { onlyIf: params.config.artifacts.saveArtifactsOnSuccess || !!failure });
    ui.close();
    userListenerA.close();
    userListenerB.close();
    sessionListenerA.socket.close();
    sessionListenerB.socket.close();
  }

  if (failure) {
    throw failure;
  }
}
