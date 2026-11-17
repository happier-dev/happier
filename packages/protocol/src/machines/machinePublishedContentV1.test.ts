import { describe, expect, it } from 'vitest';
import { mutateMachineServiceWatchesV1 } from './machineServiceWatchesV1.js';
import type { MachineMetadataFieldPortV1 } from './machineMetadataFieldV1.js';
import { MACHINE_DAEMON_PUBLIC_RELEASE_CHANNEL_LABELS, MACHINE_DAEMON_STARTUP_SOURCE_VALUES } from './ownership/daemonOwnership.js';

import {
  isMachinePublishedContentSafeV1,
  parseMachinePublishedDaemonStateV1,
  parseMachinePublishedMetadataV1,
  StoredMachinePublishedDaemonStateV1Schema,
  StoredMachinePublishedMetadataV1Schema,
  MachinePublishedTransferListenerV1Schema,
} from './machinePublishedContentV1.js';

const metadata = {
  host: 'workstation', platform: 'linux', happyCliVersion: '0.3',
  homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier',
};
const readiness = { engine: { state: 'ready' }, carrier: { state: 'ready' } };

describe('whole Machine publication', () => {
  it('retains a closed private App service binding in Machine content', () => {
    const deploymentApp = { serviceName: 'private-collector-service', port: 4318 };
    expect(parseMachinePublishedMetadataV1({ ...metadata, deploymentApp })).toEqual({ ...metadata, deploymentApp });
    expect(StoredMachinePublishedMetadataV1Schema.parse({ ...metadata, deploymentApp })).toEqual({ ...metadata, deploymentApp });
    for (const invalid of [{ ...deploymentApp, privateOutput: 'native output' }, { ...deploymentApp, port: 0 },
      { ...deploymentApp, port: 65536 }, { ...deploymentApp, serviceName: '' }]) {
      expect(() => parseMachinePublishedMetadataV1({ ...metadata, deploymentApp: invalid })).toThrow();
    }
  });

  it('preserves additive provider settings reports and their existing runtime source identity', () => {
    const state = {
      status: 'running', pid: 19,
      providerSettingsV1: { 'example.agent/local': { policy: null, targets: [{ id: 'native', status: 'unmanaged', currentDays: 7 }] } },
      providerSettingsSourceV1: { pid: 19, cliVersion: '0.3', startedAt: 101 },
    };
    expect(parseMachinePublishedDaemonStateV1(state)).toEqual(state);
    expect(StoredMachinePublishedDaemonStateV1Schema.parse(state)).toEqual(state);
    expect(() => parseMachinePublishedDaemonStateV1({ ...state, providerSettingsSourceV1: { pid: 0, cliVersion: '0.3', startedAt: 101 } })).toThrow();
    expect(() => parseMachinePublishedDaemonStateV1({ ...state, providerSettingsV1: { agent: { invalid: undefined } } })).toThrow();
  });

  it('admits only closed operator-refusal facts in the optional transfer diagnostic', () => {
    const listener = { enabled: true, configured: false, active: false, available: false };
    const diagnostic = { code: 'tailscale_operator_authorization_refused', retryable: false };
    expect(MachinePublishedTransferListenerV1Schema.parse(listener)).toEqual(listener);
    expect(MachinePublishedTransferListenerV1Schema.parse({ ...listener, diagnostic }))
      .toEqual({ ...listener, diagnostic });
    for (const invalid of [{ ...diagnostic, remediation: 'private native output' },
      { ...diagnostic, stderr: '/private/operator' }, { ...diagnostic, retryable: true }, { ...diagnostic, code: 'unknown' }]) {
      expect(MachinePublishedTransferListenerV1Schema.safeParse({ ...listener, diagnostic: invalid }).success).toBe(false);
    }
  });

  it('preserves the optional strict daemon ownership scalar wire fields', () => {
    expect(parseMachinePublishedDaemonStateV1({ status: 'running' })).toEqual({ status: 'running' });
    for (const publicReleaseChannel of MACHINE_DAEMON_PUBLIC_RELEASE_CHANNEL_LABELS) {
      expect(parseMachinePublishedDaemonStateV1({ status: 'running', publicReleaseChannel })).toEqual({ status: 'running', publicReleaseChannel });
    }
    for (const startupSource of MACHINE_DAEMON_STARTUP_SOURCE_VALUES) {
      expect(parseMachinePublishedDaemonStateV1({ status: 'running', startupSource })).toEqual({ status: 'running', startupSource });
    }
    for (const invalid of [null, '', 'unsupported']) {
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', publicReleaseChannel: invalid })).toThrow();
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', startupSource: invalid })).toThrow();
    }
  });

  it('publishes compact exact software package observations without private manager output', () => {
    const setup = { version: 1, desiredRevision: 1, status: 'drifted', recipes: [{
      ref: { pluginId: 'example.machine', recipeId: 'software', revision: '1' }, status: 'drifted', steps: [
        { stepId: 'brew', status: 'satisfied', packages: [{ manager: 'brew', name: 'example-app', kind: 'cask',
          present: true, version: '1.2.3-a45,ccdd88' }] },
        { stepId: 'winget', status: 'drifted', packages: [{ manager: 'winget', name: 'Google.Chrome',
          source: 'winget', scope: 'user', present: false }] },
      ],
    }] };
    expect(parseMachinePublishedDaemonStateV1({ status: 'running', setup })).toMatchObject({ setup });
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', setup })).toMatchObject({ setup });
    const { attachedPresets: _attachments, ...unpublished } = setup;
    expect(parseMachinePublishedDaemonStateV1({ status: 'running', setup: unpublished })).toMatchObject({ setup: unpublished });
    const step = setup.recipes[0]!.steps[1]!;
    for (const packages of [[{ ...step.packages[0], scope: 'all' }],
      [{ ...step.packages[0], stdout: 'private native output' }], [{ ...step.packages[0], present: false, version: 'not-installed' }]]) {
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', setup: {
        ...setup, recipes: [{ ...setup.recipes[0], steps: [{ ...step, packages }] }],
      } })).toThrow();
    }
  });

  it.each(['applied', 'lost-ack'] as const)('rebases a watch CAS across unrelated metadata and observes %s without replay', async outcome => {
    const before = { v: 1 as const, watches: [] };
    const after = { v: 1 as const, watches: [{ v: 1 as const, watchId: 'watch-one', name: 'Worker',
      adapter: { pluginId: 'example.native', localId: 'systemd' }, nativeResourceId: 'user/worker.service',
      lifecyclePurpose: 'development' as const }] };
    let stored: Record<string, unknown> = { ...metadata, serviceWatchesV1: before, displayName: 'before' };
    let version = 2;
    let attempts = 0;
    let publications = 0;
    const port: MachineMetadataFieldPortV1 = {
      read: async () => ({ status: 'ready', metadata: stored, metadataVersion: version }),
      compareAndSwap: async input => {
        attempts++;
        if (attempts === 1) {
          stored = { ...stored, displayName: 'concurrent Resources writer' }; version++;
          return { status: 'conflict', metadata: stored, metadataVersion: version };
        }
        expect(input.expectedMetadataVersion).toBe(version);
        stored = parseMachinePublishedMetadataV1(input.metadata); version++; publications++;
        return outcome === 'lost-ack' ? { status: 'outcomeUnknown' }
          : { status: 'applied', metadata: stored, metadataVersion: version };
      },
    };
    expect(await mutateMachineServiceWatchesV1({ expectedMetadataVersion: 2, expectedWatches: before, watches: after }, port))
      .toMatchObject({ status: outcome === 'lost-ack' ? 'satisfied' : 'applied', policy: after });
    expect(stored).toMatchObject({ displayName: 'concurrent Resources writer', serviceWatchesV1: after });
    expect(attempts).toBe(2);
    expect(publications).toBe(1);
    expect(await mutateMachineServiceWatchesV1({ expectedMetadataVersion: version, expectedWatches: after, watches: after }, port))
      .toMatchObject({ status: 'unchanged' });
    expect(publications).toBe(1);
    expect(attempts).toBe(2);
    const retired: MachineMetadataFieldPortV1 = { ...port, read: async () => ({ status: 'locked' }) };
    expect(await mutateMachineServiceWatchesV1({ expectedMetadataVersion: version, expectedWatches: after, watches: before }, retired))
      .toEqual({ status: 'locked' });
    expect(publications).toBe(1);
  });
  it('retains exact adopted-service watch intent and refuses duplicate or runtime-bearing declarations', () => {
    const watch = { v: 1, watchId: 'watch-one', name: 'Background worker',
      adapter: { pluginId: 'example.native', localId: 'systemd' }, nativeResourceId: 'user/worker.service',
      lifecyclePurpose: 'development' };
    const serviceWatchesV1 = { v: 1, watches: [watch] };
    expect(parseMachinePublishedMetadataV1({ ...metadata, serviceWatchesV1 })).toMatchObject({ serviceWatchesV1 });
    expect(StoredMachinePublishedMetadataV1Schema.parse({ ...metadata, serviceWatchesV1 })).toMatchObject({ serviceWatchesV1 });
    for (const watches of [[watch, { ...watch, watchId: 'duplicate-native' }],
      [watch, { ...watch, nativeResourceId: 'user/other.service' }],
      [{ ...watch, health: 'healthy' }], [{ ...watch, adapter: 'systemd' }],
      [{ ...watch, environmentId: 'not-a-watch-authority' }]]) {
      expect(() => parseMachinePublishedMetadataV1({ ...metadata, serviceWatchesV1: { v: 1, watches } })).toThrow();
    }
  });
  it('publishes compact setup observations and rejects native bags, scripts and secret material', () => {
    const setup = { version: 1, desiredRevision: 2, status: 'drifted', recipes: [{
      ref: { pluginId: 'example.machine', recipeId: 'ssh-hardening', revision: '1' }, status: 'drifted',
      steps: [{ stepId: 'sshd-policy', status: 'drifted', backend: 'openssh', reason: 'required_fact_unavailable' }],
    }], attachedPresets: [
      { kind: 'accountPreset', presetId: 'base', presetRevision: 3 },
      { kind: 'bundledPreset', ref: { pluginId: 'example.machine', localId: 'base', revision: 'v2' } },
    ], updates: { status: 'satisfied', pendingSecurity: 2, pendingAll: 4, rebootNeeded: true, checkedAt: 1_794_686_700_000 } };
    expect(parseMachinePublishedDaemonStateV1({ status: 'running', setup })).toMatchObject({ setup });
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', setup })).toMatchObject({ setup });
    for (const unsafe of [{ ...setup, script: 'echo private' }, { ...setup, secretRefs: {} },
      { ...setup, attachedPresets: [{ ...setup.attachedPresets[0], setup: {} }] },
      { ...setup, attachedPresets: [{ ...setup.attachedPresets[0], name: 'snapshot' }] },
      { ...setup, attachedPresets: [{ kind: 'direct' }] },
      { ...setup, recipes: [{ ...setup.recipes[0], steps: [{ ...setup.recipes[0]!.steps[0], facts: { stdout: 'private' } }] }] }]) {
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', setup: unsafe })).toThrow();
    }
  });
  it('publishes closed administrator intent and observed power without credentials or readiness claims', () => {
    const adminAccess = { version: 1, mode: 'ask', administratorUsername: 'alice' };
    const observation = { version: 1, observedAt: 20, daemonUid: 1001, daemonUsername: 'happier',
      daemonIdentity: 'nonRoot', rootEquivalentGroups: ['docker'], passwordlessSudoToRoot: 'denied',
      managedDropIn: 'valid', tailscaledOperator: { authorization: 'allowed' } };
    expect(isMachinePublishedContentSafeV1({ metadata: { ...metadata, adminAccess },
      daemonState: { status: 'running', adminAccess: observation } })).toBe(true);
    for (const unsafe of [{ ...adminAccess, password: 'never-retain' },
      { ...adminAccess, remoteHostId: 'ssh-route' }, { ...adminAccess, administratorUsername: 'root' }]) {
      expect(() => parseMachinePublishedMetadataV1({ ...metadata, adminAccess: unsafe })).toThrow();
    }
    for (const unsafe of [{ ...observation, askReady: true }, { ...observation, connectorId: 'device' },
      { ...observation, tailscaledOperator: { authorization: 'allowed', loggedIn: true } }]) {
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', adminAccess: unsafe })).toThrow();
    }
    const { tailscaledOperator: _operator, ...olderObservation } = observation;
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', adminAccess: olderObservation }))
      .toMatchObject({ adminAccess: { tailscaledOperator: { authorization: 'unknown' } } });
    expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', adminAccess: olderObservation })).toThrow();
    const unavailable = { ...observation, daemonUid: null, daemonUsername: null, daemonIdentity: 'unknown',
      rootEquivalentGroups: null, tailscaledOperator: { authorization: 'unknown' } };
    expect(parseMachinePublishedDaemonStateV1({ status: 'running', adminAccess: unavailable }))
      .toMatchObject({ adminAccess: unavailable });
  });
  it('publishes only installed Agent identities and their observation time', () => {
    const agentInventory = { checkedAt: 20, installedAgentIds: ['codex', 'claude'] };
    expect(isMachinePublishedContentSafeV1({ metadata: { ...metadata, agentInventory }, daemonState: null })).toBe(true);
    expect(parseMachinePublishedMetadataV1({ ...metadata, agentInventory })).toMatchObject({ agentInventory });
    expect(isMachinePublishedContentSafeV1({ metadata: { ...metadata,
      agentInventory: { ...agentInventory, resolvedPath: '/private/codex' } }, daemonState: null })).toBe(false);
    expect(StoredMachinePublishedMetadataV1Schema.parse({ ...metadata,
      agentInventory: { checkedAt: 'broken', installedAgentIds: ['codex'] } })).toEqual(metadata);
  });
  it('admits first-read unavailable resources without inventing host facts, but requires host facts while reporting', () => {
    const unavailable = { v: 1, vitals: { state: 'unavailable', since: 20, reason: 'helper_missing' },
      attention: { level: 'calm', reasons: [] } };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: { status: 'running', resources: unavailable } })).toBe(true);
    expect(parseMachinePublishedDaemonStateV1({ status: 'running', resources: unavailable }).resources).not.toHaveProperty('host');
    const host = { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: 10 };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: { status: 'running', resources: { ...unavailable, host } } })).toBe(true);
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: { status: 'running', resources: { ...unavailable, vitals: { state: 'reporting' } } } })).toBe(false);
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: { status: 'running', resources: { ...unavailable, vitals: { ...unavailable.vitals, reason: 'unknown' } } } })).toBe(false);
  });
  it('admits share-safe resource attention and guard way-back facts without admitting samples or private work', () => {
    const resources = {
      v: 1, vitals: { state: 'reporting' },
      host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: 10 },
      attention: { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: 20,
        metric: 'memory', kind: 'memory_pressure', pressure: 'critical', swapping: true }] },
      lastAutomaticAction: { at: 30, kind: 'stopped_session', entryId: 'entry-1', undoable: true,
        facts: { rule: 'memory_guard', freedBytes: 500, count: 1 } },
    };
    const daemonState = { status: 'running', resources };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState })).toBe(true);
    expect(parseMachinePublishedDaemonStateV1(daemonState)).toEqual(daemonState);
    for (const unsafe of [
      { ...resources, sample: { availableBytes: 200 } },
      { ...resources, lastAutomaticAction: { ...resources.lastAutomaticAction, sessionId: 'private' } },
      { ...resources, attention: { level: 'look', reasons: [{ kind: 'extension', data: 'private' }] } },
      { ...resources, lastAutomaticAction: { ...resources.lastAutomaticAction, kind: 'trash_moved' } },
    ]) {
      expect(isMachinePublishedContentSafeV1({ metadata, daemonState: { status: 'running', resources: unsafe } })).toBe(false);
    }
  });
  it('publishes the admitted child relation and observed native namespace as one closed projection', () => {
    const devcontainerChild = {
      relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer', parentMachineId: 'physical-controller' },
      observation: { nativeResourceId: 'native-child', user: 'custom-user', workspaceFolder: '/work/custom',
        storage: { kind: 'bind', hostPath: '/host/project', childPath: '/work/custom' } },
    };
    expect(() => parseMachinePublishedMetadataV1({ ...metadata, devcontainerChild })).not.toThrow();
    expect(StoredMachinePublishedMetadataV1Schema.parse({ ...metadata, devcontainerChild })).toEqual({ ...metadata, devcontainerChild });
    expect(() => parseMachinePublishedMetadataV1({ ...metadata, devcontainerChild: { ...devcontainerChild,
      relation: { ...devcontainerChild.relation, installationCredential: 'private' } } })).toThrow();
    expect(StoredMachinePublishedMetadataV1Schema.parse(metadata)).toEqual(metadata);
  });
  it('keeps busy/idle activity out of the Machine document while stored rows that carry it still read', () => {
    const retained = { status: 'running', managedActivity: { kind: 'idle', since: 10 } };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: retained })).toBe(false);
    expect(() => parseMachinePublishedDaemonStateV1(retained)).toThrow();
    expect(StoredMachinePublishedDaemonStateV1Schema.parse(retained)).toEqual({ status: 'running' });
  });
  it('admits declared host/readiness content and rejects entire private relation and peer bags', () => {
    const daemonState = {
      status: 'running', workspaceSync: { v: 1, readiness },
      peerMediation: { loopback: { flows: { machine_rpc: { active: true } } } },
    };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState })).toBe(true);
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: null })).toBe(true);
    for (const unsafe of [
      { ...daemonState, workspaceSync: { ...daemonState.workspaceSync, status: {
        relationshipId: 'private-relation', controllerMachineId: 'alice-machine', alphaPath: '/private/work',
      } } },
      { ...daemonState, peerMediation: { loopback: { flows: { machine_rpc: { active: true, token: 'secret' } } } } },
      { ...daemonState, foreignSession: { id: 'bob-work', command: 'private-command' } },
    ]) {
      expect(isMachinePublishedContentSafeV1({ metadata, daemonState: unsafe })).toBe(false);
      expect(() => parseMachinePublishedDaemonStateV1(unsafe)).toThrow();
    }
  });

  it('uses a tolerant retained reader without mistaking its projection for the raw disclosure proof', () => {
    const retained = { status: 'running', workspaceSync: { v: 1, readiness, status: {
      relationshipId: 'private', alphaPath: '/private',
    } }, peerMediation: { loopback: { flows: { machine_rpc: { active: true, token: 'secret' } } } } };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: retained })).toBe(false);
    const projection = StoredMachinePublishedDaemonStateV1Schema.parse(retained);
    expect(parseMachinePublishedDaemonStateV1(projection)).toEqual({
      status: 'running', workspaceSync: { v: 1, readiness },
      peerMediation: { loopback: { flows: { machine_rpc: { active: true } } } },
    });
    expect(StoredMachinePublishedMetadataV1Schema.parse({ ...metadata, privatePath: '/secret' })).toEqual(metadata);
    expect(() => parseMachinePublishedMetadataV1({ ...metadata, privatePath: '/secret' })).toThrow();
  });

  it('round-trips the managed-service summary while retaining old and malformed stored records', () => {
    const facts = { status: 'running', runtimeId: 'daemon-occurrence' };
    const current = { ...facts, managedServices: { running: 9, failing: 1 } };
    expect(StoredMachinePublishedDaemonStateV1Schema.parse(parseMachinePublishedDaemonStateV1(current))).toEqual(current);
    expect(StoredMachinePublishedDaemonStateV1Schema.parse(facts)).toEqual(facts);
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ ...facts, managedServices: { running: -1, failing: 0 } })).toEqual(facts);
    expect(() => parseMachinePublishedDaemonStateV1({ ...facts, managedServices: { running: -1, failing: 0 } })).toThrow();
  });

  it('keeps unrelated retained daemon facts when the optional service summary is unrecognized or malformed', () => {
    const facts = { status: 'running', runtimeId: 'daemon-occurrence', contributionRegistryProjectionRevision: 7,
      workspaceSync: { v: 1, readiness } };
    for (const localServices of [{ v: 1, state: 'future' }, { v: 1, state: 'ready', runningCount: -1 }]) {
      const retained = { ...facts, localServices };
      expect(StoredMachinePublishedDaemonStateV1Schema.parse(retained)).toEqual(facts);
      expect(isMachinePublishedContentSafeV1({ metadata, daemonState: retained })).toBe(false);
      expect(() => parseMachinePublishedDaemonStateV1(retained)).toThrow();
    }
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ ...facts,
      localServices: { v: 1, state: 'ready', runningCount: 2, futurePresentation: true } })).toEqual({ ...facts,
      localServices: { v: 1, state: 'ready', runningCount: 2 } });
  });

  it('rejects unknown fields inside the existing additive CLI update facts before disclosure or writes', () => {
    const cliUpdate = {
      currentVersion: '0.3', latestVersion: null, channel: 'dev', installSource: 'other',
      updateCommand: null, canUpdateRemotely: false, lastUpdate: null, token: 'secret',
    };
    expect(isMachinePublishedContentSafeV1({ metadata: { ...metadata, cliUpdate }, daemonState: null })).toBe(false);
    expect(() => parseMachinePublishedMetadataV1({ ...metadata, cliUpdate })).toThrow();
    const { token: _token, ...safeFacts } = cliUpdate;
    expect(isMachinePublishedContentSafeV1({ metadata: { cliUpdate: safeFacts, ...metadata }, daemonState: null })).toBe(true);
  });
});
