import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { openExactSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from '@/providers/broker/providerBrokerPrivateProtocol';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { verifySpawnResumeReachability } from '../verifySpawnResumeReachability';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import type { ApiClient } from '@/api/api';
import { formatPiSessionDirectoryForCwd } from '@happier-dev/plugins-pi/agent/sessionFiles';
import { hostBoundaries } from '../../../../../../packages/plugins/pi/src/agent/runtime/nativeProcess.test-support';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';

describe('Team Pi brokered native Session continuity', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.pi', 'happier.agent.codex', 'happier.agent.opencode'] } });
  });
  afterAll(async () => { await runtime?.dispose(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(['pi', 'codex', 'opencode'])('prepares a private member %s home for a Team broker-only launch', async agentId => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-home-'));
    const memberHome = join(root, 'member', 'session');
    const owner = createForegroundPurposeOwnerFixture({
      consumer: { pluginId: `happier.agent.${agentId}`, localId: agentId },
      service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'unused',
      materializeAccount: async () => { throw new Error('Team broker must not acquire personal credentials'); },
    }).owner;
    let result: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
    try {
      result = await resolveConnectedServiceAuthForSpawn({
        agentId, materializationKey: 'member-session', sessionId: 'member-session',
        agentLaunchTarget: { runtimeHome: memberHome }, allowNativeAccountState: false,
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
          'happier.agent.muse/muse-account': { source: 'team_resource', resourceId: 'shared-muse', deliveryMode: 'brokered' },
        } }, connectedAccountsOwner: owner,
        resolveQualifiedPurposeBindingSnapshot: bindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId, bindings, contributions: runtime.registry.contributes,
        }),
        activateQualifiedPurposeBindings: snapshot => owner.activateSessionPurposeBindings({
          sessionId: 'member-session', purposes: snapshot.purposes, bindings: snapshot.bindings,
        }),
        api: {} as ApiClient, credentials: { token: 'synthetic', encryption: null },
        processEnv: { HOME: join(root, 'custodian'), OPENAI_API_KEY: 'custodian-secret' },
      });
      expect(result).not.toBeNull();
      const child = await resolveSpawnChildEnvironment({ options: { directory: root }, resolvedAgentId: agentId,
        pluginRuntimeRegistry: runtime.registry, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
        // Executable discovery is an OS boundary; use a real executable. This
        // test composes the environment without starting a vendor process.
        processEnv: { OPENAI_API_KEY: 'custodian-secret', [`HAPPIER_${agentId.toUpperCase()}_PATH`]: process.execPath },
        providerBindingContext: { v: 1, agentTargetKey: agentId, modelId: 'fixture-model' },
        logDebug() {}, logInfo() {}, logWarn() {},
        allowNativeAccountCredentials: false, connectedServiceAuth: result });
      expect(child, child.ok ? undefined : child.errorMessage).toMatchObject({ ok: true });
      const descriptor = await (await runtime.registry.acquireAgentCatalogEntry!(agentId))!.getConnectedServiceStateSharingDescriptor!();
      const homeKey = descriptor!.nativeHome!.environmentKey;
      expect(result!.agentLaunchMaterials!.environment[homeKey]).toBe(join(memberHome, 'native-home'));
      expect(result!.agentLaunchMaterials!.selectedMaterials).toEqual([]);
      await expect(stat(join(root, 'custodian'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await result?.materializationPurposeLease?.dispose();
      await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['codex', 'opencode'] as const)('leaves unrelocated %s Session storage with the native runtime', async agentId => {
    const root = await mkdtemp(join(tmpdir(), 'team-native-resume-'));
    const owner = createForegroundPurposeOwnerFixture({
      consumer: { pluginId: `happier.agent.${agentId}`, localId: agentId },
      service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'unused',
      materializeAccount: async () => { throw new Error('Unexpected personal credential access'); },
    }).owner;
    let result: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
    try {
      result = await resolveConnectedServiceAuthForSpawn({
        agentId, materializationKey: 'team-session', sessionId: 'team-session',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
          'happier.agent.muse/muse-account': { source: 'team_resource', resourceId: 'shared-muse', deliveryMode: 'brokered' },
        } },
        connectedAccountsOwner: owner,
        resolveQualifiedPurposeBindingSnapshot: bindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
          agentId, bindings, contributions: runtime.registry.contributes,
        }),
        activateQualifiedPurposeBindings: snapshot => owner.activateSessionPurposeBindings({
          sessionId: 'team-session', purposes: snapshot.purposes, bindings: snapshot.bindings,
        }),
        // Any unexpected personal Account HTTP request fails at this boundary.
        api: {} as ApiClient,
        credentials: { token: 'synthetic', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        processEnv: { HOME: root }, vendorResumeId: '019e461b-0000-7000-8000-000000000000',
        resumeReachabilityRequired: true,
      });
      expect(result).not.toBeNull();
      expect(result?.targetMaterializedRoot).toBeNull();
    } finally {
      await result?.materializationPurposeLease?.dispose();
      await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('proves the native Session written through the Team binding after Stop and rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-pi-resume-'));
    const nativeHome = join(root, 'native');
    const cwd = join(root, 'project');
    const sessionId = 'team-pi-session';
    const nativeSessionId = 'pi-session-fixture';
    const results: NonNullable<Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>>>[] = [];
    let binding: Awaited<ReturnType<typeof openExactSessionTeamCredentialProviderBinding>> | undefined;
    let nativeSession: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof runtime.lease.registry.agentRuntimesByAgentId.get>>['createRuntime']>['sessions']['open']>> | undefined;
    try {
      vi.stubEnv('PI_CODING_AGENT_DIR', nativeHome);
      // The broker HTTP boundary supplies only synthetic endpoint metadata.
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204,
        headers: { [PROVIDER_BROKER_ENDPOINT_PATH_HEADER]: '/v1' } })));
      const owner = createForegroundPurposeOwnerFixture({
        consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
        service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, accountId: 'unused',
        materializeAccount: async () => { throw new Error('Team broker must not acquire a personal credential'); },
      }).owner;
      const materialize = async (vendorResumeId?: string) => {
        const result = await resolveConnectedServiceAuthForSpawn({
          agentId: 'pi', materializationKey: sessionId, sessionId,
          activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), sessionDirectory: cwd,
          connectedAccountsOwner: owner,
          connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
            'happier.agent.muse/muse-account': { source: 'team_resource', resourceId: 'shared-muse', deliveryMode: 'brokered' },
          } },
          resolveQualifiedPurposeBindingSnapshot: bindings => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            agentId: 'pi', bindings, contributions: runtime.registry.contributes,
          }),
          activateQualifiedPurposeBindings: snapshot => owner.activateSessionPurposeBindings({
            sessionId, purposes: snapshot.purposes, bindings: snapshot.bindings,
          }),
          // Team delivery must not call the personal Account HTTP boundary.
          api: {} as ApiClient,
          credentials: { token: 'synthetic', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
          vendorResumeId, resumeReachabilityRequired: true,
          processEnv: { PI_CODING_AGENT_DIR: nativeHome },
        });
        if (!result) throw new Error('Expected launch materialization');
        results.push(result);
        return result;
      };
      const first = await materialize();
      const application = { agentTargetKey: 'agent:happier.agent.pi/pi',
        implementationIdentity: { pluginId: 'happier.agent.muse', localId: 'muse-account' },
        endpointTemplateId: 'chat', protocol: 'openai-responses' as const };
      const open = () => openExactSessionTeamCredentialProviderBinding({
        sessionId, machineId: 'worker', agentId: 'pi', lease: runtime.lease,
        materializationBaseDir: join(root, 'provider'), signal: new AbortController().signal,
        selection: { resourceId: 'shared-muse', brokerMachineId: 'broker', expectedResourceRevision: 1,
          agentTargetKey: application.agentTargetKey, modelId: 'muse-spark-1.2',
          descriptor: { id: 'muse-spark-1.2', name: 'Muse Spark' }, application, sourceRevision: 'catalog:1',
          sourceFacts: { endpoint: { id: 'chat', protocol: 'openai-responses', capabilities: {
            streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' } },
            credential: { kind: 'apiKey', required: true, slotId: 'apiKey', transports: [{ id: 'bearer',
              protocols: ['openai-responses'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }] },
            compatibilityOverrides: [{ agentTargetKey: application.agentTargetKey, protocol: 'openai-responses', status: 'verified',
              reason: 'Synthetic broker contract', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-11-12' } }] } },
        // Signed admission and the carrier are remote system boundaries.
        openBroker: async () => ({ ok: true, authority: { payload: {
          v: 1, grantId: 'grant', aud: 'happier-provider-broker-route-v1', issuedAt: 1, expiresAt: 2,
          teamId: 'team', resourceId: 'shared-muse', brokerPlacementFingerprint: 'c'.repeat(64), initiatorTokenEpoch: 0,
          sourceRevision: 'catalog:1', initiator: { accountId: 'member', machineId: 'worker', endpointId: 'a'.repeat(64) },
          target: { custodianAccountId: 'owner', machineId: 'broker', endpointId: 'b'.repeat(64) },
          consumer: { kind: 'session', sessionId }, application,
        }, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'A'.repeat(86) } },
        target: { custodianAccountId: 'owner', brokerMachineId: 'broker', endpointId: 'b'.repeat(64), endpointRevision: 1,
          endpoint: { endpointId: 'b'.repeat(64) } } }),
        openTunnel: async () => ({ localPort: 43123, localCapability: 'c'.repeat(64), observedPath: 'relay',
          retire: async () => undefined, close: async () => undefined }),
      });
      binding = await open();
      const launchHome = binding.environmentOverlay.find(entry => entry.name === 'PI_CODING_AGENT_DIR')?.value;
      if (!launchHome) throw new Error('Expected Pi native-home overlay');
      expect(await realpath(join(launchHome, 'sessions'))).toBe(join(nativeHome, 'sessions'));
      // Pi's native process boundary writes its normal Session file through the real linked directory.
      const sessionDirectory = join(launchHome, 'sessions', formatPiSessionDirectoryForCwd(cwd));
      const sessionFile = join(sessionDirectory, `2026-11-12T13-00-00-000Z_${nativeSessionId}.jsonl`);
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(sessionFile, JSON.stringify({ id: nativeSessionId }) + '\n');
      await binding.cleanup();
      binding = undefined;
      await first.materializationPurposeLease?.dispose();
      await first.cleanupOnExit?.();
      expect(await stat(join(nativeHome, 'sessions', formatPiSessionDirectoryForCwd(cwd), `2026-11-12T13-00-00-000Z_${nativeSessionId}.jsonl`)))
        .toMatchObject({ size: expect.any(Number) });
      const resumed = await materialize(nativeSessionId);
      binding = await open();
      const resumedHome = binding.environmentOverlay.find(entry => entry.name === 'PI_CODING_AGENT_DIR')?.value;
      if (!resumedHome) throw new Error('Expected resumed Pi native-home overlay');
      expect(await realpath(join(resumedHome, 'sessions'))).toBe(join(nativeHome, 'sessions'));
      expect(await verifySpawnResumeReachability({ agentId: 'pi', vendorResumeId: nativeSessionId,
        materializedEnv: { PI_CODING_AGENT_DIR: resumedHome, HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: resumedHome }, cwd }))
        .toEqual({ ok: true, resolvedPath: join(nativeHome, 'sessions', formatPiSessionDirectoryForCwd(cwd),
          `2026-11-12T13-00-00-000Z_${nativeSessionId}.jsonl`) });
      expect(resumed.targetMaterializedRoot).toBeNull();
    } finally {
      await binding?.cleanup();
      for (const result of results) {
        await result.materializationPurposeLease?.dispose();
        await result.cleanupOnExit?.();
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
