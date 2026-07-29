import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';
import {
  CANONICAL_RUNTIME_MODE_HOST,
  PLUGIN_SURFACE_REGISTRY,
  PluginSurfaceTypeIdV1Schema,
  createPluginSurfaceRegistry,
  defaultHostApiMethodsForCategory,
  deriveDefaultRuntimeModesForCategory,
  resolveSupportedRuntimeModes,
  selectFirstAvailableRuntimeMode,
} from './surfaceRegistry.js';
import { PluginSurfacePlacementKindV1Schema } from './surfacePlacements.js';

const display = {
  titleKey: 'title',
  descriptionKey: 'description',
  iconToken: 'browser',
  tone: 'info',
} as const;

describe('surface registry — category-derived default modes', () => {
  it('derives panel default = all render modes', () => {
    expect(deriveDefaultRuntimeModesForCategory('panel')).toEqual([
      'host',
      'hostedWeb',
      'reactNative',
    ]);
  });

  it('derives action default = declarative/action only', () => {
    expect(deriveDefaultRuntimeModesForCategory('action')).toEqual(['declarative', 'action']);
  });

  it('derives message default = structured only', () => {
    expect(deriveDefaultRuntimeModesForCategory('message')).toEqual(['structured']);
  });

  it('derives container default = host/declarative', () => {
    expect(deriveDefaultRuntimeModesForCategory('container')).toEqual(['host', 'declarative']);
  });

  it('keeps host-api method allowlists category-scoped (panel grants all)', () => {
    expect(defaultHostApiMethodsForCategory('panel')).toContain('subscribeResource');
    expect(defaultHostApiMethodsForCategory('action')).not.toContain('subscribeResource');
  });
});

describe('surface registry — exclusion deny-list', () => {
  it('subtracts exclusions from the category default, order-preserving', () => {
    expect(resolveSupportedRuntimeModes('panel', ['reactNative'])).toEqual([
      'host',
      'hostedWeb',
    ]);
  });

  it('adding a mode to a uniform same-category surface needs zero exclusion entries', () => {
    expect(resolveSupportedRuntimeModes('panel', [])).toEqual(
      deriveDefaultRuntimeModesForCategory('panel'),
    );
  });

  it('the deny-list never adds: result stays a subset of the category default', () => {
    // 'structured' is not a panel default mode; excluding it is a no-op, never an add.
    expect(resolveSupportedRuntimeModes('panel', ['structured'])).toEqual(
      deriveDefaultRuntimeModesForCategory('panel'),
    );
  });
});

describe('surface registry — mode selection (first available)', () => {
  const details = PLUGIN_SURFACE_REGISTRY.get('session.details');

  it('registers the descriptor under its surface type id', () => {
    expect(details).toBeDefined();
  });

  it('picks the first supported mode that is provided', () => {
    // supportedRuntimeModes order = host, hostedWeb, reactNative
    const mode = selectFirstAvailableRuntimeMode(details!, {
      providedModes: ['reactNative', 'hostedWeb'],
    });
    expect(mode).toBe('hostedWeb');
  });

  it('skips runtime-unavailable modes', () => {
    const mode = selectFirstAvailableRuntimeMode(details!, {
      providedModes: ['hostedWeb', 'reactNative'],
      isRuntimeAvailable: (candidate) => candidate !== 'hostedWeb',
    });
    expect(mode).toBe('reactNative');
  });

  it('respects the trust/compat predicate', () => {
    const mode = selectFirstAvailableRuntimeMode(details!, {
      providedModes: ['hostedWeb', 'host'],
      isTrustCompatible: (candidate) => candidate === 'host',
    });
    expect(mode).toBe('host');
  });

  it('returns null when no provided mode is supported', () => {
    expect(
      selectFirstAvailableRuntimeMode(details!, { providedModes: ['structured'] }),
    ).toBeNull();
  });

});

describe('surface registry — reject-at-projection', () => {
  const validHeaderAction = {
    id: 'open-preview',
    title: 'Open preview',
    action: 'open-preview',
  } as const;

  it('projects a contribution that matches the descriptor contributionSchema', () => {
    const result = PLUGIN_SURFACE_REGISTRY.projectContribution('session.headerAction', validHeaderAction);
    expect(result.status).toBe('projected');
  });

  it('rejects a contribution that fails the descriptor contributionSchema', () => {
    const result = PLUGIN_SURFACE_REGISTRY.projectContribution('session.headerAction', { id: 'bad' });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('schema_mismatch');
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown surface id', () => {
    const result = PLUGIN_SURFACE_REGISTRY.projectContribution('does.not.exist', {});
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('unknown_surface');
    }
  });

  it('rejects provided modes that exceed supportedRuntimeModes', () => {
    const result = PLUGIN_SURFACE_REGISTRY.projectContribution('session.headerAction', validHeaderAction, {
      providedModes: ['hostedWeb'],
    });
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('mode_unsupported');
    }
  });

  it('accepts provided modes that are within supportedRuntimeModes', () => {
    const result = PLUGIN_SURFACE_REGISTRY.projectContribution('session.headerAction', validHeaderAction, {
      providedModes: ['action'],
    });
    expect(result.status).toBe('projected');
  });
});

describe('surface registry — id uniqueness (§13.5.6)', () => {
  it('rejects duplicate surface ids at construction', () => {
    const descriptor = PLUGIN_SURFACE_REGISTRY.get('browser.panel');
    expect(descriptor).toBeDefined();
    expect(() => createPluginSurfaceRegistry([descriptor!, descriptor!])).toThrow(/duplicate/i);
  });
});

describe('surface registry — canonical manifest graph', () => {
  it('does not restore the removed top-level surfacePlacements family', () => {
    const parsed = PluginContributesV2Schema.safeParse({
      surfacePlacements: [
        {
          id: 'settings-panel',
          placement: 'app.settingsPage',
          target: { kind: 'app' },
          renderer: { kind: 'host', rendererId: 'descriptorPanel' },
          display,
        },
        {
          id: 'preview-pane',
          placement: 'session.preview',
          target: { kind: 'session', sessionIdPath: '/session/id' },
          renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
          display,
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('registry covers every legacy placement kind plus the merged session.headerAction', () => {
    for (const placement of PluginSurfacePlacementKindV1Schema.options) {
      expect(PLUGIN_SURFACE_REGISTRY.has(placement)).toBe(true);
    }
    expect(PLUGIN_SURFACE_REGISTRY.has('session.headerAction')).toBe(true);
    expect(PLUGIN_SURFACE_REGISTRY.has('session.structuredMessage')).toBe(true);
  });

  it('registry surface ids equal the declared surface-type enum', () => {
    expect([...PLUGIN_SURFACE_REGISTRY.ids()].sort()).toEqual(
      [...PluginSurfaceTypeIdV1Schema.options].sort(),
    );
  });

  it('canonical mode->host map covers every runtime mode exactly once', () => {
    expect(Object.keys(CANONICAL_RUNTIME_MODE_HOST).sort()).toEqual(
      ['action', 'declarative', 'host', 'hostedWeb', 'reactNative', 'structured'].sort(),
    );
  });
});
