import { describe, expect, it } from 'vitest';

import { searchSerializedActionSpecsForSurface } from './actionCatalog.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import {
  isActionDirectToolExposedOn,
  isActionDiscoverableOnToolSurface,
  resolveActionToolExposureMode,
} from './actionToolExposure.js';

describe('actionToolExposure', () => {
  it('defaults first-party session-agent action-backed tools to discoverable-only unless allow-listed', () => {
    for (const id of ['review.start', 'subagents.delegate.start', 'execution.run.start', 'session.status.get'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'session_agent')).toBe('discoverable_only');
      expect(isActionDirectToolExposedOn(spec, 'session_agent')).toBe(false);
      expect(isActionDiscoverableOnToolSurface(spec, 'session_agent')).toBe(true);
    }
  });

  it('keeps session-agent action discovery bootstrap specs directly exposed', () => {
    for (const id of ['action.spec.search', 'action.spec.get', 'action.options.resolve'] as const) {
      const spec = getActionSpec(id);

      expect(resolveActionToolExposureMode(spec, 'session_agent')).toBe('direct');
      expect(isActionDirectToolExposedOn(spec, 'session_agent')).toBe(true);
      expect(isActionDiscoverableOnToolSurface(spec, 'session_agent')).toBe(true);
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
            session_agent: 'direct',
            mcp: 'discoverable_only',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(resolveActionToolExposureMode(spec, 'session_agent', { settings })).toBe('direct');
    expect(isActionDirectToolExposedOn(spec, 'session_agent', { settings })).toBe(true);
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
          disabledSurfaces: ['session_agent'],
          toolExposureModes: {
            session_agent: 'direct',
          },
        },
      },
    });
    const spec = getActionSpec('subagents.delegate.start');

    expect(isActionDirectToolExposedOn(spec, 'session_agent', { settings })).toBe(false);
    expect(isActionDiscoverableOnToolSurface(spec, 'session_agent', { settings })).toBe(false);
  });

  it('keeps discoverable-only session-agent actions in action search results', () => {
    const results = searchSerializedActionSpecsForSurface({
      surface: 'session_agent',
      query: 'delegate',
      limit: 10,
    });

    expect(results.map((spec) => spec.id)).toContain('subagents.delegate.start');
  });
});
