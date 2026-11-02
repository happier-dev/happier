import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse } from '../account/settings/accountSettings.js';
import { readComputerUseSettingsForMachine } from './v1.js';

describe('Machine computer-use preferences', () => {
  it('registers preferences and refuses a default outside the enabled providers', () => {
    const definition = ACCOUNT_SETTING_DEFINITIONS.computerUseByMachineId;
    expect(definition).toBeDefined();
    expect(definition.parseMutationValue({ machine: { enabledProviders: ['cua', 'agent-desktop'], defaultProvider: 'agent-desktop' } }).success).toBe(true);
    expect(definition.parseMutationValue({ machine: { enabledProviders: ['cua'], defaultProvider: 'agent-desktop' } }).success).toBe(false);
    expect(definition.parseMutationValue({ machine: { enabledProviders: [], defaultProvider: 'cua' } }).success).toBe(false);
    expect(accountSettingsParse({}).computerUseByMachineId).toEqual({});
    expect(readComputerUseSettingsForMachine(accountSettingsParse({}), 'machine')).toEqual({ enabledProviders: ['cua'], defaultProvider: 'cua' });
  });
});
