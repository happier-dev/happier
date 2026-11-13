import fastify from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BugReportMachineDiagnosticsSnapshotSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { collectBugReportMachineDiagnosticsOnHost } from '@/diagnostics/bugReportMachineDiagnosticsLocalDaemon';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { writeSessionMarker } from '@/daemon/sessionRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { registerBugReportDiagnosticsRoute } from './registerBugReportDiagnosticsRoute';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('local owner bug report diagnostics transport', () => {
  it('requires the owner token and invokes the admitted provider contribution for exactly the selected session', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-report-owner-route-' }, async ({ homeDir }) => {
      const providerHome = join(homeDir, 'codex');
      const vendorId = '019e7cfd-2e3d-74f0-be76-b7459424f0a8';
      const directory = join(providerHome, 'sessions', '2026', '10', '30');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `rollout-2026-10-30T10-00-00-${vendorId}.jsonl`), 'SELECTED_PROVIDER_BODY');
      await writeFile(join(directory, 'unrelated.jsonl'), 'UNRELATED_PROVIDER_BODY');
      await writeSessionMarker({ trackingKey: legacyPidSessionTrackingKey(12345), pid: 12345, happySessionId: 'selected-session', metadata: {
        flavor: 'codex', codexSessionId: vendorId,
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer', providerSessionId: vendorId, homePath: providerHome } },
      } });
      const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
      const app = fastify();
      registerBugReportDiagnosticsRoute(app, { controlToken: 'fixture-owner-token', machineId: 'machine-a' });
      const payload = { sessionId: 'selected-session', logSelection: { daemon: false, session: false, provider: true } };
      try {
        const denied = await app.inject({ method: 'POST', url: '/diagnostics/bug-report/collect', payload });
        expect(denied.statusCode).toBe(401);
        expect(denied.body).not.toContain('SELECTED_PROVIDER_BODY');
        const response = await app.inject({ method: 'POST', url: '/diagnostics/bug-report/collect',
          headers: { 'x-happier-daemon-token': 'fixture-owner-token' }, payload });
        expect(response.statusCode).toBe(200);
        const result = BugReportMachineDiagnosticsSnapshotSchema.parse(response.json());
        expect(result.sessionDiagnostics?.logs.find(log => log.kind === 'provider')?.artifact?.content).toBe('SELECTED_PROVIDER_BODY');
        expect(response.body).not.toContain('UNRELATED_PROVIDER_BODY');
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback fixture address');
        writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: 1,
          startedWithCliVersion: 'fixture', controlToken: 'fixture-owner-token' });
        const host = await collectBugReportMachineDiagnosticsOnHost(payload);
        expect(host.sessionDiagnostics?.logs.find(log => log.kind === 'provider')?.artifact?.content).toBe('SELECTED_PROVIDER_BODY');
        const priorDaemon = fastify();
        await priorDaemon.listen({ host: '127.0.0.1', port: 0 });
        try {
          const priorAddress = priorDaemon.server.address();
          if (!priorAddress || typeof priorAddress === 'string') throw new Error('Expected prior daemon fixture address');
          writeDaemonState({ pid: process.pid, httpPort: priorAddress.port, startedAt: 1,
            startedWithCliVersion: 'fixture', controlToken: 'fixture-owner-token' });
          const unavailable = await collectBugReportMachineDiagnosticsOnHost(payload);
          expect(unavailable.sessionDiagnostics?.logs.find(log => log.kind === 'provider')?.status).toBe('unavailable');
          expect(JSON.stringify(unavailable)).not.toContain('SELECTED_PROVIDER_BODY');
        } finally { await priorDaemon.close(); }
        const technical = await app.inject({ method: 'POST', url: '/diagnostics/bug-report/collect',
          headers: { 'x-happier-daemon-token': 'fixture-owner-token' }, payload: { ...payload,
            logSelection: { daemon: false, session: false, provider: false } } });
        expect(technical.body).not.toContain('SELECTED_PROVIDER_BODY');
      } finally { await app.close(); await runtime.dispose(); }
    });
  });
});
