// Register the genuine Home/control boundary fixture before the real Run graph
// loads those transports. Internal Run and Provider owners remain unchanged.
import { createAttachedManagedRunFixture, createAttachedManagedRunControlTransport } from './startDaemonSessionControlRuntime.accountManagedRun.testkit';
import { Server } from 'node:http';
import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createExecutionRunManagedProviderEndpointPreparer } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import { createRunnerManagedProviderRunSourceOpener } from '@/agent/runtime/session/process/runnerManagedProviderConsumerAccess';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

const { directory, originalHome } = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')]);
  const directory = await mkdtemp(join(tmpdir(), 'happier-managed-run-prepublication-'));
  const originalHome = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = join(directory, 'home');
  return { directory, originalHome };
});

it('retains prepublication managed source cleanup in the actual rejected Run controller when listener creation and immediate closes fail', async () => {
  let manager: ExecutionRunHostBridge | null = null;
  let authorityStatus: string | null = null;
  const fixture = await createAttachedManagedRunFixture({ directory, issuedRequester: true, resolveRunAuthority: request => {
    if (!manager) throw new Error('Expected actual admitted Run owner before authority RPC');
    const result = manager.resolveLiveBrokerAuthority(request);
    authorityStatus = result.status === 'current' ? `current:${result.parentSessionId}` : result.reason;
    return result;
  } });
  let transport: Awaited<ReturnType<typeof createAttachedManagedRunControlTransport>> | null = null;
  let closeFailuresRemaining = 2;
  let listenerFaultArmed = false;
  let privateRefusal: Readonly<{ operation: string; code: string }> | null = null;
  let privateGuard: Readonly<{ managed: boolean; sharing: string | undefined; transport: string | undefined; scopeMatches: boolean }> | null = null;
  try {
    transport = await createAttachedManagedRunControlTransport(fixture, {
      beforeDispatch(request) {
        if (request.operation.kind === 'provider_managed.binding.open') {
          const basis = request.operation.runtimeBindingBasis;
          privateGuard = { managed: basis.deployment.kind === 'managedLocal',
            sharing: basis.deployment.kind === 'managedLocal' ? basis.deployment.managedRuntime.sharing : undefined,
            transport: basis.runtimeCredentialTransport?.destination.kind,
            scopeMatches: request.operation.expectedAccountSettingsScopeKey === fixture.proof.expectedAccountSettingsScopeKey };
        }
        if (request.operation.kind === 'provider_managed.binding.close' && closeFailuresRemaining > 0) {
          closeFailuresRemaining -= 1;
          return new Response('', { status: 503 });
        }
        return null;
      },
      afterDispatch(request, response) {
        if (!response.ok) privateRefusal = { operation: request.operation.kind, code: response.error.code };
        if (request.operation.kind !== 'provider_managed.binding.open' || !response.ok || listenerFaultArmed) return;
        listenerFaultArmed = true;
        // OS listener creation is the failure boundary. The daemon has already
        // acquired its real source; only the subsequent runner listener fails.
        vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(() => {
          throw Object.assign(new Error('Fixture listen refused'), { code: 'EADDRINUSE' });
        });
      },
    });
    const requester = fixture.requester;
    if (!requester) throw new Error('Expected genuine issued Session Account context');
    const readSnapshot = async () => requester.readAccountSettingsSnapshot();
    const accountId = readAccountIdFromToken(requester.bootstrap.credentials.token);
    if (!accountId) throw new Error('Expected authenticated fixture Account');
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
    const started = await manager.start({ sessionId: 'parent-session', intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: fixture.fixture.agentId },
      modelSelection: { agentTargetKey: fixture.fixture.agentTargetKey, providerConnectionId: 'run-gateway', modelId: 'example' },
      accountSettings: requester.readAccountSettingsSnapshot().settings, instructions: 'This Agent must never open after listener failure.',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' });
    await manager.waitForTerminal(started.runId);
    expect(manager.get(started.runId)?.status).toBe('failed');
    expect(listenerFaultArmed, JSON.stringify({ summary: manager.get(started.runId)?.summary, privateRefusal, privateGuard,
      authorityStatus, sourceDiagnostics: fixture.sourceDiagnostics })).toBe(true);
    expect(closeFailuresRemaining).toBe(0);
    await manager.dispose();
    const binding = transport.readBinding();
    // Observe transport retirement without sending an authorization-rechecking
    // request that could itself cause the stale source to clean up.
    const endpoint = new URL(binding.endpointUrl);
    const accepting = await new Promise<boolean>(resolve => {
      const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    expect(accepting).toBe(false);
  } finally {
    vi.restoreAllMocks();
    await manager?.dispose();
    await transport?.cleanup();
    await fixture.cleanup();
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
  }
});
