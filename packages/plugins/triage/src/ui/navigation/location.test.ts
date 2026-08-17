import { describe, expect, it, vi } from 'vitest';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { TriageEntryRefV1Schema, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import {
  TRIAGE_ROUTE_DEFAULT_LENS_V1,
  buildTriageRouteSubPathV1,
  parseTriageRouteSubPathV1,
  readTriageRouteLensV1,
  writeTriageRouteLensV1,
  type TriageRouteLensV1,
} from './location.js';
import { TRIAGE_SURFACE_INITIAL_STATE_V1 } from '../state/surface.js';

function entryRef(input: Partial<Readonly<{
  pluginId: string;
  localId: string;
  kindId: string;
  collisionScope: string;
  entryId: string;
}>> = {}): TriageEntryRefV1 {
  return TriageEntryRefV1Schema.parse({
    source: {
      pluginId: input.pluginId ?? 'acme.scm',
      localId: input.localId ?? 'github',
    },
    kindId: input.kindId ?? 'pullRequest',
    collisionScope: input.collisionScope ?? 'acme/web',
    entryId: input.entryId ?? '42',
  });
}

function lens(overrides: Partial<TriageRouteLensV1> = {}): TriageRouteLensV1 {
  return { ...TRIAGE_ROUTE_DEFAULT_LENS_V1, ...overrides };
}

function hostApiWith(input: Readonly<{
  methods: readonly string[];
  replace?: PluginUiHostApi['replacePageLocation'];
}>): PluginUiHostApi {
  return {
    version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: input.methods as never }),
    replacePageLocation: input.replace ?? (async (subPath) => ({ subPath })),
  } as unknown as PluginUiHostApi;
}

describe('PRs & Issues route owner', () => {
  it('round-trips a complete lens through one canonical location', () => {
    const value = lens({
      grouping: 'scope',
      order: 'oldest',
      query: 'fix, please/now',
      selection: entryRef({ collisionScope: 'acme,web', entryId: 'a/b' }),
    });
    const subPath = buildTriageRouteSubPathV1(value);

    // Every component is percent-encoded, so a comma or slash inside an id can
    // never be read as a separator. A grammar that let them through would
    // resolve a copied link to a DIFFERENT entry than the one shared.
    expect(subPath).not.toContain('acme,web');
    expect(subPath).not.toContain('a/b');
    expect(parseTriageRouteSubPathV1(subPath)).toEqual(value);
  });

  it('keeps the default lens out of the location entirely', () => {
    expect(buildTriageRouteSubPathV1(TRIAGE_ROUTE_DEFAULT_LENS_V1)).toBe('');
    expect(parseTriageRouteSubPathV1('')).toEqual(TRIAGE_ROUTE_DEFAULT_LENS_V1);
    expect(parseTriageRouteSubPathV1(undefined)).toEqual(TRIAGE_ROUTE_DEFAULT_LENS_V1);
  });

  it('drops only the unreadable field and keeps every other valid one', () => {
    const parsed = parseTriageRouteSubPathV1([
      'g,scope',
      'o,sideways',
      'q,keep%20me',
      'e,acme.scm',
      'unknown,thing',
    ].join('/'));

    expect(parsed.grouping).toBe('scope');
    // An unknown order and a truncated selection are dropped…
    expect(parsed.order).toBe('newest');
    expect(parsed.selection).toBeNull();
    // …and the query the user typed survives both.
    expect(parsed.query).toBe('keep me');
  });

  it('reads the settled query and the selected entry from the one reducer state', () => {
    expect(readTriageRouteLensV1(TRIAGE_SURFACE_INITIAL_STATE_V1)).toEqual(TRIAGE_ROUTE_DEFAULT_LENS_V1);

    const ref = entryRef();
    expect(readTriageRouteLensV1({
      ...TRIAGE_SURFACE_INITIAL_STATE_V1,
      selection: { sectionId: 'needs-you', entryRef: ref, sourceInstanceId: 'instance-1' as never },
      // An in-flight composition is not the settled query and must not reach
      // the shareable location.
      search: { query: 'settled', composing: 'settl' },
    }).query).toBe('settled');
  });

  it('declares the selection-free lens as the page-internal Back step', async () => {
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (subPath) => ({ subPath }));
    const withSelection = lens({ query: 'bug', selection: entryRef() });

    await expect(writeTriageRouteLensV1(
      hostApiWith({ methods: ['replacePageLocation'], replace }),
      withSelection,
    )).resolves.toEqual({
      kind: 'settled',
      subPath: buildTriageRouteSubPathV1(withSelection),
    });

    const [, options] = replace.mock.calls[0]!;
    // Back clears the selection and keeps the query — it is not an undo stack
    // over the user's filters.
    expect(options?.backLocation).toBe(buildTriageRouteSubPathV1(lens({ query: 'bug' })));
  });

  it('declares no Back step for a lens with no selection', async () => {
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (subPath) => ({ subPath }));
    await writeTriageRouteLensV1(
      hostApiWith({ methods: ['replacePageLocation'], replace }),
      lens({ query: 'bug' }),
    );
    const [, options] = replace.mock.calls[0]!;
    expect(options?.backLocation).toBeUndefined();
  });

  it('renders the location the host settled on, not the one it asked for', async () => {
    await expect(writeTriageRouteLensV1(
      hostApiWith({
        methods: ['replacePageLocation'],
        replace: async () => ({ subPath: 'g,kind' }),
      }),
      lens({ grouping: 'scope' }),
    )).resolves.toEqual({ kind: 'settled', subPath: 'g,kind' });
  });

  it('refuses rather than inventing a local route when the host cannot replace', async () => {
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>();
    await expect(writeTriageRouteLensV1(
      hostApiWith({ methods: ['openSurface'], replace }),
      lens({ grouping: 'scope' }),
    )).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(replace).not.toHaveBeenCalled();

    await expect(writeTriageRouteLensV1(
      hostApiWith({
        methods: ['replacePageLocation'],
        replace: async () => { throw new Error('host refused'); },
      }),
      lens({ grouping: 'scope' }),
    )).resolves.toEqual({ kind: 'refused', reason: 'rejected' });
  });
});
