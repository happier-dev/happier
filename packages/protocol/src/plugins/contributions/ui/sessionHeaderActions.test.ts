import { describe, expect, it } from 'vitest';

import {
  normalizePluginUiSemanticCommandV1,
  PluginUiResolvedSemanticCommandV1Schema,
} from '../../ui/hostApiRequests.js';
import {
  normalizePluginSessionHeaderActionDescriptorV1,
  PluginSessionHeaderActionDescriptorV1Schema,
} from './sessionHeaderActions.js';

describe('PluginSessionHeaderActionDescriptorV1Schema', () => {
  it('accepts only the two semantic command targets and normalizes their same-plugin identities once', () => {
    const execute = PluginSessionHeaderActionDescriptorV1Schema.parse({
      id: 'refresh',
      title: 'Refresh',
      command: {
        kind: 'executeAction',
        action: 'refresh-session',
        input: { force: true },
      },
    });
    const open = PluginSessionHeaderActionDescriptorV1Schema.parse({
      id: 'details',
      title: 'Details',
      command: {
        kind: 'openSurface',
        destination: 'session-details',
        subPath: '/recent',
        instanceKey: 'current-session',
      },
    });

    expect(normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: execute.command,
    })).toEqual({
      kind: 'executeAction',
      action: { pluginId: 'acme.navigation', localId: 'refresh-session' },
      input: { force: true },
    });
    expect(normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: open.command,
    })).toEqual({
      kind: 'openSurface',
      destination: { pluginId: 'acme.navigation', localId: 'session-details' },
      subPath: 'recent',
      instanceKey: 'current-session',
    });
  });

  it('keeps general semantic commands qualified while rejecting cross-plugin Session-header opens', () => {
    expect(PluginSessionHeaderActionDescriptorV1Schema.safeParse({
      id: 'legacy',
      title: 'Legacy',
      action: 'run',
    }).success).toBe(false);
    expect(PluginSessionHeaderActionDescriptorV1Schema.safeParse({
      id: 'metadata',
      title: 'Metadata',
      command: { kind: 'executeAction', action: 'run' },
      metadata: { arbitrary: true },
    }).success).toBe(false);
    const crossPlugin = PluginSessionHeaderActionDescriptorV1Schema.parse({
      id: 'cross-plugin',
      title: 'Cross plugin',
      command: {
        kind: 'openSurface',
        destination: { pluginId: 'other.plugin', localId: 'settings' },
      },
    });
    expect(normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: crossPlugin.command,
    })).toEqual({
      kind: 'openSurface',
      destination: { pluginId: 'other.plugin', localId: 'settings' },
    });
    expect(normalizePluginSessionHeaderActionDescriptorV1({
      pluginId: 'acme.navigation',
      descriptor: crossPlugin,
    })).toBeNull();
    expect(PluginSessionHeaderActionDescriptorV1Schema.safeParse({
      id: 'cross-plugin-action',
      title: 'Cross plugin Action',
      command: {
        kind: 'executeAction',
        action: { pluginId: 'other.plugin', localId: 'mutate' },
      },
    }).success).toBe(false);
  });

  it('publishes a strict resolved-command boundary for compiled consumers', () => {
    const command = normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: {
        kind: 'openSurface',
        destination: 'session-details',
        input: { selected: true },
      },
    });

    expect(PluginUiResolvedSemanticCommandV1Schema.parse(command)).toEqual({
      kind: 'openSurface',
      destination: { pluginId: 'acme.navigation', localId: 'session-details' },
      input: { selected: true },
    });
    expect(PluginUiResolvedSemanticCommandV1Schema.safeParse({
      kind: 'executeAction',
      action: 'refresh-session',
    }).success).toBe(false);
  });

  it('snapshots launch input without aliasing while preserving omitted and explicit null', () => {
    const authoredInput = { nested: ['before'] };
    const withInput = normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: {
        kind: 'openSurface',
        destination: 'session-details',
        input: authoredInput,
      },
    });
    const omitted = normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: {
        kind: 'openSurface',
        destination: 'session-details',
      },
    });
    const explicitNull = normalizePluginUiSemanticCommandV1({
      pluginId: 'acme.navigation',
      command: {
        kind: 'openSurface',
        destination: 'session-details',
        input: null,
      },
    });

    expect(withInput).not.toBeNull();
    if (withInput === null || withInput.kind !== 'openSurface') return;
    expect(withInput.input).not.toBe(authoredInput);
    expect(Object.isFrozen(withInput.input)).toBe(true);
    expect(Object.isFrozen((withInput.input as { nested: readonly string[] }).nested)).toBe(true);
    authoredInput.nested[0] = 'after';
    expect(withInput.input).toEqual({ nested: ['before'] });
    expect(omitted).not.toHaveProperty('input');
    expect(explicitNull).toHaveProperty('input', null);
  });
});
