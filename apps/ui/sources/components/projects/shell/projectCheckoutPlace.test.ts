import { describe, expect, it } from 'vitest';

import { describeManagedCheckoutPlace } from './projectCheckoutPlace';

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
