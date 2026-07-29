import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from './v2.js';
import { PluginSettingsContributionV2Schema } from './settings.js';

describe('canonical settings contributions', () => {
  it('uses one strict settings family for plugin and Agent targets', () => {
    const pluginSettings = PluginSettingsContributionV2Schema.parse({
      id: 'general',
      title: 'General',
      target: { kind: 'plugin' },
      scope: 'local',
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
      scope: 'local',
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
    expect(agentSettings.target).toEqual({ kind: 'agent', agent: 'reviewer' });
    expect(PluginContributesV2Schema.safeParse({
      agentSettings: [{ id: 'retired', agentId: 'reviewer', fields: [] }],
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
      scope: 'synced',
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
    expect(settings.scope).toBe('synced');
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
      scope: 'synced' as const,
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
      scope: 'local',
      fields: [
        { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } },
        { id: 'endpoint', title: 'Endpoint again', schema: { type: 'string' } },
      ],
    }).success).toBe(false);
    expect(PluginSettingsContributionV2Schema.safeParse({
      id: 'secrets',
      title: 'Secrets',
      target: { kind: 'plugin' },
      scope: 'local',
      fields: [{
        id: 'api-token',
        title: 'API token',
        schema: { type: 'string' },
        secret: true,
        default: 'must-not-be-accepted',
      }],
    }).success).toBe(false);
  });
});
