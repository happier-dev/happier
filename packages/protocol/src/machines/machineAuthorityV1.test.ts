import { describe, expect, it } from 'vitest';
import { presentMachineAuthorityV1 } from './machineAuthorityV1.js';
import type { MachineAdminAccessObservationV1 } from './adminAccessV1.js';
import { MachineAdminAccessObservationV1Schema, StoredMachineAdminAccessObservationV1Schema } from './adminAccessV1.js';

const ordinary: MachineAdminAccessObservationV1 = {
  version: 1, observedAt: 1, daemonUid: 1000, daemonUsername: 'happier',
  daemonIdentity: 'nonRoot', rootEquivalentGroups: [], passwordlessSudoToRoot: 'denied',
  groupMembership: { state: 'current' },
  managedDropIn: 'absent', tailscaledOperator: { authorization: 'denied' },
};

describe('presentMachineAuthorityV1', () => {
  it('keeps separate-user setup availability consistent with the reported isolation status', () => {
    for (const isolation of [null, { kind: 'disabled' },
      { kind: 'unavailable', code: 'sudo_unavailable' }] as const) {
      const result = presentMachineAuthorityV1({ platform: 'linux', isolationPolicy: { enabled: false }, isolation });
      expect(result.isolation).toBe(isolation);
      expect(result.separateUsers).toEqual({ placement: 'daemon', canEnable: isolation?.kind !== 'unavailable' });
    }
    expect(presentMachineAuthorityV1({ platform: 'linux', isolationPolicy: { enabled: true, memberProvisioning: 'linuxUsersV1' } })
      .separateUsers).toEqual({ placement: 'member', canEnable: false });
    expect(presentMachineAuthorityV1({ platform: 'darwin', isolationPolicy: { enabled: false } })
      .separateUsers).toEqual({ placement: 'daemon', canEnable: false });
    expect(presentMachineAuthorityV1({}).separateUsers).toEqual({ placement: null, canEnable: false });
  });

  it('carries AM-8 pending restart facts through strict observation, retained reads and the shared power presenter', () => {
    const groupMembership = { state: 'pendingRestart', addedGroups: ['docker'], removedGroups: ['old-group'] } as const;
    const observation = MachineAdminAccessObservationV1Schema.parse({ ...ordinary, rootEquivalentGroups: ['docker'], groupMembership });
    expect(StoredMachineAdminAccessObservationV1Schema.parse(observation)).toMatchObject({ groupMembership });
    expect(presentMachineAuthorityV1({ observation, freshness: 'current' })).toMatchObject({
      hostAuthority: 'administrator', rootEquivalentGroups: ['docker'], groupMembership,
    });
    expect(presentMachineAuthorityV1({ observation, freshness: 'stale' })).toMatchObject({
      hostAuthority: 'unknown', lastKnownHostAuthority: 'administrator', groupMembership,
    });
    const { groupMembership: _membership, ...historical } = ordinary;
    expect(StoredMachineAdminAccessObservationV1Schema.parse(historical)).toMatchObject({ groupMembership: { state: 'unknown' } });
    expect(presentMachineAuthorityV1({ observation: historical, freshness: 'current' })).toMatchObject({
      hostAuthority: 'unknown', groupMembership: { state: 'unknown' },
    });
  });

  it.each([
    { name: 'ordinary', observation: ordinary, host: 'ordinary' },
    { name: 'missing', observation: null, host: 'unknown' },
    { name: 'unknown groups', observation: { ...ordinary, rootEquivalentGroups: null }, host: 'unknown' },
    { name: 'unknown UID', observation: { ...ordinary, daemonUid: null }, host: 'unknown' },
    { name: 'unavailable sudo', observation: { ...ordinary, passwordlessSudoToRoot: 'unavailable' as const }, host: 'unknown' },
    { name: 'root UID', observation: { ...ordinary, daemonUid: 0, daemonIdentity: 'root' as const }, host: 'administrator' },
    { name: 'root group', observation: { ...ordinary, rootEquivalentGroups: ['docker'] }, host: 'administrator' },
    { name: 'foreign sudo grant', observation: { ...ordinary, passwordlessSudoToRoot: 'allowed' as const }, host: 'administrator' },
  ])('$name remains fact-derived in every desired/isolation state', ({ observation, host }) => {
    for (const desiredAdminAccess of [null, { version: 1, mode: 'none' },
      { version: 1, mode: 'ask', administratorUsername: 'admin' },
      { version: 1, mode: 'preauthorized' }] as const) {
      for (const isolation of [null, { kind: 'disabled' }, { kind: 'enable_required', reason: 'existing_machine_workspace_migration' },
        { kind: 'unavailable', code: 'unsupported_platform' }] as const) {
        const result = presentMachineAuthorityV1({ observation, desiredAdminAccess, isolation, freshness: 'current' });
        expect(result.hostAuthority).toBe(host);
        expect(result.agentHostAuthority).toBe(isolation ? host : 'unknown');
        expect(result.isolation).toBe(isolation);
      }
    }
  });

  it('keeps effective isolation and shared-agent identity separate from daemon power', () => {
    const isolation = { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } as const;
    const result = presentMachineAuthorityV1({
      observation: { ...ordinary, rootEquivalentGroups: ['docker'] }, isolation, sharedMachine: true,
      desiredAdminAccess: { version: 1, mode: 'ask', administratorUsername: 'admin' }, freshness: 'current',
    });
    expect(result).toMatchObject({ hostAuthority: 'administrator', agentHostAuthority: 'ordinary',
      powerSources: ['rootEquivalentGroup'], rootEquivalentGroups: ['docker'], sharedAgentUid: true });
    expect(result.isolation).toBe(isolation);
  });

  it('retains owner and shared-user peer visibility for Direct material before member separation', () => {
    for (const isolation of [null, { kind: 'disabled' }, { kind: 'applying', phase: 'account' },
      { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }] as const) {
      for (const freshness of ['current', 'stale'] as const) {
        const result = presentMachineAuthorityV1({ observation: ordinary, freshness, isolation, sharedMachine: true });
        expect(result).toMatchObject({ deliveredMaterial: { ownerVisible: true, sharedUserPeerVisible: true } });
      }
    }
    expect(presentMachineAuthorityV1({})).toMatchObject({ deliveredMaterial: {
      ownerVisible: true, sharedUserPeerVisible: true,
    } });
    expect(presentMachineAuthorityV1({ sharedMachine: false })).toMatchObject({ deliveredMaterial: {
      ownerVisible: true, sharedUserPeerVisible: false,
    } });
  });

  it('discloses operator-only network power without changing ordinary host rights', () => {
    for (const authorization of ['allowed', 'denied', 'unknown', 'unavailable'] as const) {
      const result = presentMachineAuthorityV1({ observation: { ...ordinary, tailscaledOperator: { authorization } },
        isolation: { kind: 'disabled' }, freshness: 'current' });
      expect(result).toMatchObject({ hostAuthority: 'ordinary', agentHostAuthority: 'ordinary',
        tailscaledOperator: { authorization, freshness: 'current', currentAuthorization: authorization } });
    }
    expect(presentMachineAuthorityV1({ observation: { ...ordinary, daemonUid: 0, daemonIdentity: 'root',
      tailscaledOperator: { authorization: 'allowed' } }, freshness: 'current' }))
      .toMatchObject({ hostAuthority: 'administrator', powerSources: ['rootUid'],
        tailscaledOperator: { currentAuthorization: 'allowed' } });
  });

  it('retains last-known operator power as stale across disconnect and keeps missing evidence unknown', () => {
    const stale = presentMachineAuthorityV1({ observation: { ...ordinary,
      passwordlessSudoToRoot: 'allowed', tailscaledOperator: { authorization: 'allowed' } }, freshness: 'stale' });
    expect(stale).toMatchObject({ hostAuthority: 'unknown', lastKnownHostAuthority: 'administrator', tailscaledOperator: {
      authorization: 'allowed', freshness: 'stale', currentAuthorization: 'unknown' } });
    expect(presentMachineAuthorityV1({ observation: ordinary, freshness: 'stale' }))
      .toMatchObject({ hostAuthority: 'unknown', lastKnownHostAuthority: 'ordinary' });
    const { tailscaledOperator: _operator, ...older } = ordinary;
    expect(presentMachineAuthorityV1({ observation: older, freshness: 'current' }).tailscaledOperator)
      .toEqual({ authorization: 'unknown', freshness: 'current', currentAuthorization: 'unknown' });
  });

  it('derives Desktop limitations only from observed engine facts, independently of power', () => {
    const desktop = presentMachineAuthorityV1({ observation: ordinary, freshness: 'current', engine: 'dockerDesktop' });
    expect(desktop).toMatchObject({ hostAuthority: 'ordinary', deployment: {
      requiresAwakeComputerAndDockerDesktop: true, domains: 'unavailableDockerDesktop' } });
    expect(presentMachineAuthorityV1({ observation: ordinary, engine: 'native' }).deployment)
      .toEqual({ requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' });
  });
});
