import { describe, expect, it } from 'vitest';

import { reconstructPluginUiSelectedActionInput } from './selectedActionInput.js';

describe('selected Action input reconstruction', () => {
  const account = {
    service: { pluginId: 'acme.github', localId: 'github' },
    accountId: 'account-a',
  } as const;

  it('passes through zero-field selections and restores only one non-colliding selected Account field', () => {
    const input = { repository: 'happier-dev/happier' } as const;

    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'none' },
    })).toEqual(input);
    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account },
    })).toEqual({
      repository: 'happier-dev/happier',
      credentialRef: account,
    });
  });

  it('refuses a colliding or unsafe selected Account path instead of overwriting input', () => {
    const input = {
      repository: 'happier-dev/happier',
      credentialRef: account,
    } as const;

    expect(reconstructPluginUiSelectedActionInput({
      input,
      connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account },
    })).toBeNull();
    expect(reconstructPluginUiSelectedActionInput({
      input: { repository: 'happier-dev/happier' },
      connectedAccount: { kind: 'selected', fieldPath: '__proto__.credentialRef', ref: account },
    })).toBeNull();
  });
});
