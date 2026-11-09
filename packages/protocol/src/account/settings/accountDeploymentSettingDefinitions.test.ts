import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from './accountSettings.js';
import { applyAccountSettingMutationV1 } from './accountSettingMutationV1.js';
import { buildBuiltInAccountSettingMutationV1, parseBuiltInAccountSettingValueV1,
  readBuiltInSettingDeclarationV1 } from '../../actions/settings/settingsDeclarations.js';

describe('deployment creation preferences through Account settings', () => {
  it('keeps absent preferences partial and admits only domain creation choices', () => {
    expect(accountSettingsParse({}).deploymentDefaultsV1).toEqual({});
    const value = { buildMachineId: 'builder', controllerMachineId: 'controller', retainPreviousDeployments: 0 };
    expect(applyAccountSettingMutationV1({ unrelated: true }, { operations: [
      { op: 'set', key: 'deploymentDefaultsV1', value },
    ] })).toEqual({ status: 'applied', raw: { unrelated: true, deploymentDefaultsV1: value } });
    for (const invalid of [
      { rollout: 'startFirst' }, { autoRestorePreviousRelease: false }, { deployApproval: 'automatic' },
      { ingress: { kind: 'cloudflareTunnel' } }, { forkPreviewMode: 'automatic' }, { failuresInARow: 2 },
      { buildMachineId: ' ' }, { controllerMachineId: null }, { retainPreviousDeployments: -1 },
    ]) {
      expect(applyAccountSettingMutationV1({}, { operations: [
        { op: 'set', key: 'deploymentDefaultsV1', value: invalid },
      ] })).toMatchObject({ status: 'invalid' });
    }
  });

  it('exposes the same strict preference through standard Settings declaration Actions', () => {
    const anchor = 'deployments.creationDefaults';
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    expect(declaration?.storage).toEqual({
      scope: 'account', key: 'deploymentDefaultsV1', access: 'read_write',
    });
    if (!declaration) throw new Error('Deployment preferences declaration is absent');
    expect(buildBuiltInAccountSettingMutationV1(declaration, {}, { retainPreviousDeployments: 0 }))
      .toEqual({ deploymentDefaultsV1: { retainPreviousDeployments: 0 } });
    expect(parseBuiltInAccountSettingValueV1(declaration, { rollout: 'startFirst' }))
      .toEqual({ success: false });
  });
});
