import { describe, expect, it } from 'vitest';

import {
  isMachinePublishedContentSafeV1,
  parseMachinePublishedDaemonStateV1,
  parseMachinePublishedMetadataV1,
  StoredMachinePublishedDaemonStateV1Schema,
  StoredMachinePublishedMetadataV1Schema,
} from './machinePublishedContentV1.js';

const metadata = {
  host: 'workstation', platform: 'linux', happyCliVersion: '0.3',
  homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier',
};
const readiness = { engine: { state: 'ready' }, carrier: { state: 'ready' } };

describe('whole Machine publication', () => {
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
    const step = setup.recipes[0]!.steps[1]!;
    for (const packages of [[{ ...step.packages[0], scope: 'all' }],
      [{ ...step.packages[0], stdout: 'private native output' }], [{ ...step.packages[0], present: false, version: 'not-installed' }]]) {
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', setup: {
        ...setup, recipes: [{ ...setup.recipes[0], steps: [{ ...step, packages }] }],
      } })).toThrow();
    }
  });

  it('publishes compact setup observations and rejects native bags, scripts and secret material', () => {
    const setup = { version: 1, desiredRevision: 2, status: 'drifted', recipes: [{
      ref: { pluginId: 'example.machine', recipeId: 'ssh-hardening', revision: '1' }, status: 'drifted',
      steps: [{ stepId: 'sshd-policy', status: 'drifted', backend: 'openssh', reason: 'required_fact_unavailable' }],
    }], updates: { status: 'satisfied', pendingSecurity: 2, pendingAll: 4, rebootNeeded: true } };
    expect(parseMachinePublishedDaemonStateV1({ status: 'running', setup })).toMatchObject({ setup });
    expect(StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', setup })).toMatchObject({ setup });
    for (const unsafe of [{ ...setup, script: 'echo private' }, { ...setup, secretRefs: {} },
      { ...setup, recipes: [{ ...setup.recipes[0], steps: [{ ...setup.recipes[0]!.steps[0], facts: { stdout: 'private' } }] }] }]) {
      expect(() => parseMachinePublishedDaemonStateV1({ status: 'running', setup: unsafe })).toThrow();
    }
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
  it('publishes only the strict content-free managed activity decision', () => {
    const safe = { status: 'running', managedActivity: { kind: 'idle', since: 10 } };
    expect(isMachinePublishedContentSafeV1({ metadata, daemonState: safe })).toBe(true);
    expect(parseMachinePublishedDaemonStateV1(safe)).toEqual(safe);
    for (const privateDecision of [{ kind: 'busy', reasons: ['session'], sessionId: 'private' },
      { kind: 'idle', since: 10, items: [] }]) {
      expect(isMachinePublishedContentSafeV1({ metadata,
        daemonState: { status: 'running', managedActivity: privateDecision } })).toBe(false);
    }
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
