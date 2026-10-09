import { describe, expect, it } from 'vitest';

import {
  PluginAccountDataEraseActionInputV1Schema,
  PluginAccountDataEraseActionOutputV1Schema,
  PluginAccountDataEraseServerErrorV1Schema,
  PluginAccountDataEraseServerOutputV1Schema,
} from './accountEraseV1.js';

describe('PluginAccountDataEraseActionV1', () => {
  it('carries a native responsibility review and exact manual snapshot without claiming erase completion', () => {
    const resource = {
      managedId: 'managed-a', homeId: 'home-a', custodianAccountId: 'account-a', intentRevision: 3,
      controller: { machineId: 'controller-a', installationId: 'installation-a' },
      provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, allocation: 'bound',
      resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { id: 'native-a' } },
    };
    const disposition = {
      managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
      expectedAllocation: resource.allocation, expectedResource: resource.resource, responsibility: 'manual',
    };
    expect(PluginAccountDataEraseActionInputV1Schema.safeParse({
      pluginId: 'happier.machine.lima', managedResourceDispositions: [disposition],
    }).success).toBe(true);
    expect(PluginAccountDataEraseServerErrorV1Schema.safeParse({
      error: 'managed_resources_review_required', resources: [resource],
    }).success).toBe(true);
    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'reviewRequired', resources: [resource],
    }).success).toBe(true);
    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'reviewRequired', resources: [resource], settings: { status: 'completed', changed: true },
    }).success).toBe(false);
    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'partial', settings: { status: 'completed', changed: true },
      data: { status: 'reviewRequired', resources: [resource] },
    }).success).toBe(false);
  });
  it('accepts only a canonical plugin target and never lets a caller select an Account', () => {
    expect(PluginAccountDataEraseActionInputV1Schema.safeParse({
      pluginId: 'com.example.retained-data',
    }).success).toBe(true);

    expect(PluginAccountDataEraseActionInputV1Schema.safeParse({
      pluginId: 'com.example.retained-data',
      accountId: 'other-account',
    }).success).toBe(false);
  });

  it('requires truthful per-arm outcomes and rejects a completed overall result with unfinished work', () => {
    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'partial',
      settings: { status: 'pending', reason: 'outcome-unknown' },
      data: { status: 'pending', reason: 'outcome-unknown' },
    }).success).toBe(true);

    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'partial',
      settings: { status: 'completed', changed: true },
      data: { status: 'pending', reason: 'unavailable' },
    }).success).toBe(true);

    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'completed',
      settings: { status: 'completed', changed: false },
      data: { status: 'pending', reason: 'unavailable' },
    }).success).toBe(false);

    expect(PluginAccountDataEraseActionOutputV1Schema.safeParse({
      status: 'partial',
      settings: { status: 'completed', changed: true },
      data: { status: 'pending', reason: 'transition-cleanup' },
    }).success).toBe(true);
  });

  it('makes a bounded encryption-transition cleanup a strict retryable erase result', () => {
    expect(PluginAccountDataEraseServerOutputV1Schema.safeParse({
      status: 'transition-cleanup-pending',
    }).success).toBe(true);

    expect(PluginAccountDataEraseServerOutputV1Schema.safeParse({
      status: 'transition-cleanup-pending',
      remainingStageCount: 1,
    }).success).toBe(false);
  });

  it('makes the present-user authority rejection a typed route result', () => {
    expect(PluginAccountDataEraseServerErrorV1Schema.safeParse({
      error: 'plugin_account_data_erase_present_user_required',
    }).success).toBe(true);

    expect(PluginAccountDataEraseServerErrorV1Schema.safeParse({
      error: 'plugin_account_data_erase_present_user_required',
      accountId: 'caller-selected-account',
    }).success).toBe(false);
  });
});
