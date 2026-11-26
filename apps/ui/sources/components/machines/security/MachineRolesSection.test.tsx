import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { findTestInstanceByTypeWithProps, renderHook, renderScreen } from '@/dev/testkit';
import { createHydratedPlainMachineFixture, createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
installMachinesSettingsCommonModuleMocks();

async function render(metadataPatch: Record<string, unknown>, online: boolean | null, serverId = 'home') {
  const { MachineRolesSection } = await import('./MachineRolesSection');
  const base = createHydratedPlainMachineFixture({ id: 'shop-prod', accountId: 'account-a' });
  const machine = { ...base, metadata: { ...base.metadata!, ...metadataPatch } };
  return await renderScreen(React.createElement(MachineRolesSection, { serverId, machine, machineName: 'shop-prod', online }));
}
const toggle = (screen: Awaited<ReturnType<typeof render>>, roleId: string) => {
  const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `machine-roles-row-${roleId}` });
  return row?.props.rightElement.props as React.ComponentProps<typeof Switch> | undefined;
};

describe('Machine roles section', () => {
  it.each([
    { status: 'outcomeUnknown', title: 'machineDetailPage.roles.title', message: 'errors.scmOutcomeUnknown' },
    { status: 'locked', title: 'machineDetailPage.roles.saveFailed', message: 'machine.lockedMachine' },
  ])('presents the role change result $status without discarding the outcome returned to the Agent', async ({ status, title, message }) => {
    const serverId = await homes.addHome({ name: 'Roles', serverUrl: 'https://roles.test',
      serverIdentityId: 'srv_roles', accountId: 'account-a', currentAccount: true });
    await homes.setActionPolicy(serverId, 'machines.roles.set', 'agent', 'allowed');
    await homes.setActionPolicy(serverId, 'machines.roles.set', 'ui', 'allowed');
    boundary.rpc.mockResolvedValue({ status });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { Modal } = await import('@/modal');
    const alert = vi.spyOn(Modal, 'alert');
    const { useMachineRolesEditor } = await import('./useMachineRolesEditor');
    const input = { machineId: 'shop-prod', expectedMetadataVersion: 0,
      expectedPolicy: { active: ['broker', 'sessions'] }, policy: { active: ['broker'] } };
    const base = createHydratedPlainMachineFixture({ id: input.machineId, accountId: 'account-a' });
    const machine = { ...base, metadata: { ...base.metadata!, rolesV1: input.expectedPolicy } };
    const editor = await renderHook(() => useMachineRolesEditor({ scope: serverId, machine, machineName: input.machineId, online: true }));
    try {
      const executor = createDefaultActionExecutor();
      const context = { surface: 'agent', authority: 'account_automation', serverId } as const;
      await expect(executor.execute('machines.roles.set', input, { ...context, expectedAccountId: 'account-b' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
      expect(boundary.rpc).not.toHaveBeenCalled();
      await expect(executor.execute('machines.roles.set', input, { ...context, expectedAccountId: 'account-a' }))
        .resolves.toMatchObject({ ok: true, result: { status } });
      boundary.rpc.mockClear();
      await act(async () => { await editor.getCurrent().setRole('sessions', false); });
      expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.MACHINES_ROLES_SET,
        payload: expect.objectContaining({ policy: input.policy }) }));
      expect(alert).toHaveBeenCalledWith(title, message);
      expect(editor.getCurrent().shownActive.has('sessions')).toBe(true);
    } finally { await editor.unmount(); await homes.reset(); boundary.rpc.mockReset(); alert.mockRestore(); }
  });

  it('shows every built-in role on for a Machine with no saved roles (today)', async () => {
    const screen = await render({}, true);
    for (const roleId of ['sessions', 'broker', 'intake', 'deployments', 'workspaces', 'relay', 'memory', 'voice', 'devices']) {
      expect(toggle(screen, roleId)).toMatchObject({ value: true, disabled: false });
    }
  });

  it('shows the saved set, says running Sessions keep going, and is read-only while offline', async () => {
    const screen = await render({ rolesV1: { active: ['broker'] } }, false);
    expect(toggle(screen, 'sessions')).toMatchObject({ value: false, disabled: true });
    expect(toggle(screen, 'broker')).toMatchObject({ value: true, disabled: true });
    const sessions = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-roles-row-sessions' });
    expect(String(sessions?.props.subtitle)).toContain('machineDetailPage.roles.sessionsOffNote');
  });

  it('lists a published plugin part under its built-in role, which is its only switch', async () => {
    const { MachineRolesSection } = await import('./MachineRolesSection');
    const base = createMachineFixture({ id: 'shop-prod' });
    const daemonState = { status: 'running', machineRoles: { plugins: [{ pluginId: 'happier.channels', declaration: {
      id: 'intake', title: 'Channels', description: 'Conversation ingress.', partOf: 'intake', backgroundServices: ['ingress-supervisor'] } }] } };
    const screen = await renderScreen(React.createElement(MachineRolesSection, { serverId: 'home',
      machine: { ...base, isShared: false, daemonState }, machineName: 'shop-prod', online: true }));
    const intake = findTestInstanceByTypeWithProps(screen, Item, { testID: 'machine-roles-row-intake' });
    expect(String(intake?.props.subtitle)).toContain('machineDetailPage.roles.pluginParts');
    expect(toggle(screen, 'happier.channels/intake')).toBeUndefined();
  });

  it('is read-only for a Team-shared member without Manage', async () => {
    const { MachineRolesSection } = await import('./MachineRolesSection');
    const base = createMachineFixture({ id: 'shop-prod' });
    const screen = await renderScreen(React.createElement(MachineRolesSection, { serverId: 'home', machine: { ...base, isShared: true }, machineName: 'shop-prod', online: true }));
    expect(toggle(screen, 'sessions')).toMatchObject({ value: true, disabled: true });
  });
});
