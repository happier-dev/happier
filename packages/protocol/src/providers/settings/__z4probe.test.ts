import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import { readProviderSettingsFromAccountSettingsV1 } from './readFromAccountSettingsV1.js';
import { ProviderSettingsV1Schema } from './v1.js';

const connection = {
  v: 1,
  id: 'pc_1',
  source: { kind: 'contribution', contributionKey: 'plugin/p' },
  role: 'default',
  displayName: 'P',
  displayNameMode: 'automatic',
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
} as const;

function baseSettings(overrides: Record<string, unknown>) {
  return {
    v: 1,
    connections: [connection],
    connectionTombstones: [],
    accountGrants: [],
    machineGrants: [],
    secretBindingsByConnectionId: {},
    manualModelsByConnectionId: {},
    modelVisibilityByRef: {},
    experimentalBindingConfirmations: [],
    defaultsByAgentTargetKey: {},
    ...overrides,
  };
}

function report(label: string, settings: Record<string, unknown>) {
  const providerParse = ProviderSettingsV1Schema.safeParse(settings);
  const bytes = new TextEncoder().encode(JSON.stringify(settings)).byteLength;
  console.log(
    `${label} PROVIDER_PARSE_OK=`,
    providerParse.success,
    'BYTES=', bytes,
    providerParse.success ? '' : JSON.stringify(providerParse.error.issues.slice(0, 2)),
  );
  const parsed = accountSettingsParse({ schemaVersion: 7, providerSettingsV1: settings });
  console.log(`${label} ACCOUNT_SUBTREE=`, parsed.providerSettingsV1 === undefined ? 'UNDEFINED' : 'PRESENT');
  const read = readProviderSettingsFromAccountSettingsV1(parsed);
  console.log(`${label} READBACK_DIAG=`, JSON.stringify(read.diagnostics.slice(0, 2)));
  return { providerParse, parsed };
}

describe('Z4 probe', () => {
  it('300 manual models under one connection (provider limit 500)', () => {
    const manual = {
      pc_1: Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}`, addedAt: 1 })),
    };
    const settings = baseSettings({ manualModelsByConnectionId: manual });
    const { providerParse } = report('MANUAL300', settings);
    expect(providerParse.success).toBe(true);
  });

  it('300 modelVisibilityByRef entries (provider limit 20000)', () => {
    const vis: Record<string, 'hidden'> = {};
    for (let i = 0; i < 300; i += 1) {
      vis[serializeModelVisibilityRefV1({
        scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: `model-${i}`,
      })] = 'hidden';
    }
    const settings = baseSettings({ modelVisibilityByRef: vis });
    const { providerParse } = report('VIS300', settings);
    expect(providerParse.success).toBe(true);
  });

  it('exceeding the 256KiB providerSettingsV1 byte cap with <=256 entries per node', () => {
    // 250 connections x 250 manual models = 62500 models, well under manualModelsTotal 5000? no.
    // Use long model ids instead: 200 models x long ids under a single connection.
    const manual = {
      pc_1: Array.from({ length: 250 }, (_, i) => ({
        id: `model-${i}-${'z'.repeat(200)}`,
        name: 'n'.repeat(250),
        addedAt: 1,
      })),
    };
    const settings = baseSettings({ manualModelsByConnectionId: manual });
    const { providerParse } = report('BYTES', settings);
    expect(providerParse.success).toBe(true);
  });
});
