import { describe, expect, expectTypeOf, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';
import type { PluginJsonValueV2 } from './publicTypes.js';
import {
  type PluginSettingFieldSchemaV2,
  PluginSettingsContributionV2Schema,
  readPluginSettingSecretCustody,
} from './settings.js';

describe('canonical settings contributions', () => {
  it('keeps schema enum and const values inside the canonical plugin JSON domain', () => {
    expectTypeOf<NonNullable<PluginSettingFieldSchemaV2['enum']>[number]>()
      .toEqualTypeOf<PluginJsonValueV2>();
    expectTypeOf<PluginSettingFieldSchemaV2['const']>()
      .toEqualTypeOf<PluginJsonValueV2 | undefined>();
  });

  it('normalizes the secret declaration custody at the Protocol owner', () => {
    expect(readPluginSettingSecretCustody(true)).toBe('account');
    expect(readPluginSettingSecretCustody({ custody: 'daemon' })).toBe('daemon');
    expect(readPluginSettingSecretCustody(false)).toBeNull();
    expect(readPluginSettingSecretCustody({ custody: 'other' })).toBeNull();
  });

  it('uses one strict settings family for plugin and Agent targets', () => {
    const pluginSettings = PluginSettingsContributionV2Schema.parse({
      id: 'general',
      title: 'General',
      target: { kind: 'plugin' },
      scope: 'account',
      fields: [{
        id: 'enabled',
        title: 'Enabled',
        schema: { type: 'boolean' },
        default: true,
      }],
    });
    const agentSettings = PluginSettingsContributionV2Schema.parse({
      id: 'agent-runtime',
      title: 'Agent runtime',
      target: { kind: 'agent', agent: 'reviewer' },
      scope: 'daemon',
      fields: [{
        id: 'credential-ref',
        title: 'Credential',
        description: 'Opaque credential reference',
        schema: { type: 'string' },
      }],
    });

    expect(pluginSettings.target).toEqual({ kind: 'plugin' });
    expect(pluginSettings.version).toBe(1);
    expect(pluginSettings.presentation).toEqual({
      sections: [],
      subagentSections: [],
    });
    expect(pluginSettings.actions).toEqual([]);
    expect(agentSettings.target).toEqual({ kind: 'agent', agent: 'reviewer' });
    for (const retiredScope of ['local', 'synced', 'project', 'session'] as const) {
      expect(PluginSettingsContributionV2Schema.safeParse({
        id: `retired-${retiredScope}`,
        title: 'Retired scope',
        target: { kind: 'plugin' },
        scope: retiredScope,
        fields: [],
      }).success).toBe(false);
    }
    expect(PluginContributesV2Schema.safeParse({
      agentSettings: [{ id: 'retired', agentId: 'reviewer', fields: [] }],
    }).success).toBe(false);
  });

  it('accepts explicit secret custody independently of Settings scope and confines perActiveServer to Account', () => {
    expect(PluginSettingsContributionV2Schema.parse({
      id: 'daemon-status',
      title: 'Daemon status',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'account-secret',
        title: 'Account secret',
        schema: { type: 'string' },
        secret: { custody: 'account' },
      }, {
        id: 'daemon-secret',
        title: 'Daemon secret',
        schema: { type: 'string' },
        secret: { custody: 'daemon' },
      }],
    }).fields.map((field) => field.secret)).toEqual([
      { custody: 'account' },
      { custody: 'daemon' },
    ]);

    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'daemon-server-binding',
      title: 'Daemon server binding',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'fallback',
        title: 'Fallback',
        schema: { type: 'string' },
      }, {
        id: 'by-server',
        title: 'By server',
        schema: { type: 'object' },
        presentation: {
          hidden: true,
          binding: {
            kind: 'perActiveServer',
            fallbackSettingId: 'fallback',
            byServerIdSettingId: 'by-server',
          },
        },
      }],
    }).success).toBe(false);
  });

  it('binds a daemon secret to one Account endpoint declaration without making the secret an Account value', () => {
    const valid = PluginSettingsContributionV2Schema.safeParse({
      id: 'attached-service',
      title: 'Attached service',
      target: { kind: 'plugin' },
      scope: 'account',
      fields: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string' },
        presentation: {
          binding: {
            kind: 'perActiveServer',
            fallbackSettingId: 'endpoint',
            byServerIdSettingId: 'endpointByServer',
          },
        },
      }, {
        id: 'endpointByServer',
        title: 'Endpoint by server',
        schema: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        presentation: { hidden: true },
      }, {
        id: 'password',
        title: 'Password',
        schema: { type: 'string' },
        secret: {
          custody: 'daemon',
          managedServiceOrigin: { endpointSettingId: 'endpoint' },
        },
      }],
    });

    expect(valid.success).toBe(true);
    expect(valid.data?.fields[2]?.secret).toEqual({
      custody: 'daemon',
      managedServiceOrigin: { endpointSettingId: 'endpoint' },
    });

    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'wrong-scope',
      title: 'Wrong scope',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string' },
      }, {
        id: 'password',
        title: 'Password',
        schema: { type: 'string' },
        secret: {
          custody: 'daemon',
          managedServiceOrigin: { endpointSettingId: 'endpoint' },
        },
      }],
    }).success).toBe(false);

    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'wrong-endpoint',
      title: 'Wrong endpoint',
      target: { kind: 'plugin' },
      scope: 'account',
      fields: [{
        id: 'password',
        title: 'Password',
        schema: { type: 'string' },
        secret: {
          custody: 'daemon',
          managedServiceOrigin: { endpointSettingId: 'missingEndpoint' },
        },
      }],
    }).success).toBe(false);
  });

  it('requires per-active-server maps to mirror the visible scalar schema and stay bounded at admission', () => {
    const base = {
      id: 'server-endpoint',
      title: 'Server endpoint',
      target: { kind: 'plugin' as const },
      scope: 'account' as const,
      fields: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string' as const, minLength: 1 },
        presentation: {
          binding: {
            kind: 'perActiveServer' as const,
            fallbackSettingId: 'endpoint',
            byServerIdSettingId: 'endpointByServer',
          },
        },
      }, {
        id: 'endpointByServer',
        title: 'Endpoint by server',
        schema: {
          type: 'object' as const,
          additionalProperties: { type: 'string' as const, minLength: 1 },
        },
        presentation: { hidden: true },
      }],
    };

    expect(PluginSettingsContributionV2Schema.safeParse({
      ...base,
      fields: [
        base.fields[0],
        {
          ...base.fields[1],
          schema: {
            type: 'object' as const,
            additionalProperties: { type: 'number' as const },
          },
        },
      ],
    }).success).toBe(false);

    expect(PluginSettingsContributionV2Schema.safeParse({
      ...base,
      fields: [
        base.fields[0],
        {
          ...base.fields[1],
          default: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
            `server-${index}`,
            `https://server-${index}.example.test`,
          ])),
        },
      ],
    }).success).toBe(false);

    expect(PluginSettingsContributionV2Schema.safeParse({
      ...base,
      fields: [
        base.fields[0],
        {
          ...base.fields[1],
          default: { 'server-a': 'x'.repeat(65_537) },
        },
      ],
    }).success).toBe(false);

    expect(PluginSettingsContributionV2Schema.safeParse({
      ...base,
      fields: [
        base.fields[0],
        {
          ...base.fields[1],
          default: { 'server-a': { one: { two: { three: { four: 'too-deep' } } } } },
        },
      ],
    }).success).toBe(false);
  });

  it('carries the Agent settings version, typed presentation, sections, and subagent navigation', () => {
    const settings = PluginSettingsContributionV2Schema.parse({
      id: 'agent-settings',
      version: 1,
      title: { key: 'settings.agent.title', fallback: 'Agent settings' },
      target: {
        kind: 'agent',
        agent: { pluginId: 'acme.agent', localId: 'reviewer' },
      },
      scope: 'account',
      presentation: {
        icon: {
          ionName: 'sparkles-outline',
          color: { kind: 'theme', token: 'orange' },
        },
        sections: [{
          id: 'runtime',
          title: { key: 'settings.agent.runtime', fallback: 'Runtime' },
          fields: ['runtimeMode', 'debugCategories'],
        }],
        subagentSections: [{
          id: 'teams',
          title: { key: 'settings.agent.teams', fallback: 'Teams' },
          items: [{
            id: 'teammates',
            title: { key: 'settings.agent.teammates', fallback: 'Teammates' },
            route: '/settings/agents/reviewer/teammates',
            iconIonName: 'people-outline',
          }],
        }],
      },
      fields: [{
        id: 'runtimeMode',
        title: { key: 'settings.agent.mode', fallback: 'Runtime mode' },
        schema: { type: 'string', enum: ['remote', 'terminal'] },
        default: 'remote',
        presentation: {
          control: 'select',
          options: [{
            value: 'remote',
            title: { key: 'settings.agent.mode.remote', fallback: 'Remote' },
          }, {
            value: 'terminal',
            title: { key: 'settings.agent.mode.terminal', fallback: 'Terminal' },
          }],
        },
      }, {
        id: 'debugCategories',
        title: 'Debug categories',
        schema: {
          type: 'array',
          items: { type: 'string', enum: ['api', 'hooks'] },
          maxItems: 2,
        },
        default: [],
        presentation: {
          control: 'multiSelect',
          options: [{
            value: 'api',
            title: 'API',
          }, {
            value: 'hooks',
            title: 'Hooks',
          }],
        },
      }],
    });

    expect(settings.version).toBe(1);
    expect(settings.scope).toBe('account');
    expect(settings.presentation.sections[0]?.fields).toEqual(['runtimeMode', 'debugCategories']);
    expect(settings.fields[0]?.presentation?.options).toHaveLength(2);
    expect(settings.presentation.subagentSections[0]?.items[0]?.route).toBe(
      '/settings/agents/reviewer/teammates',
    );
  });

  it('rejects presentation references and options that diverge from the typed field schema', () => {
    const base = {
      id: 'agent-settings',
      title: 'Agent settings',
      target: { kind: 'agent' as const, agent: 'reviewer' },
      scope: 'account' as const,
      presentation: {
        sections: [{
          id: 'runtime',
          title: 'Runtime',
          fields: ['missingField'],
        }],
        subagentSections: [],
      },
      fields: [{
        id: 'runtimeMode',
        title: 'Runtime mode',
        schema: { type: 'string' as const, enum: ['remote', 'terminal'] },
        default: 'remote',
        presentation: {
          control: 'select' as const,
          options: [{ value: 'unsupported', title: 'Unsupported' }],
        },
      }],
    };

    const result = PluginSettingsContributionV2Schema.safeParse(base);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([
        'presentation.sections.0.fields.0',
        'fields.0.presentation.options.0.value',
      ]),
    );
  });

  it('rejects duplicate fields and secret defaults at the canonical schema owner', () => {
    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'duplicates',
      title: 'Duplicates',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [
        { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } },
        { id: 'endpoint', title: 'Endpoint again', schema: { type: 'string' } },
      ],
    }).success).toBe(false);
    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'secrets',
      title: 'Secrets',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'api-token',
        title: 'API token',
        schema: { type: 'string' },
        secret: true,
        default: 'must-not-be-accepted',
      }],
    }).success).toBe(false);
  });

  it('declares bounded generic settings actions against fields in the same contribution', () => {
    const settings = PluginSettingsContributionV2Schema.parse({
      id: 'voice-provider',
      title: 'Voice provider',
      target: { kind: 'plugin' },
      scope: 'account',
      fields: [{
        id: 'agentId',
        title: 'Agent id',
        schema: { type: 'string', maxLength: 512 },
      }, {
        id: 'apiKey',
        title: 'API key',
        schema: { type: 'string' },
        secret: true,
      }],
      actions: [{
        id: 'create-agent',
        title: 'Create Agent',
        placement: { kind: 'afterField', fieldId: 'agentId' },
        confirmation: {
          kind: 'required',
          title: 'Create Agent',
          description: 'Create a remote provider Agent.',
          confirmLabel: 'Create',
        },
        patchFieldIds: ['agentId'],
      }],
    });

    expect(settings.actions[0]).toMatchObject({
      id: 'create-agent',
      patchFieldIds: ['agentId'],
    });
  });

  it('rejects cross-contribution, secret, duplicate, and over-bound settings-action declarations', () => {
    const base = {
      id: 'voice-provider',
      title: 'Voice provider',
      target: { kind: 'plugin' as const },
      scope: 'account' as const,
      fields: [{
        id: 'agentId',
        title: 'Agent id',
        schema: { type: 'string' as const, maxLength: 512 },
      }, {
        id: 'apiKey',
        title: 'API key',
        schema: { type: 'string' as const },
        secret: true as const,
      }],
    };
    const action = {
      id: 'create-agent',
      title: 'Create Agent',
      placement: { kind: 'afterField' as const, fieldId: 'missing' },
      confirmation: { kind: 'none' as const },
      patchFieldIds: ['apiKey', 'missing'],
    };

    expect(PluginSettingsContributionV2Schema.safeParse({
      ...base,
      actions: [action, action],
    }).success).toBe(false);
    expect(PluginSettingsContributionV2Schema.safeParse({
      ...base,
      actions: Array.from({ length: 9 }, (_, index) => ({
        ...action,
        id: `action-${index}`,
        placement: { kind: 'contributionFooter' as const },
        patchFieldIds: ['agentId'],
      })),
    }).success).toBe(false);
  });

  it('rejects action patches for an explicitly custodied secret field', () => {
    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'daemon-secret-action',
      title: 'Daemon secret action',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'password',
        title: 'Password',
        schema: { type: 'string' },
        secret: { custody: 'daemon' },
      }],
      actions: [{
        id: 'replace-password',
        title: 'Replace password',
        placement: { kind: 'afterField', fieldId: 'password' },
        confirmation: { kind: 'none' },
        patchFieldIds: ['password'],
      }],
    }).success).toBe(false);
  });
});
