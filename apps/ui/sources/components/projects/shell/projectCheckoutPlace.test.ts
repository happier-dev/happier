import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { checkoutPlaceKey, describeManagedCheckoutPlace, describeSiblingCheckoutPlace } from './projectCheckoutPlace';

const names = new Map([['m-nl3', { name: 'nl3', hint: null }]]);
const parts = (id: string) => names.get(id) ?? null;

describe('the Project checkout chip for an attached workspace (remote workspaces lab project-ok)', () => {
  it('names the workspace by its own name, reached via its controller Machine', () => {
    expect(describeManagedCheckoutPlace({ controllerMachineId: 'm-nl3', machineNameParts: parts, managedName: 'api-dev' }))
      .toEqual({ machineName: 'api-dev', machineNameParts: { name: 'api-dev', hint: 'via nl3' }, machineIcon: 'terminal' });
  });

  it('never shows a placeholder while the workspace or its controller name is still resolving', () => {
    expect(describeManagedCheckoutPlace({ controllerMachineId: 'm-nl3', machineNameParts: parts, managedName: null }))
      .toEqual({ machineName: '', machineNameParts: { name: '', hint: null }, machineIcon: 'terminal' });
    expect(describeManagedCheckoutPlace({ controllerMachineId: 'm-unknown', machineNameParts: parts, managedName: 'api-dev' }))
      .toEqual({ machineName: 'api-dev', machineNameParts: { name: 'api-dev', hint: null }, machineIcon: 'terminal' });
  });
});

describe('sibling checkouts in the chip menu, by place (HUNT line 18)', () => {
  const controller = { machineId: 'm-nl3', installationId: 'i-nl3' };
  const managed = (id: string, managedId: string): WorkspaceRefV1 => ({ v: 2, kind: 'managed', id, serverId: 's', managedId,
    controller, rootPath: '/home/coder/api', createdAtMs: 1 });
  const onMachine = (id: string, machineId: string): WorkspaceRefV1 => ({ id, serverId: 's', machineId, rootPath: '/repo', createdAtMs: 1 });
  const naming = { machineName: (id: string) => (id === 'm-nl3' ? 'nl3' : id === 'm-mbp' ? 'leeroy-mbp' : ''),
    managedName: (id: string) => (id === 'api-dev' ? 'api-dev' : null) };

  it('tells two attached workspaces on one controller apart, and either from a checkout on that controller', () => {
    // Flat Machine ids made both workspaces "the same machine" and hid them from each other.
    const place = (ref: WorkspaceRefV1) => checkoutPlaceKey(workspaceAddressFromRefV2(ref));
    expect(place(managed('a', 'api-dev'))).not.toBe(place(managed('b', 'gpu-box')));
    expect(place(managed('a', 'api-dev'))).not.toBe(place(onMachine('c', 'm-nl3')));
    expect(place(managed('a', 'api-dev'))).toBe(place(managed('d', 'api-dev')));
  });

  it('presents an attached workspace by its own name via its controller, never as a Machine', () => {
    expect(describeSiblingCheckoutPlace(managed('a', 'api-dev'), naming)).toEqual({
      subtitle: `api-dev · ${t('projects.checkouts.via', { machine: 'nl3' })} · /home/coder/api`,
      category: t('projects.checkouts.onServers'), icon: 'terminal' });
    expect(describeSiblingCheckoutPlace(managed('b', 'gpu-box'), naming).subtitle)
      .toBe(`${t('projects.checkouts.via', { machine: 'nl3' })} · /home/coder/api`);
    expect(describeSiblingCheckoutPlace(onMachine('c', 'm-mbp'), naming)).toEqual({
      subtitle: 'leeroy-mbp · /repo', category: t('projects.checkouts.otherMachines'), icon: 'desktop' });
  });
});
