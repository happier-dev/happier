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
