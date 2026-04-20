import type { RunDirs } from '../../runDir';
import { createSession } from '../../sessions';
import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { scrapeServiceMetricCounters } from './fullComposeScenarioSupport';
import { resolvePresenceSessionCount, resolveStressSocketTransports } from './stressScenarioRuntime';

export async function runPresencePressureScenario(params: {
  run: RunDirs;
  target: StartedStressTarget;
  config: StressConfig;
  token: string;
}): Promise<void> {
  const testDir = params.run.testDir('presence-pressure');
  const startedAt = new Date().toISOString();
  const machineCollectors: Awaited<ReturnType<typeof createMachineBoundSessionScopedSocketCollector>>[] = [];
  const sessionIds: string[] = [];
  const transports = resolveStressSocketTransports(params.config, params.target.mode);
  let failure: unknown;
  let metrics: Record<string, unknown> = {};

  try {
    const totalSessions = resolvePresenceSessionCount(params.config);
    for (let i = 0; i < totalSessions; i++) {
      const { sessionId } = await createSession(params.target.baseUrl, params.token);
      sessionIds.push(sessionId);
      machineCollectors.push(
        await createMachineBoundSessionScopedSocketCollector({
          baseUrl: params.target.baseUrl,
          token: params.token,
          sessionId,
          transports,
        }),
      );
    }

    if (params.config.duration.warmupMs > 0) {
      await sleep(params.config.duration.warmupMs);
    }
    machineCollectors.forEach((collector) => collector.socket.connect());
    await waitFor(() => machineCollectors.every((collector) => collector.socket.isConnected()), { timeoutMs: 30_000 });

    machineCollectors.forEach((collector, index) => {
      if (index % 2 === 0) {
        collector.socket.disconnect();
      }
    });
    await waitFor(() => machineCollectors.filter((_, index) => index % 2 === 0).every((collector) => !collector.socket.isConnected()), {
      timeoutMs: 15_000,
    });
    machineCollectors.forEach((collector) => collector.socket.connect());
    await waitFor(() => machineCollectors.every((collector) => collector.socket.isConnected()), { timeoutMs: 30_000 });

    if (params.config.duration.soakMs > 0) {
      await sleep(params.config.duration.soakMs);
    }
    if (params.target.mode === 'full-compose' && params.config.compose.metricsEnabled && params.config.artifacts.metricsScrapeEnabled) {
      const counters = await scrapeServiceMetricCounters({
        target: params.target,
        service: 'worker',
        metricNames: ['session_alive_events_total', 'machine_alive_events_total'],
      });
      metrics = {
        sessionAliveEventsTotal: counters.session_alive_events_total,
        machineAliveEventsTotal: counters.machine_alive_events_total,
      };
    }
    if (params.config.duration.cooldownMs > 0) {
      await sleep(params.config.duration.cooldownMs);
    }
  } catch (error) {
    failure = error;
  } finally {
    await finalizeStressScenario({
      run: params.run,
      testDir,
      testName: 'presence.pressure',
      target: params.target,
      config: params.config,
      startedAt,
      sessionIds,
      seed: params.config.seed,
      status: failure ? 'failed' : 'passed',
      error: failure,
      counts: {
        sessions: sessionIds.length,
        machineSockets: machineCollectors.length,
      },
      metrics,
    });
    machineCollectors.forEach((collector) => collector.socket.close());
  }

  if (failure) {
    throw failure;
  }
}
