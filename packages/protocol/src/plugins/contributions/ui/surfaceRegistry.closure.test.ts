import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CANONICAL_RUNTIME_MODE_HOST,
  KNOWN_HOST_RENDERER_IDS,
  LIVE_SURFACE_RUNTIME_HOSTS,
  PLUGIN_SURFACE_REGISTRY,
  PluginSurfaceRuntimeModeV1Schema,
  deriveDefaultRuntimeModesForCategory,
} from './surfaceRegistry.js';
import { PluginSurfacePlacementKindV1Schema } from './surfacePlacements.js';

/**
 * Build-failing closure test (mirrors the `noInternalCodesInPrimaryUi` style):
 * the coverage / engine-x-capability matrices are PROPERTIES OF THE REGISTRY,
 * enforced here rather than in a drifting doc table (§14.3 / §16).
 *
 * No surface knowledge may live outside the registry (§10 invariant): every
 * supported mode binds to a live host, renderer ids come from the single known
 * universe, and the anchor replaces the placement->target coupling.
 */
describe('surface registry — closure invariants', () => {
  const descriptors = PLUGIN_SURFACE_REGISTRY.list();

  it('registers at least the known real surface types (not a toy)', () => {
    expect(descriptors.length).toBeGreaterThanOrEqual(18);
  });

  it('every supportedRuntimeMode has a live host binding in rendererSet', () => {
    for (const descriptor of descriptors) {
      for (const mode of descriptor.supportedRuntimeModes) {
        const binding = descriptor.rendererSet[mode];
        expect(binding, `${descriptor.id} is missing a renderer binding for mode '${mode}'`).toBeDefined();
        expect(LIVE_SURFACE_RUNTIME_HOSTS).toContain(binding!.host);
        expect(binding!.host).toBe(CANONICAL_RUNTIME_MODE_HOST[mode]);
      }
    }
  });

  it('rendererSet carries no bindings outside supportedRuntimeModes', () => {
    for (const descriptor of descriptors) {
      const supported = new Set<string>(descriptor.supportedRuntimeModes);
      for (const mode of Object.keys(descriptor.rendererSet)) {
        expect(supported.has(mode), `${descriptor.id} has a stray renderer binding for '${mode}'`).toBe(true);
      }
    }
  });

  it('native-host modes reference only known renderer ids; web/RN modes declare none', () => {
    for (const descriptor of descriptors) {
      for (const mode of descriptor.supportedRuntimeModes) {
        const binding = descriptor.rendererSet[mode]!;
        if (binding.host === 'nativeBlueprintHost') {
          expect(binding.rendererIds, `${descriptor.id}.${mode} must declare renderer ids`).toBeDefined();
          expect(binding.rendererIds!.length).toBeGreaterThan(0);
          for (const rendererId of binding.rendererIds!) {
            expect(
              KNOWN_HOST_RENDERER_IDS.has(rendererId),
              `${descriptor.id}.${mode} references unknown renderer id '${rendererId}'`,
            ).toBe(true);
          }
        } else {
          expect(binding.rendererIds, `${descriptor.id}.${mode} must not declare renderer ids`).toBeUndefined();
        }
      }
    }
  });

  it('supportedRuntimeModes is always a subset of the category default (deny-list never adds)', () => {
    for (const descriptor of descriptors) {
      const categoryDefault = new Set<string>(deriveDefaultRuntimeModesForCategory(descriptor.category));
      for (const mode of descriptor.supportedRuntimeModes) {
        expect(categoryDefault.has(mode), `${descriptor.id} added '${mode}' outside its category default`).toBe(true);
      }
    }
  });

  it('anchor.content equals scope (replaces the placement->target superRefine coupling)', () => {
    for (const descriptor of descriptors) {
      expect(descriptor.anchor.content, `${descriptor.id} anchor.content must equal scope`).toBe(
        descriptor.scope,
      );
    }
  });

  it('whenGating is fail-closed and references a real contribution schema', () => {
    for (const descriptor of descriptors) {
      expect(descriptor.whenGating.failClosed).toBe(true);
      expect(descriptor.contributionSchema).toBeInstanceOf(z.ZodType);
      expect(descriptor.hostApiShape.methods.length).toBeGreaterThan(0);
    }
  });
});

/**
 * REG-6 — every OTHER surface-knowledge encoding must be DERIVED FROM the registry
 * (or fail the build). Before this, only the registry's self-consistency was
 * asserted; the placement-kind enum, the renderer-kind→mode vocabulary, and the
 * mounted-placement gate were independent hand-lists that could drift. These
 * assertions bind each parallel encoding to `PLUGIN_SURFACE_REGISTRY` so adding /
 * removing a surface is a single registry edit.
 */
describe('surface registry — derived-encoding closure (REG-6)', () => {
  const descriptors = PLUGIN_SURFACE_REGISTRY.list();
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..');

  // The two non-placement surface categories the registry owns but that are NOT
  // schema-bounded surface PLACEMENTS (they are projected by their own families:
  // session header actions + structured messages).
  const NON_PLACEMENT_CATEGORIES = new Set<string>(['action', 'message']);

  it('every PluginSurfacePlacementKindV1 value resolves to a registered surface descriptor', () => {
    for (const placement of PluginSurfacePlacementKindV1Schema.options) {
      expect(
        PLUGIN_SURFACE_REGISTRY.has(placement),
        `placement kind '${placement}' has no registry descriptor`,
      ).toBe(true);
    }
  });

  it('the placement-kind enum is EXACTLY the registry ids whose category is a mountable placement', () => {
    // Derive the placement-kind set from the registry: every descriptor that is
    // not an action/message surface IS a mountable placement kind.
    const derivedPlacementIds = descriptors
      .filter((descriptor) => !NON_PLACEMENT_CATEGORIES.has(descriptor.category))
      .map((descriptor) => descriptor.id)
      .sort();
    const enumIds = [...PluginSurfacePlacementKindV1Schema.options].sort();
    expect(enumIds).toEqual(derivedPlacementIds);
  });

  it('the action/message surface ids are NOT placement kinds (projected by their own families)', () => {
    const placementIds = new Set<string>(PluginSurfacePlacementKindV1Schema.options);
    for (const descriptor of descriptors) {
      if (NON_PLACEMENT_CATEGORIES.has(descriptor.category)) {
        expect(
          placementIds.has(descriptor.id),
          `non-placement surface '${descriptor.id}' must not be a placement kind`,
        ).toBe(false);
      }
    }
  });

  it('every renderer-kind→mode the projection/host map to is a registry runtime mode bound to a live host', () => {
    // The render-mode vocabulary the cli projection (`resolveRendererProvidedMode`)
    // and the UI host (`rendererKindToRuntimeMode`) emit per declared renderer kind.
    // Each MUST be a registry runtime mode with a canonical live-host binding, so the
    // mount switch never reasons about a mode the registry does not recognize.
    const RENDERER_KIND_MODES = ['host', 'hostedWeb', 'reactNative'] as const;
    for (const mode of RENDERER_KIND_MODES) {
      expect(
        PluginSurfaceRuntimeModeV1Schema.options.includes(mode),
        `renderer mode '${mode}' is not a registry runtime mode`,
      ).toBe(true);
      expect(CANONICAL_RUNTIME_MODE_HOST[mode]).toBeDefined();
      expect(LIVE_SURFACE_RUNTIME_HOSTS).toContain(CANONICAL_RUNTIME_MODE_HOST[mode]);
    }
  });

  it('every supportedRuntimeMode across the registry binds to a live host (no orphan mode)', () => {
    const seenModes = new Set<string>();
    for (const descriptor of descriptors) {
      for (const mode of descriptor.supportedRuntimeModes) {
        seenModes.add(mode);
      }
    }
    for (const mode of seenModes) {
      expect(
        LIVE_SURFACE_RUNTIME_HOSTS,
        `supported mode '${mode}' has no live host`,
      ).toContain(CANONICAL_RUNTIME_MODE_HOST[mode as keyof typeof CANONICAL_RUNTIME_MODE_HOST]);
    }
  });

  it('keeps runtime surface context placement classifiers out of UI renderers', () => {
    const runtimeSurfaceFiles = [
      'apps/ui/sources/components/plugins/surfaces/PluginSurfaceHost.tsx',
    ];
    const prefixClassifierPattern = /\b(?:surfaceId|placement)\s*\.\s*(?:startsWith|endsWith)\s*\(\s*['"`](?:session|workspace|project|app|browser|services)\./u;

    for (const relativePath of runtimeSurfaceFiles) {
      const source = readFileSync(resolve(repoRoot, relativePath), 'utf8');
      expect(
        source,
        `${relativePath} must use resolvePluginUiSurfaceContextPlacement from the Surface Registry owner instead of declaring a local placement resolver.`,
      ).not.toMatch(/\bfunction\s+resolveSurfaceContextPlacement\b/u);
      expect(
        source,
        `${relativePath} must not derive runtime surface placement from string prefixes.`,
      ).not.toMatch(prefixClassifierPattern);
    }
  });
});
