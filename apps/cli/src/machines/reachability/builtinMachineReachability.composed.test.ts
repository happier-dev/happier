// Install the genuine OS boundary before importing production native owners.
import { createDockerNetworkAuthoredProvider, createGenericDefaultFactoryJourney, executeReviewedReachabilityConfigure,
  journey, machineId, parseCompletedReachabilityConfigure, parseReachabilityInspectResult, selection,
} from './genericMachineReachability.testkit';
import { userInfo } from 'node:os';
import { unlink } from 'node:fs/promises';
import { resolveInstalledMachineEffectCli } from '../adminAccess/runElevatedEffect';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessProviderSelectionV1 } from '@happier-dev/plugin-sdk/access-providers';
import { relayAccessProviderDescriptors } from '@happier-dev/cli-common/relayAccess/catalog';
import { MachineReachabilityPostureV1Schema } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';

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

  it.each([false, true])('inspects a Machine without a saved posture through its canonical Home identity (managed CLI installed: %s)', async installed => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const { reachabilityPosture: _posture, ...metadata } = snapshot.metadata;
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion, metadata }))
        .toMatchObject({ status: 'applied' });
      const executablePath = resolveInstalledMachineEffectCli();
      if (!installed) await unlink(executablePath);
      const result = await api.inspectOriginalCli({ serverId: f.home.serverIdentityId, machineId });
      if (installed) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result).toMatchObject({ ok: true, result: { posture: null,
          observation: { nativeFirewall: { status: 'unavailable', requiredFact: expect.any(String) } } } });
      } else {
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_cli_unavailable',
          details: { recovery: { kind: 'install_managed_cli', executablePath } } });
      }
      expect(await api.inspectOriginalCli({ serverId: 'srv_other-home', machineId }))
        .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
      expect(f.home.approvalRequests()).toEqual([]);
      expect(f.elevation.diagnostics.flatMap(diagnostic => diagnostic.requests).map(request => request.mode)).toEqual(installed ? ['check'] : []);
      expect(api.client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadataVersion: snapshot.metadataVersion + 1, metadata });
    } finally { await api.dispose(); }
  });

  it('reviews and configures the first posture against native SSH facts, refusing changed facts', async () => {
    const { f, api } = prepared;
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      const { reachabilityPosture: _posture, ...metadata } = snapshot.metadata;
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion, metadata }))
        .toMatchObject({ status: 'applied' });
      await f.hostNative.setNativeSshPort(22);
      const posture = MachineReachabilityPostureV1Schema.parse({ revision: 0,
        management: { providers: [], publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0', '::/0'] } },
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
        async beforeDecision() { await f.hostNative.setNativeSshPort(2205); },
      });
      expect(stale.result).toMatchObject({ ok: false, errorCode: 'plan_changed', effectAttempted: false });
      expect(api.client.getMachineMetadataSnapshot()).toEqual(before);
      await f.hostNative.setNativeSshPort(22);
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
