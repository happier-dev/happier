import { describe, expect, it } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';

import {
  requireProviderConnectionAccountSettingsMutationSuccess,
} from './accountSettingsMutationRefusal';

describe('Provider connection Account Settings CAS refusal', () => {
  it('raises the canonical review_current_state refusal for an unknown mutation outcome', () => {
    let thrown: unknown;
    try {
      requireProviderConnectionAccountSettingsMutationSuccess(
        { status: 'outcomeUnknown', lastKnownVersion: 7 },
        { machineId: 'machine-a', connectionId: 'pc_1' },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual({
      v: 1,
      code: 'provider_rpc_mutation_outcome_unknown',
      machineId: 'machine-a',
      connectionId: 'pc_1',
      retryable: false,
      action: 'review_current_state',
    });
  });

  it('returns a settled mutation and leaves other unsettled outcomes untyped', () => {
    const applied = {
      status: 'applied',
      version: 3,
      settings: AccountSettingsSchema.parse({}),
    } as const;

    expect(requireProviderConnectionAccountSettingsMutationSuccess(
      applied,
      { machineId: 'machine-a' },
    )).toBe(applied);

    expect(() => requireProviderConnectionAccountSettingsMutationSuccess(
      { status: 'conflict', currentVersion: 4 },
      { machineId: 'machine-a' },
    )).toThrow(/did not settle: conflict/u);
  });
});
