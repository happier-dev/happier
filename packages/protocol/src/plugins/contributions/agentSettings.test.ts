import { describe, expect, it } from 'vitest';

import {
  buildAgentSettingsDefaults,
  defineAgentSettingsContribution,
  PluginAgentSettingsContributionV1Schema,
  PluginAgentSettingsFieldV1Schema,
  agentSettingsContributionToUiDescriptor,
  stringRecordAgentSetting,
} from './agentSettings.js';

describe('agent settings contributions', () => {
  it('accepts string-record settings and projects them to defaults and UI descriptors', () => {
    const contribution = defineAgentSettingsContribution({
      id: 'acme.agentSettings.v1',
      agentId: 'acme',
      fields: [
        stringRecordAgentSetting({
          id: 'acmeServerBaseUrlByServerIdV1',
          default: {
            local: 'http://127.0.0.1:4096',
          },
          description: 'Per-server Acme server URL overrides',
          ui: {
            kind: 'text',
            title: { key: 'settingsProviders.plugins.acme.fields.serverBaseUrl.title' },
            binding: {
              kind: 'perActiveServer',
              fallbackSettingKey: 'acmeServerBaseUrl',
              byServerIdSettingKey: 'acmeServerBaseUrlByServerIdV1',
            },
          },
        }),
      ],
      ui: {
        sections: [
          {
            id: 'server',
            title: { key: 'settingsProviders.plugins.acme.sections.server.title' },
            fields: ['acmeServerBaseUrlByServerIdV1'],
          },
        ],
        subagentSettingsSections: [],
      },
    });

    const parsed = PluginAgentSettingsContributionV1Schema.safeParse(contribution);
    if (!parsed.success) {
      throw new Error('Expected string-record agent settings contribution to parse');
    }

    expect(buildAgentSettingsDefaults(parsed.data)).toEqual({
      acmeServerBaseUrlByServerIdV1: {
        local: 'http://127.0.0.1:4096',
      },
    });
    expect(agentSettingsContributionToUiDescriptor(parsed.data)).toMatchObject({
      settings: {
        acmeServerBaseUrlByServerIdV1: {
          schema: { kind: 'stringRecord' },
          default: {
            local: 'http://127.0.0.1:4096',
          },
          storageScope: 'account',
        },
      },
      uiSections: [
        {
          id: 'server',
          fields: [
            {
              key: 'acmeServerBaseUrlByServerIdV1',
              kind: 'text',
              binding: {
                kind: 'perActiveServer',
                fallbackSettingKey: 'acmeServerBaseUrl',
                byServerIdSettingKey: 'acmeServerBaseUrlByServerIdV1',
              },
            },
          ],
        },
      ],
    });
  });

  it('rejects non-record and non-string string-record defaults without throwing', () => {
    for (const defaultValue of [
      null,
      ['http://127.0.0.1:4096'],
      { local: 4096 },
    ]) {
      const result = PluginAgentSettingsFieldV1Schema.safeParse({
        id: 'acmeServerBaseUrlByServerIdV1',
        schema: { kind: 'stringRecord' },
        default: defaultValue,
        description: 'Per-server Acme server URL overrides',
      });

      expect(result.success).toBe(false);
    }
  });
});
