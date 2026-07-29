import { describe, expect, it } from 'vitest';

import {
  PluginActionContributionV2Schema,
  PluginToolContributionV2Schema,
} from './v2.js';
import { PluginCommandContributionV2Schema } from '../contributions/v2.js';

const localized = { key: 'plugin.title', fallback: 'Title' };

describe('plugin executable contribution target grammar', () => {
  it('admits UI as an explicit action invocation surface', () => {
    expect(PluginActionContributionV2Schema.parse({
      id: 'open-preview',
      title: localized,
      scopes: ['session'],
      surfaces: ['ui'],
      placement: 'detailsPanel',
      dangerLevel: 'safe',
    }).surfaces).toEqual(['ui']);
  });

  it('accepts the exact action safety and confirmation contract', () => {
    expect(PluginActionContributionV2Schema.parse({
      id: 'write-summary',
      title: localized,
      scopes: ['session'],
      surfaces: ['cli', 'mcp'],
      placement: 'commandPalette',
      resultSchema: { type: 'object' },
      hostAccess: ['session-write'],
      dangerLevel: 'writesLocal',
      confirmation: {
        title: localized,
        body: 'This changes the local session.',
        confirmLabel: 'Write',
      },
    })).toMatchObject({ dangerLevel: 'writesLocal' });

    for (const forbidden of [
      { danger: 'safe' },
      { outputSchema: { type: 'object' } },
    ]) {
      expect(PluginActionContributionV2Schema.safeParse({
        id: 'read-summary',
        title: 'Read',
        scopes: ['session'],
        surfaces: ['cli'],
        placement: 'primary',
        dangerLevel: 'safe',
        ...forbidden,
      }).success).toBe(false);
    }

    expect(PluginActionContributionV2Schema.safeParse({
      id: 'missing-confirmation',
      title: 'Write',
      scopes: ['session'],
      surfaces: ['cli'],
      placement: 'primary',
      dangerLevel: 'writesRemote',
    }).success).toBe(false);
  });

  it('accepts structured tool authoring fields and rejects open legacy shapes', () => {
    expect(PluginToolContributionV2Schema.parse({
      id: 'summarize-tool',
      name: 'summarize',
      title: localized,
      action: { pluginId: 'com.acme.other', localId: 'summarize' },
      compatibility: { minimumVersion: 2, streaming: true },
      examples: { voice: { argsExample: '{"scope":"session"}' } },
      inputHints: {
        title: localized,
        fields: [{ path: 'scope', title: 'Scope', widget: 'select' }],
      },
    })).toMatchObject({ name: 'summarize' });

    expect(PluginToolContributionV2Schema.safeParse({
      id: 'ui-tool',
      name: 'ui_tool',
      title: 'UI tool',
      surfaces: ['ui'],
      action: 'run',
    }).success).toBe(false);

    expect(PluginToolContributionV2Schema.safeParse({
      id: 'bad-tool',
      name: 'bad',
      title: 'Bad',
      action: 'run',
      compatibility: ['v2'],
    }).success).toBe(false);
    expect(PluginToolContributionV2Schema.safeParse({
      id: 'bad-example',
      name: 'bad_example',
      title: 'Bad',
      action: 'run',
      examples: { voice: { argsExample: '{}', extra: true } },
    }).success).toBe(false);

    for (const nonObjectSchema of [
      { type: 'string' as const },
      { type: 'array' as const, items: { type: 'string' as const } },
    ]) {
      expect(PluginToolContributionV2Schema.safeParse({
        id: 'non-object-input',
        name: 'non_object_input',
        title: 'Non-object input',
        action: 'run',
        inputSchema: nonObjectSchema,
      }).success).toBe(false);
      expect(PluginToolContributionV2Schema.safeParse({
        id: 'non-object-output',
        name: 'non_object_output',
        title: 'Non-object output',
        action: 'run',
        outputSchema: nonObjectSchema,
      }).success).toBe(false);
    }
  });

  it('keeps commands strict and limited to public visibility values', () => {
    expect(PluginCommandContributionV2Schema.parse({
      id: 'summarize-command',
      title: localized,
      path: ['summarize'],
      action: 'summarize',
      visibility: 'advanced',
      arguments: { type: 'object' },
      availability: { when: { fact: 'host.feature', operator: 'enabled', value: 'summary' } },
    })).toMatchObject({ visibility: 'advanced' });

    for (const extra of [{ visibility: 'internal' }, { command: 'bad' }]) {
      expect(PluginCommandContributionV2Schema.safeParse({
        id: 'bad-command',
        title: 'Bad',
        path: ['bad'],
        action: 'bad',
        ...extra,
      }).success).toBe(false);
    }
  });
});
