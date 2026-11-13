import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';

installMachinesSettingsCommonModuleMocks();

async function render(metadataPatch: Record<string, unknown>, online: boolean | null) {
  const { MachineRolesSection } = await import('./MachineRolesSection');
  const base = createMachineFixture({ id: 'shop-prod' });
  // An owned Machine (legacy custody projection): Manage.
  const machine = { ...base, isShared: false, metadata: { ...base.metadata!, ...metadataPatch } };
  return await renderScreen(React.createElement(MachineRolesSection, { serverId: 'home', machine, machineName: 'shop-prod', online }));
}
const toggle = (screen: Awaited<ReturnType<typeof render>>, roleId: string) => {
  const row = findTestInstanceByTypeWithProps(screen, Item, { testID: `machine-roles-row-${roleId}` });
  return row?.props.rightElement.props as React.ComponentProps<typeof Switch> | undefined;
};

describe('Machine roles section', () => {
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
