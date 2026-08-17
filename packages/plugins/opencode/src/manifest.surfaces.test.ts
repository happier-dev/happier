import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenCode plugin session surface declarations', () => {
  it('declares public External Sessions capability without legacy rich surfaceHandlers', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(agent?.capabilities.surfaces).toContain('externalSessions');
    expect(agent).not.toHaveProperty('surfaceHandlers');
  });

  it('declares the OpenCode external-session source schema and source-key rules in the backend manifest surface', () => {
    const backend = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(backend?.surfaces?.externalSession?.sources).toEqual([
      {
        sourceKind: 'opencodeServer',
        schema: {
          fields: [
            { name: 'kind', kind: 'literal', value: 'opencodeServer' },
            { name: 'baseUrl', kind: 'unknown', optional: true },
            { name: 'directory', kind: 'unknown', optional: true },
            { name: 'managedEndpoint', kind: 'unknown', optional: true },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'opencodeServer' },
            { kind: 'field', field: 'baseUrl' },
            { kind: 'field', field: 'directory' },
          ],
        },
        instances: [
          { kind: 'default', constants: { managedEndpoint: true } },
          {
            kind: 'agentSetting',
            settingId: 'opencodeServerBaseUrl',
            byServerIdSettingId: 'opencodeServerBaseUrlByServerIdV1',
            field: 'baseUrl',
            normalization: 'httpOrigin',
          },
        ],
      },
    ]);
  });
});
