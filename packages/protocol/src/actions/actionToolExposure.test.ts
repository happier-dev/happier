import { describe, expect, it } from 'vitest';

import { searchSerializedActionSpecsForSurface } from './actionCatalog.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import {
  ACTION_SURFACE_POLICIES,
  getActionSurfacePolicy,
  listActionSurfacePolicies,
  resolveActionSurfaceAvailability,
} from './actionSurfaceAvailability.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('actionToolExposure', () => {
  it('defaults first-party agent action-backed tools to discoverable-only unless allow-listed', () => {
    for (const id of ['review.start', 'subagents.delegate.start', 'execution.run.start', 'session.status.get'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'agent')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    }
  });

  it('keeps agent action discovery and reload specs directly exposed', () => {
    for (const id of ['action.spec.search', 'action.spec.get', 'action.options.resolve', 'plugins.reload'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'agent')).toBe('direct');
      expect(isActionDirectToolExposedOn(spec, 'agent')).toBe(true);
      expect(isActionDiscoverableOnToolSurface(spec, 'agent')).toBe(true);
    }
  });

  it('keeps external mcp and cli direct by default', () => {
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'mcp')).toBe('direct');
    expect(resolveActionToolExposureMode(spec, 'cli')).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'mcp')).toBe(true);
    expect(isActionDirectToolExposedOn(spec, 'cli')).toBe(true);
  });

  it('applies sparse per-surface settings overrides', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          toolExposureModes: {
            agent: 'direct',
            mcp: 'discoverable_only',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'agent', { settings })).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'agent', { settings })).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'mcp', { settings })).toBe('discoverable_only');
    expect(isActionDirectToolExposedOn(spec, 'mcp', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'mcp', { settings })).toBe(true);
    expect(resolveActionToolExposureMode(spec, 'cli', { settings })).toBe('direct');
  });

  it('keeps disabled actions neither direct nor discoverable', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'subagents.delegate.start': {
          disabledSurfaces: ['agent'],
          toolExposureModes: {
            agent: 'direct',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(isActionDirectToolExposedOn(spec, 'agent', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'agent', { settings })).toBe(false);
  });

  it('returns structured first-party availability reasons for settings, surface, and policy denials', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.title.set': {
          disabledSurfaces: ['agent'],
        },
      },
    });

    expect(resolveActionSurfaceAvailability({
      actionId: 'session.spawn_new',
      surface: 'agent',
    })).toEqual(expect.objectContaining({
      available: true,
      reason: 'available',
      actionId: 'session.spawn_new',
      surface: 'agent',
      defaultToolExposureMode: 'discoverable_only',
      effectiveToolExposureMode: 'discoverable_only',
    }));
    expect(resolveActionSurfaceAvailability({
      actionId: 'session.title.set',
      surface: 'agent',
      settings,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'disabled_by_settings',
      settingsState: 'disabled',
    }));
    expect(resolveActionSurfaceAvailability({
      actionId: 'session.title.set',
      surface: 'agent',
      isActionEnabled: () => false,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'disabled_by_policy',
    }));
  });

  it('keeps direct tool binding checks separate from discoverable availability', () => {
    expect(resolveActionSurfaceAvailability({
      actionId: 'execution.run.ensure',
      surface: 'agent',
      requireToolBinding: true,
    })).toEqual(expect.objectContaining({
      available: false,
      reason: 'missing_tool_binding',
    }));
  });

  it('explicitly classifies every action surface for settings configurability', () => {
    expect(listActionSurfacePolicies().map((policy) => policy.surface)).toEqual([
      'ui',
      'voice',
      'agent',
      'mcp',
      'cli',
      'rpc',
      'sdk',
      'plugin',
    ]);
    expect(getActionSurfacePolicy('rpc')).toEqual(expect.objectContaining({
      settingsConfigurable: false,
      classification: 'internal',
    }));
    expect(getActionSurfacePolicy('sdk')).toEqual(expect.objectContaining({
      settingsConfigurable: false,
      classification: 'internal',
    }));
    expect(getActionSurfacePolicy('plugin')).toEqual(expect.objectContaining({
      settingsConfigurable: false,
      classification: 'internal',
    }));
    expect(ACTION_SURFACE_POLICIES.every((policy) => typeof policy.settingsConfigurable === 'boolean')).toBe(true);
  });

  it('keeps discoverable-only agent actions in action search results', () => {
    const results = searchSerializedActionSpecsForSurface({
      surface: 'agent',
      query: 'delegate',
      limit: 10,
    });

    expect(results.map((spec) => spec.id)).toContain('subagents.delegate.start');
  });
});
