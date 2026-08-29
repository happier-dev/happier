import { describe, expect, it } from 'vitest';

import {
  createCurrentGlobalExternalSessionsRouter,
  resolveHostApplicableExternalSessionsPublicScopes,
  unrestrictedCurrentGlobalExternalSessionsPublicAccess,
} from './currentGlobalRouting';
import type { CurrentGlobalExternalSessionsRouter } from './currentGlobalRouting';

describe('current-global External Sessions public access routing', () => {
  it('keeps only host-applicable resolved Session scopes', () => {
    const applicable = resolveHostApplicableExternalSessionsPublicScopes({
      scopes: [
        { access: ['read', 'control'] },
        { access: ['read'], machineIds: ['machine-other'] },
        { access: ['control'], machineIds: ['machine-h'] },
        { access: ['read'], projectIds: ['project-a'] },
        { access: ['write'], machineIds: ['machine-h'], projectIds: ['project-a'] },
      ],
      resolveCurrentMachineId: () => 'machine-h',
    });

    expect(applicable).toEqual([
      { access: ['read', 'control'] },
      { access: ['control'], machineIds: ['machine-h'] },
    ]);
  });

  it('drops machine-restricted scopes when the host machine identity is unavailable', () => {
    expect(resolveHostApplicableExternalSessionsPublicScopes({
      scopes: [
        { access: ['read'] },
        { access: ['control'], machineIds: ['machine-h'] },
      ],
      resolveCurrentMachineId: () => null,
    })).toEqual([{ access: ['read'] }]);
  });

  it('reads the host machine identity per resolution', () => {
    const scopes = [{ access: ['read'] as const, machineIds: ['machine-a', 'machine-b'] }];
    let currentMachine = 'machine-a';
    const resolve = () => resolveHostApplicableExternalSessionsPublicScopes({
      scopes,
      resolveCurrentMachineId: () => currentMachine,
    });

    expect(resolve()).toEqual([{ access: ['read'], machineIds: ['machine-a', 'machine-b'] }]);
    currentMachine = 'machine-b';
    expect(resolve()).toEqual([{ access: ['read'], machineIds: ['machine-a', 'machine-b'] }]);
    currentMachine = 'machine-c';
    expect(resolve()).toEqual([]);
  });

  it('defaults a published router without access resolution to unavailable', () => {
    const router = createCurrentGlobalExternalSessionsRouter(() => ({
      resolveCurrent: () => null,
      activateConfiguredSources: async () => {},
    }));

    expect(router.readPublicCallerAccess?.({
      pluginId: 'acme.plugin',
      contribution: { id: 'agent', qualifiedId: 'acme.plugin/agents/agent' },
      surface: 'agent',
    })).toEqual({ status: 'unavailable' });
  });

  it('falls back to unavailable when nothing is published', () => {
    const router = createCurrentGlobalExternalSessionsRouter((): CurrentGlobalExternalSessionsRouter | null => null);

    expect(router.readPublicCallerAccess?.({
      pluginId: 'acme.plugin',
      contribution: { id: 'agent', qualifiedId: 'acme.plugin/agents/agent' },
      surface: 'agent',
    })).toEqual({ status: 'unavailable' });
  });

  it('exposes the unrestricted grant owner-local contexts fall back to', () => {
    expect(unrestrictedCurrentGlobalExternalSessionsPublicAccess).toEqual({
      status: 'available',
      scopes: [{ access: ['read', 'write', 'control'] }],
    });
  });
});
