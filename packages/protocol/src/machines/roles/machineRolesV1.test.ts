import { describe, expect, it } from 'vitest';

import type { MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';
import {
  CORE_MACHINE_ROLE_IDS_V1,
  MachineRoleDeclarationV1Schema,
  isMachineRoleActiveV1,
  matchesManagedMachineEnrollmentRolesV1,
  mutateMachineRolesV1,
  readMachineRolesV1,
  resolveActiveMachineRolesV1,
  resolveManagedMachineEnrollmentRolesV1,
  type MachineRoleCatalogEntryV1,
} from './machineRolesV1.js';

const allCore = [...CORE_MACHINE_ROLE_IDS_V1];

function port(initial: Record<string, unknown>, version = 4) {
  let metadata = initial;
  let metadataVersion = version;
  const writes: Record<string, unknown>[] = [];
  const value: MachineMetadataFieldPortV1 = {
    read: async () => ({ status: 'ready', metadata, metadataVersion }),
    compareAndSwap: async input => {
      if (input.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
      writes.push(input.metadata);
      metadata = input.metadata;
      metadataVersion += 1;
      return { status: 'applied', metadata, metadataVersion };
    },
  };
  return { port: value, writes, current: () => metadata };
}

describe('Machine roles policy', () => {
  it('reads a missing field as every core role (today) and keeps a stored explicit set', () => {
    expect(readMachineRolesV1({ host: 'laptop' })).toEqual({ status: 'ready', policy: { active: allCore }, source: 'default' });
    expect(readMachineRolesV1({ rolesV1: { active: ['sessions'] } })).toEqual({ status: 'ready', policy: { active: ['sessions'] }, source: 'stored' });
    expect(readMachineRolesV1({ rolesV1: { active: 'sessions' } })).toEqual({ status: 'invalid' });
    expect(readMachineRolesV1(null)).toEqual({ status: 'unavailable' });
  });

  it('answers one question for every reader: missing/unreadable = active, stored = membership', () => {
    expect(allCore.every(roleId => isMachineRoleActiveV1({ host: 'x' }, roleId))).toBe(true);
    expect(isMachineRoleActiveV1(undefined, 'sessions')).toBe(true);
    expect(isMachineRoleActiveV1({ rolesV1: { active: ['broker'] } }, 'sessions')).toBe(false);
    expect(isMachineRoleActiveV1({ rolesV1: { active: ['broker'] } }, 'broker')).toBe(true);
    // An unknown stored id (uninstalled plugin) stays stored and inactive.
    expect(isMachineRoleActiveV1({ rolesV1: { active: ['acme/gone'] } }, 'acme/gone')).toBe(false);
  });

  it('applies plugin defaults, requires and core-role membership through the same resolver', () => {
    const catalog: MachineRoleCatalogEntryV1[] = [
      { id: 'acme/tests', requires: ['sessions'], defaultActive: true },
      { id: 'acme/optional' },
      { id: 'channels/intake', partOf: 'intake' },
    ];
    const missing = resolveActiveMachineRolesV1({ host: 'x' }, catalog);
    expect([...missing].sort()).toEqual([...allCore, 'acme/tests', 'channels/intake'].sort());
    const stored = resolveActiveMachineRolesV1({ rolesV1: { active: ['broker', 'acme/tests', 'acme/optional'] } }, catalog);
    // acme/tests needs sessions; channels/intake follows intake.
    expect([...stored].sort()).toEqual(['acme/optional', 'broker']);
    expect(isMachineRoleActiveV1({ rolesV1: { active: ['intake'] } }, 'channels/intake', catalog)).toBe(true);
  });

  it('seeds defaults per managed install type; existing/personal keep the missing field', () => {
    expect(resolveManagedMachineEnrollmentRolesV1({ kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
      role: 'server', adminAccessAtCreation: 'none' })).toEqual({ active: ['sessions', 'broker', 'workspaces', 'relay'] });
    expect(resolveManagedMachineEnrollmentRolesV1({ kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
      role: 'deployTarget', adminAccessAtCreation: 'none' })).toEqual({ active: ['deployments', 'sessions'] });
    expect(resolveManagedMachineEnrollmentRolesV1({ kind: 'guestProcess', role: 'sandbox' })).toEqual({ active: ['sessions'] });
    expect(resolveManagedMachineEnrollmentRolesV1({ kind: 'existingUser', role: 'personal' })).toBeNull();
    expect(resolveManagedMachineEnrollmentRolesV1(undefined)).toBeNull();
  });

  it('lets a creation child write only its reviewed seed over the missing field', () => {
    const target = { homeId: 'home', machineId: 'm1', enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const } };
    const seed = { serverId: 'home', machineId: 'm1', expectedMetadataVersion: 0, expectedPolicy: { active: allCore }, policy: { active: ['sessions'] } };
    expect(matchesManagedMachineEnrollmentRolesV1(target, seed)).toBe(true);
    // Sandboxes may hold broker later (not forbidden), but creation seeds only its reviewed default.
    expect(matchesManagedMachineEnrollmentRolesV1(target, { ...seed, policy: { active: ['sessions', 'broker'] } })).toBe(false);
    expect(matchesManagedMachineEnrollmentRolesV1(target, { ...seed, machineId: 'm2' })).toBe(false);
  });

  it('writes through field CAS and rebases unrelated metadata edits', async () => {
    const machine = port({ host: 'x', displayName: 'a' });
    const result = await mutateMachineRolesV1({ expectedMetadataVersion: 2, expectedPolicy: { active: allCore },
      policy: { active: ['broker', 'sessions'] } }, machine.port);
    expect(result).toEqual({ status: 'applied', policy: { active: ['broker', 'sessions'] }, metadataVersion: 5 });
    expect(machine.writes).toHaveLength(1);
    expect(machine.current()).toMatchObject({ displayName: 'a', rolesV1: { active: ['broker', 'sessions'] } });
    // Same set in another order is unchanged and writes nothing.
    const again = await mutateMachineRolesV1({ expectedMetadataVersion: 5, expectedPolicy: { active: ['sessions', 'broker'] },
      policy: { active: ['sessions', 'broker'] } }, machine.port);
    expect(again.status).toBe('unchanged');
    expect(machine.writes).toHaveLength(1);
    // A concurrent role change is a conflict, never overwritten.
    const stale = await mutateMachineRolesV1({ expectedMetadataVersion: 5, expectedPolicy: { active: allCore },
      policy: { active: ['voice'] } }, machine.port);
    expect(stale).toMatchObject({ status: 'conflict', policy: { active: ['broker', 'sessions'] } });
    expect(await mutateMachineRolesV1({ expectedMetadataVersion: 5, expectedPolicy: { active: [] }, policy: { active: ['sessions', 'sessions'] } }, machine.port))
      .toEqual({ status: 'invalid' });
  });

  it('declares core roles and plugin machineRoles with one schema', () => {
    expect(MachineRoleDeclarationV1Schema.safeParse({ id: 'intake', title: 'Intake', description: 'Channels', partOf: 'intake',
      backgroundServices: ['poller'] }).success).toBe(true);
    expect(MachineRoleDeclarationV1Schema.safeParse({ id: 'tests', title: 'T', description: 'D', requires: ['sessions'], defaultActive: true }).success).toBe(true);
    expect(MachineRoleDeclarationV1Schema.safeParse({ id: 'x', title: 'T', description: 'D', partOf: 'not-a-core-role' }).success).toBe(false);
  });
});
