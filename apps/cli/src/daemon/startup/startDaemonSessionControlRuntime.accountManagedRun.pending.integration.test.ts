// Boundary registration must precede imports that capture Home transports.
import { createAttachedManagedRunFixture, createAttachedManagedRunControlTransport } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { Server } from 'node:http';
import { connect } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createExecutionRunManagedProviderEndpointPreparer } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import { createRunnerManagedProviderRunSourceOpener } from '@/agent/runtime/session/process/runnerManagedProviderConsumerAccess';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

const { directory, originalHome } = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')]);
  const directory = await mkdtemp(join(tmpdir(), 'happier-managed-run-pending-'));
  const originalHome = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = join(directory, 'home');
  return { directory, originalHome };
});

it('joins pending actual Run preparation before retiring its retained failed source closer', async () => {
  let manager: ExecutionRunHostBridge | null = null;
  const fixture = await createAttachedManagedRunFixture({ directory, issuedRequester: true, resolveRunAuthority: request => {
    if (!manager) throw new Error('Expected actual admitted Run controller');
    return manager.resolveLiveBrokerAuthority(request);
  } });
  let transport: Awaited<ReturnType<typeof createAttachedManagedRunControlTransport>> | null = null;
  let releaseClose!: () => void;
  let reachedClose!: () => void;
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const closeReached = new Promise<void>(resolve => { reachedClose = resolve; });
  let closeFailuresRemaining = 2;
  let listenerFaultArmed = false;
  try {
    transport = await createAttachedManagedRunControlTransport(fixture, {
      async beforeDispatch(request) {
        if (request.operation.kind !== 'provider_managed.binding.close' || closeFailuresRemaining === 0) return null;
        if (closeFailuresRemaining === 2) { reachedClose(); await closeGate; }
        closeFailuresRemaining -= 1;
        return new Response('', { status: 503 });
      },
      afterDispatch(request, response) {
        if (request.operation.kind !== 'provider_managed.binding.open' || !response.ok || listenerFaultArmed) return;
        listenerFaultArmed = true;
        vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(() => {
          throw Object.assign(new Error('Fixture listen refused'), { code: 'EADDRINUSE' });
        });
      },
    });
    const requester = fixture.requester;
    if (!requester) throw new Error('Expected genuine issued Session Account context');
    const accountId = readAccountIdFromToken(requester.bootstrap.credentials.token);
    if (!accountId) throw new Error('Expected authenticated fixture Account');
    const readSnapshot = async () => requester.readAccountSettingsSnapshot();
    const purposeResolver = requester.resolveManagedPurposeBindingIntent;
    const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.fixture.lease.registry });
    const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
      resolveAgentIdentity: () => ({ pluginId: fixture.context.retainedAgent.pluginId, localId: fixture.context.retainedAgent.localAgentId }),
    });
    manager = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.fixture.happyHomeDir,
      happyHomeDir: fixture.fixture.happyHomeDir, machineId: fixture.fixture.machineId, sendAcp: async () => {},
      resolveProvidersFeatureEnabled: () => true, resolveAccountSettingsSnapshot: readSnapshot,
      resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }),
      resolveManagedPurposeBindingIntent: purposeResolver,
      prepareManagedEndpoint: createExecutionRunManagedProviderEndpointPreparer({ machineId: fixture.fixture.machineId, accountId,
        readAccountSettingsSnapshot: readSnapshot, resolveManagedPurposeBindingIntent: purposeResolver,
        openSource: createRunnerManagedProviderRunSourceOpener({ services: transport.services, isOwnerCurrent: async () => true }),
      }),
    });
    await manager.start({ sessionId: 'parent-session', intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: fixture.fixture.agentId },
      modelSelection: { agentTargetKey: fixture.fixture.agentTargetKey, providerConnectionId: 'run-gateway', modelId: 'example' },
      accountSettings: requester.readAccountSettingsSnapshot().settings, instructions: 'Never open after failed preparation.',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
    await closeReached;
    let disposed = false;
    const disposal = manager.dispose().then(() => { disposed = true; });
    await setImmediate();
    expect(disposed).toBe(false);
    releaseClose();
    await disposal;
    expect(closeFailuresRemaining).toBe(0);
    const endpoint = new URL(transport.readBinding().endpointUrl);
    const accepting = await new Promise<boolean>(resolve => {
      const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    expect(accepting).toBe(false);
  } finally {
    releaseClose();
    vi.restoreAllMocks();
    await manager?.dispose();
    await transport?.cleanup();
    await fixture.cleanup();
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
  }
});
