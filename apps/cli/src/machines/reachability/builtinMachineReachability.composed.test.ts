// Install the genuine OS boundary before importing production native owners.
import { createDockerNetworkAuthoredProvider, createGenericDefaultFactoryJourney, executeReviewedReachabilityConfigure,
  journey, machineId, parseCompletedReachabilityConfigure, parseReachabilityInspectResult, selection,
} from './genericMachineReachability.testkit';
import { userInfo } from 'node:os';
import { unlink } from 'node:fs/promises';
import { resolveMachineEffectCli } from '../adminAccess/machineEffectCli';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeCaddyImage, nativeCaddyProfile, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import type { AccessProviderSelectionV1 } from '@happier-dev/plugin-sdk/access-providers';
import { relayAccessProviderDescriptors } from '@happier-dev/cli-common/relayAccess/catalog';
import { MachineReachabilityPostureV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';

const builtin = (withKey: boolean): AccessProviderSelectionV1 => ({
  provider: { kind: 'builtin', id: 'tailscale' }, config: {}, credentialRefs: withKey ? selection.credentialRefs : [],
});

describe.runIf(process.platform === 'linux' && userInfo().uid !== 0)('builtin Machine reachability through the reviewed host Actions', () => {
  async function fixture(withKey: boolean) {
    // An unrelated installed contribution remains present, proving that a
    // builtin selection neither fabricates nor borrows its plugin identity.
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    const selected = builtin(withKey);
    const f = await journey('external', [], { authoredProvider, providerSelection: selected, builtinTailscale: true });
    await f.os.installEngineProbeTools();
    const api = await createGenericDefaultFactoryJourney(f);
    // Adoption must not opportunistically change a different existing operator;
    // a managed key join must bind operator setup to the captured daemon identity.
    f.hostNative.setTailscaleOperator('another-operator');
    return { f, api, selected };
  }

  // Reuse the generic journey's Server QB87 Home-acquisition budget. The
  // observable Action bodies keep the CLI's unchanged 30-second budget.
  describe('without a selected key', () => {
    let prepared: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => { prepared = await fixture(false); }, 120_000);

  it('cancels an unanswered Network CHECK password at the existing operation owner before elevation', async () => {
    const { f, api } = prepared;
    let taskId: string | undefined;
    let pending: ReturnType<typeof api.inspectOriginalCli> | undefined;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion,
        metadata: { ...snapshot.metadata, adminAccess: { version: 1, mode: 'ask', administratorUsername: 'ops.admin' } } }))
        .toMatchObject({ status: 'applied' });
      pending = api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId });
      let operationId: string | undefined;
      await vi.waitFor(async () => {
        const operations = await api.listOperations();
        const held = operations.items.find(operation => operation.domainRef?.kind === 'machineSetup'
          && operation.domainRef.setupTask?.prompt?.kind === 'sudo.password');
        expect(held).toBeDefined();
        operationId = held?.operationId;
        if (held?.domainRef?.kind === 'machineSetup') taskId = held.domainRef.setupTask?.id;
      });
      const held = (await api.listOperations()).items.find(operation => operation.operationId === operationId);
      expect(held).toMatchObject({ state: 'running', cancellation: 'supported' });
      expect(f.elevation.launches).toEqual([]);
      expect(await api.invoke(ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId })).toEqual({ kind: 'requested' });
      expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect((await api.listOperations()).items.find(operation => operation.operationId === operationId))
        .toMatchObject({ state: 'cancelled' });
      expect(f.elevation.launches).toEqual([]);
      expect(f.hostNative.firewallStages).toEqual([]);
    } finally {
      if (taskId) await getLiveSystemTasksRunnerAdapter().cancel({ taskId });
      await pending;
      await api.dispose();
    }
  });

  it('preserves Ask administrator refusal and remedy in the Action and serialized Activity before a password', async () => {
    const { f, api } = prepared;
    const daemonUsername = f.identity.daemon.username;
    // The OS fixture's account facts feed the observer captured by the real
    // routes; choose an admissible daemon name independent of the test host.
    f.identity.daemon.username = 'ops.admin';
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion,
        metadata: { ...snapshot.metadata, adminAccess: { version: 1, mode: 'ask', administratorUsername: 'ops.admin' } } }))
        .toMatchObject({ status: 'applied' });
      const seenOperations = new Set((await api.listOperations()).items.map(operation => operation.operationId));
      const result = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId });
      expect(result).toMatchObject({ ok: false, errorCode: 'native_check_unavailable', details: {
        failure: { kind: 'native_check_unavailable', requiredFact: 'distinctAdministrator', remedy: expect.any(String) },
        remedy: expect.any(String),
      } });
      const operation = (await api.listOperations()).items.find(candidate => !seenOperations.has(candidate.operationId)
        && candidate.actionId === 'machines.reachability.inspect');
      expect(operation).toMatchObject({ state: 'failed', error: { errorCode: 'native_check_unavailable', details: {
        failure: { kind: 'native_check_unavailable', requiredFact: 'distinctAdministrator', remedy: expect.any(String) },
        remedy: expect.any(String),
      } } });
      expect(f.elevation.launches).toEqual([]);
      expect(f.hostNative.firewallStages).toEqual([]);
      expect(f.home.approvalRequests()).toEqual([]);
      expect((await api.listOperations()).items.flatMap(candidate => candidate.domainRef?.kind === 'machineSetup'
        ? [candidate.domainRef.setupTask?.prompt].filter(Boolean) : [])).toEqual([]);
    } finally { f.identity.daemon.username = daemonUsername; await api.dispose(); }
  });

  it('preserves the native Caddy fact and recovery through one root CHECK when daemon Docker is denied', async () => {
    const { f, api } = prepared;
    try {
      await f.hostNative.setNativeSshPort(22);
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const current = MachineReachabilityPostureV1Schema.parse(snapshot.metadata.reachabilityPosture);
      const posture = { ...current, revision: current.revision + 1,
        management: { ...current.management, publicSsh: { kind: 'closed' as const },
          independentRecovery: { kind: 'providerConsole' as const, evidence: 'userAttested' as const, confirmedAtMs: 1_793_610_000_000 } } };
      const container = { Id: 'owned-caddy', Name: '/happier-caddy',
        Config: { Image: nativeCaddyImage, Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'],
          Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' } },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [], Binds: null,
          PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }] } },
        State: { Running: false }, NetworkSettings: { Networks: {}, Ports: null } };
      const runNative = f.hostNative.runNative;
      const docker = vi.spyOn(f.hostNative, 'runNative').mockImplementation(async command => {
        if (command.executable !== 'docker' || command.args[0] !== 'container') return runNative(command);
        if (process.getuid?.() !== 0) return { code: 1, stdout: '', stderr: 'private Docker permission diagnostic' };
        if (command.args[1] === 'ls') return { code: 0, stdout: JSON.stringify(container.Id), stderr: '' };
        if (command.args[1] === 'inspect') return { code: 0, stdout: JSON.stringify([container]), stderr: '' };
        throw new Error('Caddy review must not mutate Docker');
      });
      try {
        const result = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
          change: { kind: 'posture', posture } });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const inspected = parseReachabilityInspectResult(result.ok ? result.result : result);
        expect(inspected.plan?.basis.firewallTransition?.intent.caddy.publicBindings).toEqual([
          { requirementId: nativeCaddyProfile.publicPortRequirements[0].id, exposure: 'public', protocol: 'tcp',
            containerPort: 80, hostPort: 80, hostAddress: '0.0.0.0' },
        ]);
        expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).map(request => request.mode)).toEqual(['check']);
        expect(api.client.getMachineMetadataSnapshot()).toEqual(snapshot);
        expect(f.hostNative.firewallStages).toEqual([]);
      } finally { docker.mockRestore(); }
    } finally { await api.dispose(); }
  });

  it('preserves the native Caddy fact and recovery when SSH closure review cannot inventory Docker', async () => {
    const { f, api } = prepared;
    try {
      await f.hostNative.setNativeSshPort(22);
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const current = MachineReachabilityPostureV1Schema.parse(snapshot.metadata.reachabilityPosture);
      const posture = { ...current, revision: current.revision + 1,
        management: { ...current.management, publicSsh: { kind: 'closed' as const },
          independentRecovery: { kind: 'providerConsole' as const, evidence: 'userAttested' as const, confirmedAtMs: 1_793_610_000_000 } } };
      const nativeFailures = [
        { code: null, errorCode: 'ENOENT', stdout: '', stderr: '' },
        { code: 1, stdout: '', stderr: 'private Docker permission diagnostic' },
        { code: 1, stdout: '', stderr: 'private Docker transport diagnostic' },
        { code: 0, stdout: 'private malformed Docker inventory', stderr: '' },
      ] satisfies MachineSetupNativeCommandResult[];
      let nativeFailure = nativeFailures[0]!;
      const runNative = f.hostNative.runNative;
      // Docker execution is the OS boundary. The CLI, Home admission, daemon
      // route, task, producer and Action failure projection remain real.
      const docker = vi.spyOn(f.hostNative, 'runNative').mockImplementation(command =>
        command.executable === 'docker' && command.args[0] === 'container' && command.args[1] === 'ls'
          ? Promise.resolve(nativeFailure) : runNative(command));
      try {
        const seenOperations = new Set((await api.listOperations()).items.map(operation => operation.operationId));
        for (const failure of nativeFailures) {
          nativeFailure = failure;
          const result = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
            change: { kind: 'posture', posture } });
          expect(result).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable', effectAttempted: false,
            details: { requiredFact: 'caddyContainer',
              failure: { kind: 'native_observation_unavailable', requiredFact: 'caddyContainer',
                ...(failure.errorCode ? { errorCode: failure.errorCode } : {}) },
              remedy: expect.any(String) } });
          expect(JSON.stringify(result)).not.toContain('private ');
          const operation = (await api.listOperations()).items.find(candidate => !seenOperations.has(candidate.operationId)
            && candidate.actionId === 'machines.reachability.inspect');
          expect(operation).toMatchObject({ state: 'failed', error: { errorCode: 'required_fact_unavailable',
            details: { requiredFact: 'caddyContainer', failure: { kind: 'native_observation_unavailable',
              requiredFact: 'caddyContainer' }, remedy: expect.any(String) } } });
          if (operation) seenOperations.add(operation.operationId);
        }
      } finally { docker.mockRestore(); }
      expect(api.client.getMachineMetadataSnapshot()).toEqual(snapshot);
      expect(f.home.approvalRequests()).toEqual([]);
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).map(request => request.mode))
        .toEqual(nativeFailures.map(() => 'check'));
      expect(f.hostNative.firewallStages).toEqual([]);
    } finally { await api.dispose(); }
  });

  it.each([false, true])('inspects a Machine without a saved posture through its canonical Home identity (managed CLI installed: %s)', async installed => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const { reachabilityPosture: _posture, ...metadata } = snapshot.metadata;
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion, metadata }))
        .toMatchObject({ status: 'applied' });
      const { installedCli: executablePath } = resolveMachineEffectCli();
      if (!installed) await unlink(executablePath);
      const result = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId });
      if (installed) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({ ok: true, result: { posture: null,
          observation: { nativeFirewall: { status: 'unavailable', requiredFact: expect.any(String),
            remedy: expect.stringContaining('machines.reachability.inspect') } } } });
        const review = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
          change: { kind: 'posture', posture: { revision: 0,
            management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' } } } });
        expect(review).toMatchObject({ ok: false, errorCode: 'native_check_unavailable', details: {
          failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', phase: 'check', requiredFact: expect.any(String) },
          remedy: expect.stringContaining('machines.reachability.inspect'),
        } });
        const operation = (await api.listOperations()).items.find(candidate => candidate.actionId === 'machines.reachability.inspect'
          && candidate.state === 'failed');
        expect(operation).toMatchObject({ state: 'failed', error: { errorCode: 'native_check_unavailable', details: {
          failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact: expect.any(String) },
          remedy: expect.stringContaining('machines.reachability.inspect'),
        } } });
      } else {
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_cli_unavailable',
          details: { recovery: { kind: 'install_managed_cli', executablePath } } });
      }
      expect(await api.inspectOriginalCli({ serverId: 'srv_other-home', machineId }))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
      expect(f.home.approvalRequests()).toEqual([]);
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).map(request => request.mode)).toEqual(installed ? ['check', 'check'] : []);
      expect(api.client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadataVersion: snapshot.metadataVersion + 1, metadata });
    } finally { await api.dispose(); }
  });

  it.each([false, true])('reviews and configures the first posture against native SSH facts, refusing changed facts (socket activation: %s)', async socketActivated => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const { reachabilityPosture: _posture, ...metadata } = snapshot.metadata;
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion, metadata }))
        .toMatchObject({ status: 'applied' });
      await f.hostNative.setNativeSshPort(22, socketActivated);
      const posture = MachineReachabilityPostureV1Schema.parse({ revision: 0,
        management: { providers: [], publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0', '::/0'] },
          independentRecovery: { kind: 'providerConsole', evidence: 'userAttested', confirmedAtMs: 1_793_610_000_000 } },
        defaultServiceIngress: { kind: 'none' } });
      const reviewFirst = async () => {
        const raw = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
          change: { kind: 'posture', posture } });
        expect(raw.ok, JSON.stringify(raw)).toBe(true);
        if (!raw.ok) throw new Error(raw.errorCode);
        return parseReachabilityInspectResult(raw.result);
      };
      const review = await reviewFirst();
      expect(review).toMatchObject({ posture: null, plan: { basis: { currentPostureRevision: null } },
        observation: { management: { publicSsh: 'open' }, nativeFirewall: { status: 'available',
          retainedSshEndpoints: expect.arrayContaining([expect.objectContaining({ port: 22, sourceCidrs: ['0.0.0.0/0'] })]) } } });
      expect(review.plan?.basis).toMatchObject({ nativeFirewall: review.observation.nativeFirewall });
      const before = api.client.getMachineMetadataSnapshot();
      const stale = await executeReviewedReachabilityConfigure(f, api, review, {
        async beforeDecision() { await f.hostNative.setNativeSshPort(2205, socketActivated); },
      });
      expect(stale.result).toMatchObject({ ok: false, errorCode: 'plan_changed', effectAttempted: false });
      expect(api.client.getMachineMetadataSnapshot()).toEqual(before);
      await f.hostNative.setNativeSshPort(22, socketActivated);
      const fresh = await reviewFirst();
      const saved = await executeReviewedReachabilityConfigure(f, api, fresh);
      expect(parseCompletedReachabilityConfigure(saved.result)).toMatchObject({ status: 'applied', posture });
      const existing = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'posture', posture: { ...posture, revision: 1 } },
      }));
      expect(existing.plan?.basis.currentPostureRevision).toBe(0);
      expect(existing.plan?.basis).not.toHaveProperty('nativeFirewall');
      expect(parseCompletedReachabilityConfigure((await executeReviewedReachabilityConfigure(f, api, existing)).result))
        .toMatchObject({ status: 'applied', posture: { ...posture, revision: 1 } });
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).every(request => request.mode === 'check')).toBe(true);
      expect(f.hostNative.calls.filter(call => call.executable === '/usr/sbin/nft').every(call =>
        call.args.join(' ') === '--version' || call.args.join(' ') === '-j list tables')).toBe(true);
    } finally { await api.dispose(); }
  });

  // MACH-COMPOSE-1107 T2-INGRESS: a default is a Domain-route selection,
  // independent of management membership and the retained-SSH transaction.
  it.each([
    { kind: 'none' as const },
    { kind: 'provider' as const, selection: { provider: { kind: 'builtin' as const, id: 'cloudflareNamed' },
      config: { hostname: 'app.example.test' }, credentialRefs: [] } },
    { kind: 'provider' as const, selection: { provider: { kind: 'builtin' as const, id: 'tailscaleServe' },
      config: {}, credentialRefs: [] } },
  ])('applies an approved public SSH closure with default ingress %j before saving the posture', async defaultServiceIngress => {
    const { f, api } = prepared;
    await api.connectMachineControl();
    try {
      await f.hostNative.setNativeSshPort(2205);
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const current = MachineReachabilityPostureV1Schema.parse(snapshot.metadata.reachabilityPosture);
      const posture = { ...current, revision: current.revision + 1, defaultServiceIngress,
        management: { ...current.management, publicSsh: { kind: 'closed' as const },
          independentRecovery: { kind: 'providerConsole' as const, evidence: 'userAttested' as const, confirmedAtMs: 1_793_610_000_000 } } };
      f.hostNative.setOnFirewallMutation(() => {
        expect(api.client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready',
          metadata: { reachabilityPosture: current } });
      });
      const raw = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
        change: { kind: 'posture', posture } });
      expect(raw.ok, JSON.stringify(raw)).toBe(true);
      if (!raw.ok) throw new Error(raw.errorCode);
      const review = parseReachabilityInspectResult(raw.result);
      expect(review.plan?.basis).toMatchObject({ firewallTransition: {
        intent: { kind: 'retainSsh', publicSsh: { kind: 'closed' } },
      } });
      const configured = await executeReviewedReachabilityConfigure(f, api, review);
      expect(parseCompletedReachabilityConfigure(configured.result)).toMatchObject({ status: 'applied', posture,
        observation: { management: { publicSsh: 'closed' } } });
      const rules = await import('node:fs/promises').then(fs => fs.readFile('/etc/happier/firewall/rules.nft', 'utf8'));
      expect(rules).toContain('ct state new drop');
      expect(rules).not.toContain('tcp dport 2205 accept');
      expect(f.hostNative.firewallStages[0]).toContain('tcp dport 2205 accept');
      expect(f.hostNative.firewallStages.at(-1)).toBe(rules);
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests)).toEqual(expect.arrayContaining([
        expect.objectContaining({ mode: 'apply' }),
      ]));
      const saved = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId,
      }));
      expect(saved.posture).toEqual(posture);
      expect(saved.observation.ingress).toEqual(defaultServiceIngress.kind === 'none' ? [] : [expect.objectContaining({
        provider: defaultServiceIngress.selection.provider,
      })]);
    } finally { await api.dispose(); }
  });

  it('refuses unavailable, malformed and management-only defaults without native or metadata effects', async () => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const current = MachineReachabilityPostureV1Schema.parse(snapshot.metadata.reachabilityPosture);
      const callsBefore = f.hostNative.calls.length;
      for (const [selection, errorCode] of [
        [{ provider: { kind: 'builtin', id: 'missing-ingress' }, config: {}, credentialRefs: [] }, 'access_provider_unavailable'],
        [{ provider: { kind: 'builtin', id: 'cloudflareNamed' }, config: {}, credentialRefs: [] }, 'invalid_access_provider_selection'],
        [builtin(false), 'access_provider_target_unsupported'],
      ] satisfies [AccessProviderSelectionV1, string][]) {
        expect(await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
          change: { kind: 'posture', posture: { ...current, revision: current.revision + 1,
            defaultServiceIngress: { kind: 'provider', selection } } },
        })).toMatchObject({ ok: false, errorCode });
      }
      expect(f.hostNative.calls).toHaveLength(callsBefore);
      expect(api.client.getMachineMetadataSnapshot()).toEqual(snapshot);
      expect(f.home.approvalRequests()).toEqual([]);
    } finally { await api.dispose(); }
  });

  it('saves default ingress while keeping SSH open and reports missing native setup without a mutation', async () => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const current = MachineReachabilityPostureV1Schema.parse(snapshot.metadata.reachabilityPosture);
      const posture = { ...current, revision: current.revision + 1,
        defaultServiceIngress: { kind: 'provider' as const, selection: {
          provider: { kind: 'builtin' as const, id: 'caddy' }, config: {}, credentialRefs: [],
        } } };
      const raw = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
        change: { kind: 'posture', posture } });
      expect(raw.ok, JSON.stringify(raw)).toBe(true);
      if (!raw.ok) throw new Error(raw.errorCode);
      const review = parseReachabilityInspectResult(raw.result);
      expect(review.plan?.basis.firewallTransition).toBeUndefined();
      const configured = parseCompletedReachabilityConfigure((await executeReviewedReachabilityConfigure(f, api, review)).result);
      expect(configured).toMatchObject({ status: 'applied', posture, observation: { ingress: [{
        provider: posture.defaultServiceIngress.selection.provider,
        state: 'needsSetup', code: 'needs_setup', remedies: ['configure'],
      }] } });
      expect(f.hostNative.firewallStages).toEqual([]);
      expect(f.hostNative.tailscaleMutations).toEqual([]);
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).every(request => request.mode === 'check')).toBe(true);
      expect(f.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
    } finally { await api.dispose(); }
  });

  it('reviews and saves a first posture with no native SSH listener or owned firewall without inventing an SSH rule', async () => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const { reachabilityPosture: _posture, ...metadata } = snapshot.metadata;
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion, metadata }))
        .toMatchObject({ status: 'applied' });
      await f.hostNative.setNativeSshPort(null);
      const posture = MachineReachabilityPostureV1Schema.parse({ revision: 0,
        management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'none' } });
      const raw = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId,
        change: { kind: 'posture', posture } });
      expect(raw.ok, JSON.stringify(raw)).toBe(true);
      if (!raw.ok) throw new Error(raw.errorCode);
      const review = parseReachabilityInspectResult(raw.result);
      expect(review).toMatchObject({ posture: null,
        observation: { management: { publicSsh: 'closed' }, nativeFirewall: {
          status: 'available', ownedTable: 'absent', retainedSshEndpoints: [],
        } }, plan: { basis: { nativeFirewall: { status: 'available', ownedTable: 'absent', retainedSshEndpoints: [] } } } });
      const saved = await executeReviewedReachabilityConfigure(f, api, review);
      expect(parseCompletedReachabilityConfigure(saved.result)).toMatchObject({ status: 'applied', posture });
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).every(request => request.mode === 'check')).toBe(true);
      expect(f.hostNative.calls.filter(call => call.executable === '/usr/sbin/nft').every(call =>
        call.args.join(' ') === '--version' || call.args.join(' ') === '-j list tables')).toBe(true);
    } finally { await api.dispose(); }
  });

  it('lists real native descriptors without a plugin identity and inspects only demanded Caddy through the host Action', async () => {
    const { f, api } = prepared;
    try {
      const beforeDocker = f.hostNative.calls.filter(call => call.executable === 'docker').length;
      const catalog = relayAccessProviderDescriptors;
      expect(catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: { kind: 'builtin', id: 'tailscale' }, definition: expect.objectContaining({
          actions: { inspect: 'machines.reachability.inspect', join: 'machines.reachability.configure', leave: 'machines.reachability.configure' },
        }) }),
        expect.objectContaining({ provider: { kind: 'builtin', id: 'caddy' }, definition: expect.objectContaining({
          actions: { inspect: 'machines.reachability.inspect', configure: 'machines.reachability.configure', disable: 'machines.reachability.configure' },
        }) }),
      ]));
      expect(f.hostNative.calls.filter(call => call.executable === 'docker')).toHaveLength(beforeDocker);
      const empty = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', { serverId: 'generic-home', machineId }));
      expect(empty.observation.ingress).toEqual([]);
      expect(f.hostNative.calls.filter(call => call.executable === 'docker')).toHaveLength(beforeDocker);
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const selection: AccessProviderSelectionV1 = { provider: { kind: 'builtin', id: 'caddy' }, config: {}, credentialRefs: [] };
      const posture = MachineReachabilityPostureV1Schema.parse({ revision: 0,
        management: { providers: [], publicSsh: { kind: 'closed' } }, defaultServiceIngress: { kind: 'provider', selection },
      });
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion,
        metadata: { ...snapshot.metadata, reachabilityPosture: posture },
      })).toMatchObject({ status: 'applied' });
      const observed = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', { serverId: 'generic-home', machineId }));
      expect(observed.observation.ingress).toEqual([expect.objectContaining({
        provider: selection.provider, state: 'needsSetup', code: 'needs_setup', remedies: ['configure'],
      })]);
      expect(f.hostNative.calls.filter(call => call.executable === 'docker').slice(beforeDocker).map(call => call.args)).toEqual([
        ['container', 'ls', '--all', '--no-trunc', '--filter', 'label=dev.happier.machine-setup.recipe=caddy@1', '--format', '{{json .ID}}'],
      ]);
      expect(f.elevation.launches).toHaveLength(2);
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).map(request => request.mode)).toEqual(['check', 'check']);
      expect(f.hostNative.tailscaleMutations).toEqual([]);
    } finally { await api.dispose(); }
  });

  it('adopts the observed Running profile without a new key, grant or native mutation', async () => {
    const { f, api, selected } = prepared;
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      expect(review.plan?.basis.change).toEqual({ kind: 'privateNetwork', intent: 'join', selection: selected });
      expect(review.plan?.basis.occurrences).toEqual([]);
      expect(review.plan?.basis.credentialFileReview).toBeUndefined();
      expect(f.hostNative.tailscaleMutations).toEqual([]);
      const configured = await executeReviewedReachabilityConfigure(f, api, review);
      expect(parseCompletedReachabilityConfigure(configured.result)).toMatchObject({ status: 'applied', selections: [selected],
        observation: { privateNetworks: [expect.objectContaining({ provider: selected.provider, state: 'ready' })] } });
      expect(f.hostNative.tailscaleMutations).toEqual([]);
      expect(await f.home.readConnectorGrantCount()).toBe(0);
      expect(f.elevation.launches).toHaveLength(0);
      expect(f.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
    } finally { await api.dispose(); }
  });
  });

  describe('with a selected key', () => {
    let prepared: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => { prepared = await fixture(true); }, 120_000);

  it('reviews a Switch then reauthenticates a new key once even when the native profile id stays the same', async () => {
    const { f, api, selected } = prepared;
    try {
      const retained: AccessProviderSelectionV1 = { ...selected, credentialRefs: [{ purpose: 'network.join', credentialRef: {
        kind: 'savedSecret', ref: 'happier:shared-secret:v1:previous-join-resource', resourceRevision: 1,
      } }] };
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion,
        metadata: { ...snapshot.metadata, displayName: 'Retained builtin metadata', accessProviderSelections: [retained] },
      })).toMatchObject({ status: 'applied' });
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      expect(review.plan?.basis.currentSelections).toEqual([retained]);
      expect(review.plan?.basis.change).toEqual({ kind: 'privateNetwork', intent: 'join', selection: selected });
      expect(review.observation.privateNetworks).toHaveLength(1);
      expect(review.observation.privateNetworks[0]?.provider).toEqual(selected.provider);
      expect(f.hostNative.calls.filter(call => call.args[0] === 'switch')).toHaveLength(1);
      expect(review.plan?.basis.occurrences).toEqual([]);
      const steps = review.plan?.basis.recipePlans.flatMap(entry => entry.plan.steps) ?? [];
      expect(steps).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'tailscale-switch', kind: 'command', args: ['down'] })]));
      expect(f.hostNative.tailscaleMutations).toEqual([]);
      expect(f.elevation.launches).toHaveLength(0);
      expect(await f.home.readConnectorGrantCount()).toBe(0);
      const writesBeforeConfigure = api.metadataPublications.length;
      const configured = await executeReviewedReachabilityConfigure(f, api, review);
      expect(parseCompletedReachabilityConfigure(configured.result)).toMatchObject({ status: 'applied', selections: [selected] });
      expect(api.metadataPublications.length - writesBeforeConfigure).toBe(1);
      expect(api.client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: {
        displayName: 'Retained builtin metadata', accessProviderSelections: [selected],
      } });
      expect(f.hostNative.tailscaleMutations.filter(args => args[0] === 'down')).toEqual([['down']]);
      expect(f.hostNative.tailscaleMutations.filter(args => args[0] === 'up')).toEqual([
        ['up', '--force-reauth', `--auth-key=file:${review.plan?.basis.credentialFileReview?.path}`],
      ]);
      expect(f.hostNative.tailscaleMutations.filter(args => args[0] === 'set')).toEqual([
        ['set', `--operator=${userInfo().username}`],
      ]);
      expect(f.hostNative.tailscaleState()).toBe('Running');
      expect(f.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
      expect(JSON.stringify([review, configured.result, f.hostNative.calls, f.home.approvalRequests()])).not.toContain(f.privateSetupKey);
    } finally { await api.dispose(); }
  });

  it('refuses a changed observed native profile before acquiring a grant or applying a root effect', async () => {
    const { f, api, selected } = prepared;
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      const configured = await executeReviewedReachabilityConfigure(f, api, review, {
        beforeDecision() { f.hostNative.setTailscaleProfileId('another-native-profile'); },
      });
      expect(configured.result).toMatchObject({ ok: false, errorCode: 'plan_changed', effectAttempted: false });
      expect(f.hostNative.tailscaleMutations).toEqual([]);
      expect(f.elevation.launches).toHaveLength(0);
      expect(await f.home.readConnectorGrantCount()).toBe(0);
      expect(f.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
    } finally { await api.dispose(); }
  });
  });
});
