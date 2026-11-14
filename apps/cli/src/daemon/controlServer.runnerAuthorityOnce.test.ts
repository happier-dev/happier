import { describe, expect, it, vi } from 'vitest';

/**
 * The authority file and the plugin store (hard-revocation revision) are the disk boundaries the runner service route reads.
 * The file reader is wrapped to count reads; parsing, capability verification, drain, turn decision
 * and the route's currentness checks stay real.
 */
const reads = vi.hoisted(() => ({ authority: 0, hardRevocation: 0 }));
vi.mock('./agentRuntime/sessionBridgeAuthorization', async (original) => {
  const actual = await original<typeof import('./agentRuntime/sessionBridgeAuthorization')>();
  return {
    ...actual,
    readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker: async (
      ...args: Parameters<typeof actual.readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker>
    ) => { reads.authority += 1; return await actual.readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker(...args); },
  };
});
vi.mock('@/plugins/store/registry/generationStore', async (original) => {
  const actual = await original<typeof import('@/plugins/store/registry/generationStore')>();
  return {
    ...actual,
    readCurrentPluginHardRevocationRevision: async (
      ...args: Parameters<typeof actual.readCurrentPluginHardRevocationRevision>
    ) => { reads.hardRevocation += 1; return await actual.readCurrentPluginHardRevocationRevision(...args); },
  };
});

import { configuration } from '@/configuration';
import { AGENT_RUNTIME_DAEMON_SERVICES_PATH } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createDaemonControlApp } from './controlServer';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from './agentRuntime/sessionBridgeAuthorization';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { removeSessionMarker, writeSessionMarker } from './sessionRegistry';
import type { TrackedSession } from './types';

const capabilityA = 'A'.repeat(43);

describe('daemon control server: runner service authority per request', () => {
  it('resolves the runner authority once per request and reads no plugin revocation; replacement still ends currentness', async () => {
    const sessionId = 'runner-authority-once-session';
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'npm' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    });
    const runner = { pid: 2251, processStartTimeMs: 1_717_171_717_901,
      processCommandHash: 'e'.repeat(64), snapshotIdentity: 'snapshot:runner-authority-once' };
    const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing });
    const authority = await publishAgentRuntimeDaemonServiceAuthority({
      happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path: authorityPath, sessionId, runner, retainedAgent, httpPort: 46_011,
      capability: capabilityA, readPluginHardRevocationRevision: async () => 0 });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(runner.pid), startedBy: 'daemon', pid: runner.pid,
      sessionRunnerPid: runner.pid, happySessionId: sessionId, processStartTimeMs: runner.processStartTimeMs,
      processCommandHash: runner.processCommandHash, agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
      agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest, runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
      runnerAgentInvocationContext: { cwd: '/workspace', environment: {}, providerBindingActive: false } };
    let isCurrent: (() => Promise<boolean>) | null = null;
    const app = createDaemonControlApp({ getChildren: () => [tracked], machineId: 'guest', admissionDrain: createDaemonAdmissionDrain(),
      stopSession: async () => ({ status: 'not_found' as const }), spawnSession: async () => ({ type: 'success' as const, sessionId }),
      requestShutdown() {}, onHappySessionWebhook() {}, controlToken: 'control-token',
      agentRuntimeDaemonServices: { dispatch: async (_request, subject) => {
        isCurrent = subject.isCurrent;
        // A long-running service step re-checks its own admitted request once.
        expect(await subject.isCurrent()).toBe(true);
        return { ok: true, result: { kind: 'connected_account.identity.observed' } };
      } } });
    const observation = { kind: 'connected-account-identity-observed', sequence: 1, sessionId,
      emittedAtMs: 100, observedAtMs: 99, service: { pluginId: 'acme.plugin', localId: 'subscription' },
      nativeSessionId: 'native-1', providerOrganizationId: 'org-1' };
    try {
      await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: runner.pid, happySessionId: sessionId,
        startedBy: 'daemon', cwd: '/workspace' });
      reads.authority = 0;
      reads.hardRevocation = 0;
      const response = await app.inject({ method: 'POST', url: AGENT_RUNTIME_DAEMON_SERVICES_PATH,
        headers: { 'x-happier-daemon-token': capabilityA },
        payload: { v: 1, context: { token: capabilityA, sessionId },
          operation: { kind: 'connected_account.identity.observe', observation } } });
      expect(response.statusCode).toBe(200);
      expect([reads.authority, reads.hardRevocation]).toEqual([1, 0]);
      // The runner's authority is replaced (refresh rotates the capability): the admitted request is no longer current.
      tracked.agentRuntimeDaemonServiceCapabilityHash = 'f'.repeat(64);
      expect(await isCurrent!()).toBe(false);
      tracked.agentRuntimeDaemonServiceCapabilityHash = authority.capabilityDigest;
      expect(await isCurrent!()).toBe(true);
      // The runner is replaced (another process generation): not current.
      tracked.processStartTimeMs = runner.processStartTimeMs + 1;
      expect(await isCurrent!()).toBe(false);
    } finally {
      await app.close();
      await removeSessionMarker(tracked.trackingKey);
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path: authorityPath, capabilityDigest: authority.capabilityDigest });
    }
  });
});
