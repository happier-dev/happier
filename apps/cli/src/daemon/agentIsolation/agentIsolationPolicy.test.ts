import { describe, expect, it } from 'vitest';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol';
import { StoredMachinePublishedDaemonStateV1Schema, StoredMachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readAgentIsolationSnapshot } from './agentIsolationPolicy';

describe('held Agent isolation launch policy', () => {
  it('carries explicit reviewed member provisioning to Session preparation without inferring it from legacy enablement', () => {
    const status = { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
    const read = (policy: unknown) => readAgentIsolationSnapshot({
      metadata: { status: 'ready', metadata: { agentIsolation: policy }, metadataVersion: 1 },
      daemonState: { runtimeId: 'current', agentIsolation: status }, runtimeId: 'current', platform: 'linux' });
    expect(read({ enabled: true, memberProvisioning: 'linuxUsersV1' }))
      .toEqual({ enabled: true, memberProvisioning: 'linuxUsersV1', status });
    expect(read({ enabled: true })).toEqual({ enabled: true, status });
    expect(read({ enabled: false })).toEqual({ enabled: false, status });
  });
  it('fails closed for locked/malformed metadata and defaults opened predecessor metadata off', () => {
    const read = (metadata: Parameters<typeof readAgentIsolationSnapshot>[0]['metadata']) => readAgentIsolationSnapshot({ metadata, daemonState: null, runtimeId: 'current', platform: 'linux' });
    expect(read({ status: 'locked' })).toEqual({ enabled: true, status: { kind: 'unavailable', code: 'metadata_unavailable' } });
    expect(read({ status: 'ready', metadata: { agentIsolation: { enabled: 'yes' } }, metadataVersion: 1 })).toMatchObject({ enabled: true, status: { kind: 'unavailable' } });
    // Constructed from the clean ../0.2 API producer shapes at
    // 5bd2927b35a67cef06ea857d45715c5929e99740, apps/cli/src/api/types.ts:327,363.
    // That producer has neither agentIsolation nor a daemon runtimeId.
    const predecessorMetadata = StoredMachinePublishedMetadataV1Schema.parse({
      host: 'predecessor-fixture', platform: 'linux', happyCliVersion: '0.2-fixture',
      homeDir: '/home/person', happyHomeDir: '/home/person/.happier', happyLibDir: '/opt/happier',
    });
    const predecessorState = StoredMachinePublishedDaemonStateV1Schema.parse({
      status: 'running', pid: 100, startedAt: 1, startedWithCliVersion: '0.2-fixture',
    });
    const predecessorIsolation = readAgentIsolationSnapshot({
      metadata: { status: 'ready', metadata: predecessorMetadata, metadataVersion: 1 },
      daemonState: predecessorState, runtimeId: 'current', platform: 'linux',
    });
    expect(predecessorIsolation).toEqual({ enabled: false, status: { kind: 'unavailable', code: 'provisioning_unavailable' } });
    // Missing predecessor observations stay unknown through P10's actual sole
    // presenter; isolation unavailability must not hide the shared-UID disclosure.
    expect(presentMachineAuthorityV1({
      observation: predecessorState.adminAccess,
      desiredAdminAccess: predecessorMetadata.adminAccess,
      isolation: predecessorIsolation.status,
      sharedMachine: true,
      freshness: 'current',
    })).toMatchObject({
      hostAuthority: 'unknown', agentHostAuthority: 'unknown', freshness: 'stale',
      isolation: predecessorIsolation.status, sharedAgentUid: true,
    });
  });

  it('never uses a retained previous daemon effective fact as fresh admission proof', () => {
    const metadata = { status: 'ready' as const, metadata: { agentIsolation: { enabled: true } }, metadataVersion: 1 };
    const effective = { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' };
    expect(readAgentIsolationSnapshot({ metadata, daemonState: { runtimeId: 'old', agentIsolation: effective }, runtimeId: 'current', platform: 'linux' }))
      .toEqual({ enabled: true, status: { kind: 'unavailable', code: 'provisioning_unavailable' } });
    expect(readAgentIsolationSnapshot({ metadata, daemonState: { runtimeId: 'current', agentIsolation: effective }, runtimeId: 'current', platform: 'linux' }))
      .toEqual({ enabled: true, status: effective });
  });

  it('keeps unsupported platforms unavailable even with a retained effective projection', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(readAgentIsolationSnapshot({ metadata: { status: 'ready', metadata: { agentIsolation: { enabled: true } }, metadataVersion: 1 },
        daemonState: { runtimeId: 'current', agentIsolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } },
        runtimeId: 'current', platform })).toEqual({ enabled: true, status: { kind: 'unavailable',
          code: platform === 'win32' ? 'unsupported_platform' : 'provisioning_unavailable' } });
    }
  });
});
