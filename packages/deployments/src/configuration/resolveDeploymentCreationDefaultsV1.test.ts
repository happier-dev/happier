import { describe, expect, it } from 'vitest';
import { DeploymentCreationDefaultsV1Schema } from '@happier-dev/deployment-protocol';
import { resolveDeploymentCreationDefaultsV1 as resolve } from './resolveDeploymentCreationDefaultsV1.js';

const ownServer = { kind: 'ownServer', machines: ['runtime-one', 'runtime-two'] } as const;
const projectOwner = { kind: 'account', accountId: 'owner' } as const;

describe('deployment creation defaults', () => {
  it('resolves strict partial layers per field, preserving an explicit zero and review source', () => {
    const result = resolve({ projectSourceId: 'source', projectOwner, target: ownServer,
      explicit: DeploymentCreationDefaultsV1Schema.parse({ retainPreviousDeployments: 0 }),
      projectDefaults: { projectSourceId: 'source', deploymentDefaults: DeploymentCreationDefaultsV1Schema.parse({ buildMachineId: 'project-builder' }) },
      account: { accountId: 'owner', defaults: DeploymentCreationDefaultsV1Schema.parse({
        buildMachineId: 'account-builder', controllerMachineId: 'account-controller', retainPreviousDeployments: 9,
      }) },
    });
    expect(result).toEqual({
      values: { retainPreviousDeployments: 0, buildMachineId: 'project-builder', controllerMachineId: 'account-controller' },
      sources: { retainPreviousDeployments: 'explicit', buildMachineId: 'project', controllerMachineId: 'account' },
    });
    expect(DeploymentCreationDefaultsV1Schema.parse({})).toEqual({});
    expect(DeploymentCreationDefaultsV1Schema.parse(result.values)).toEqual(result.values);
  });

  it('skips every invoking member Account value for Team Projects and foreign Accounts', () => {
    const account = { accountId: 'owner', defaults: { buildMachineId: 'personal-builder', controllerMachineId: 'personal-controller', retainPreviousDeployments: 9 } };
    for (const owner of [{ kind: 'team', teamId: 'team' }, { kind: 'account', accountId: 'other' }] as const) {
      expect(resolve({ projectSourceId: 'source', projectOwner: owner, target: ownServer, account,
        projectDefaults: { projectSourceId: 'source', deploymentDefaults: { controllerMachineId: 'shared-controller' } } })).toEqual({
        values: { buildMachineId: 'runtime-one', controllerMachineId: 'shared-controller', retainPreviousDeployments: 1 },
        sources: { buildMachineId: 'builtin', controllerMachineId: 'project', retainPreviousDeployments: 'builtin' },
      });
    }
  });

  it('keeps platform placement honest when the invocation has no creating Machine', () => {
    expect(resolve({ projectOwner, target: { kind: 'platform' } })).toEqual({
      values: { retainPreviousDeployments: 1 }, sources: { retainPreviousDeployments: 'builtin' },
    });
    expect(resolve({ projectOwner, target: { kind: 'platform', creatingMachineId: 'creating-machine' } })).toEqual({
      values: { retainPreviousDeployments: 1, controllerMachineId: 'creating-machine' },
      sources: { retainPreviousDeployments: 'builtin', controllerMachineId: 'builtin' },
    });
    expect(resolve({ projectOwner, target: { kind: 'platform' }, account: { accountId: 'owner',
      defaults: { buildMachineId: 'own-server-builder', controllerMachineId: 'chosen-controller' } },
    })).toEqual({
      values: { retainPreviousDeployments: 1, controllerMachineId: 'chosen-controller' },
      sources: { retainPreviousDeployments: 'builtin', controllerMachineId: 'account' },
    });
  });

  it('keeps a configured own-server Environment without runtime placement distinct from a platform target', () => {
    const target = { kind: 'ownServer', machines: [] } as const;
    expect(resolve({ projectOwner, target })).toEqual({
      values: { retainPreviousDeployments: 1 }, sources: { retainPreviousDeployments: 'builtin' },
    });
    expect(resolve({ projectSourceId: 'source', projectOwner, target,
      projectDefaults: { projectSourceId: 'source', deploymentDefaults: { buildMachineId: 'future-builder' } },
      explicit: { controllerMachineId: 'configured-controller' } })).toEqual({
      values: { buildMachineId: 'future-builder', controllerMachineId: 'configured-controller', retainPreviousDeployments: 1 },
      sources: { buildMachineId: 'project', controllerMachineId: 'explicit', retainPreviousDeployments: 'builtin' },
    });
  });

  it('captures resolved review values without mutating or retaining live default pointers', () => {
    const projectDefaults = { controllerMachineId: 'reviewed-controller' };
    const explicit = { buildMachineId: 'chosen-builder' };
    const result = resolve({ projectSourceId: 'source', projectOwner, target: ownServer,
      projectDefaults: { projectSourceId: 'source', deploymentDefaults: projectDefaults }, explicit });
    expect(projectDefaults).toEqual({ controllerMachineId: 'reviewed-controller' });
    expect(explicit).toEqual({ buildMachineId: 'chosen-builder' });
    projectDefaults.controllerMachineId = 'later-controller';
    explicit.buildMachineId = 'later-builder';
    expect(result.values).toEqual({ buildMachineId: 'chosen-builder', controllerMachineId: 'reviewed-controller', retainPreviousDeployments: 1 });
  });

  it('refuses a shared leaf belonging to another Project instead of applying its values', () => {
    expect(() => resolve({ projectSourceId: 'source', projectOwner, target: ownServer,
      projectDefaults: { projectSourceId: 'foreign', deploymentDefaults: { buildMachineId: 'foreign-builder' } },
    })).toThrow(expect.objectContaining({ code: 'project_defaults_scope_mismatch' }));
  });
});
