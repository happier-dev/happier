import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

function getCodexBackend() {
  const backend = PLUGIN_MANIFEST.contributes?.agents?.find((entry) => entry.id === 'codex');
  if (!backend) {
    throw new Error('Expected Codex plugin manifest to declare codex backend contribution');
  }
  return backend;
}

describe('Codex B.5 surface declarations', () => {
  it('uses only native Agent surface capabilities instead of legacy daemon handler declarations', () => {
    const backend = getCodexBackend();
    expect(backend).not.toHaveProperty('surfaceHandlers');
    expect(backend.capabilities.surfaces).toEqual(['terminal', 'externalSessions']);
    expect(backend.capabilities.sessions.open).toEqual(['create', 'resume', 'fork']);
    expect(backend.capabilities.sessions.delivery).toEqual(['newTurn', 'steer']);
    expect(backend.capabilities.executionRuns).toMatchObject({
      open: ['create', 'resume'],
      checkpoint: true,
      stop: true,
    });
    expect(backend.capabilities.sessions).toMatchObject({
      goals: {
        inactive: {
          get: true,
          clear: true,
          set: {
            fields: ['objective', 'status', 'tokenBudget'],
            writableStatuses: ['active', 'paused', 'complete'],
          },
        },
      },
      catalog: { inactive: ['vendorPlugins', 'skills'] },
      usageLimitRecovery: { inactive: ['checkNow'] },
    });
  });

  it('declares the Codex external-session source schema and source-key rules in the backend manifest surface', () => {
    expect(getCodexBackend().surfaces?.externalSession?.sources).toEqual([
      {
        sourceKind: 'codexHome',
        schema: {
          fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            { name: 'homePath', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
          ],
          refinements: [
            {
              kind: 'requiresWhenEquals',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'forbidsWhenEquals',
              fields: ['connectedServiceId', 'connectedServiceProfileId', 'connectedServiceGroupId'],
              when: { field: 'home', equals: 'user' },
            },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'codexHome' },
            { kind: 'homeMode', field: 'home' },
            {
              kind: 'conditionalField',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'connectedServiceScope',
              groupField: 'connectedServiceGroupId',
              profileField: 'connectedServiceProfileId',
              when: { field: 'home', equals: 'connectedService' },
            },
            { kind: 'field', field: 'homePath' },
          ],
        },
        instances: [
          { kind: 'default', constants: { home: 'user' } },
          {
            kind: 'connectedServiceProfiles',
            serviceId: 'openai-codex',
            constants: { home: 'connectedService' },
            fields: { serviceId: 'connectedServiceId', profileId: 'connectedServiceProfileId' },
          },
        ],
      },
    ]);
  });
});
