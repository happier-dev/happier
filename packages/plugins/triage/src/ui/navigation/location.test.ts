import { describe, expect, it, vi } from 'vitest';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { TriageEntryRefV1Schema, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 } from '@happier-dev/plugin-sdk/ui';

import {
  TRIAGE_ROUTE_DEFAULT_LENS_V1,
  buildTriageRouteSubPathV1,
  parseTriageRouteSubPathV1,
  preflightTriageRouteLensV1,
  readTriageRouteLensV1,
  createTriageRouteWriteQueueV1,
  writeTriageRouteLensV1,
  type TriageRouteLensV1,
} from './location.js';
import { TRIAGE_SURFACE_INITIAL_STATE_V1 } from '../state/surface.js';
import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../../corpus/query/smartPolicy.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';

const SOURCE = { pluginId: 'acme.scm', localId: 'github' } as const;

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

function routeBytes(value: TriageRouteLensV1): number {
  return new TextEncoder().encode(buildTriageRouteSubPathV1(value)).byteLength;
}

/**
 * A lens whose complete route is exactly `bytes` long.
 *
 * The query carries the padding because it is the one lens field with no
 * schema bound of its own — which is also why it is the field a real reader
 * can push over the limit by typing.
 */
function lensOfRouteBytes(bytes: number): TriageRouteLensV1 {
  const overhead = routeBytes(lens({ query: 'x' })) - 1;
  return lens({ query: 'x'.repeat(bytes - overhead) });
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
  it('serializes host replacement and keeps only the newest queued intent', async () => {
    let settleFirst!: (value: { subPath: string }) => void;
    const first = new Promise<{ subPath: string }>((resolve) => { settleFirst = resolve; });
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (subPath) => {
      if (subPath === 'q,first') return await first;
      return { subPath };
    });
    const queue = createTriageRouteWriteQueueV1(
      hostApiWith({ methods: ['replacePageLocation'], replace }),
    );

    queue.write(lens({ query: 'first' }));
    queue.write(lens({ query: 'second' }));
    queue.write(lens({ query: 'newest' }));
    await Promise.resolve();
    expect(replace.mock.calls.map(([subPath]) => subPath)).toEqual(['q,first']);

    settleFirst({ subPath: 'q,first' });
    await queue.whenSettled();
    expect(replace.mock.calls.map(([subPath]) => subPath)).toEqual(['q,first', 'q,newest']);
    queue.dispose();
  });

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

  it('accepts a route at the host bound and refuses one byte over it', () => {
    // `core/SURFACE.md` §3.2: every edit preflights the COMPLETE resulting
    // route. A value at the limit is accepted; one above it is refused. The
    // bound comes from the incumbent host owner rather than a Triage copy of
    // the number, so this cannot pass against a bound that has drifted.
    const atLimit = lensOfRouteBytes(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
    const overLimit = lensOfRouteBytes(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 + 1);

    expect(routeBytes(atLimit)).toBe(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
    expect(preflightTriageRouteLensV1(atLimit))
      .toEqual({ kind: 'accepted', subPath: buildTriageRouteSubPathV1(atLimit) });
    expect(preflightTriageRouteLensV1(overLimit)).toEqual({ kind: 'refused' });
  });

  it('never asks the host for a route the bound already refuses', async () => {
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (subPath) => ({ subPath }));

    await expect(writeTriageRouteLensV1(
      hostApiWith({ methods: ['replacePageLocation'], replace }),
      lensOfRouteBytes(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 + 1),
    )).resolves.toEqual({ kind: 'refused', reason: 'tooLong' });

    // Not `rejected`. Letting the transport throw and catching it collapses
    // "this route cannot exist" into "the host said no", and the caller can no
    // longer tell a refusal it must show the reader from a host that is simply
    // unavailable.
    expect(replace).not.toHaveBeenCalled();
  });

  it('carries the complete effective filter selection and Smart precedence', () => {
    const value = lens({
      order: 'smart',
      smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
      filters: {
        sources: [{ source: SOURCE }],
        types: [
          { source: SOURCE, kindId: 'pullRequest' },
          { source: SOURCE, kindId: 'issue' },
        ],
        // A scope carrying both separators at once: the componentwise encoding
        // is the only reason a copied link still names this one scope.
        scopes: [{ source: SOURCE, collisionScope: 'acme,web/main' }],
        states: ['open', 'unresolved'],
        attention: ['required'],
      },
    });
    const subPath = buildTriageRouteSubPathV1(value);

    expect(subPath).not.toContain('acme,web/main');
    expect(parseTriageRouteSubPathV1(subPath)).toEqual(value);
  });

  it('keeps an unfiltered default-policy lens byte-identical to the location it had before', () => {
    expect(buildTriageRouteSubPathV1(lens({ query: 'bug' }))).toBe('q,bug');
    expect(buildTriageRouteSubPathV1(lens({ order: 'smart' }))).toBe('o,smart');
    // The default policy is the retained one, so naming it would put a value in
    // every reader's URL that says nothing.
    expect(buildTriageRouteSubPathV1(lens({
      smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
    }))).toBe('');
  });

  it('drops only the invalid facet value and never another still-valid one', () => {
    const parsed = parseTriageRouteSubPathV1([
      'fst,open,sideways,unresolved',
      'fa,required,loud',
      // A type value missing its kind, beside a complete one.
      `ft,${encodeURIComponent(SOURCE.pluginId)},${encodeURIComponent(SOURCE.localId)}`,
      `ft,${encodeURIComponent(SOURCE.pluginId)},${encodeURIComponent(SOURCE.localId)},issue`,
      'sp,sideways',
      'q,keep%20me',
    ].join('/'));

    expect(parsed.filters.states).toEqual(['open', 'unresolved']);
    expect(parsed.filters.attention).toEqual(['required']);
    expect(parsed.filters.types).toEqual([{ source: SOURCE, kindId: 'issue' }]);
    // An unreadable precedence falls back to the retained default rather than
    // dropping the query beside it.
    expect(parsed.smartPolicy).toEqual(CORPUS_DEFAULT_SMART_POLICY_V1);
    expect(parsed.query).toBe('keep me');
  });

  it('preserves more than sixteen valid facet values when the complete route fits', () => {
    const scopes = Array.from(
      { length: 17 },
      (_unused, index) => `fp,${encodeURIComponent(SOURCE.pluginId)},${encodeURIComponent(SOURCE.localId)},scope-${index}`,
    );
    const parsed = parseTriageRouteSubPathV1([...scopes, 'q,keep'].join('/'));

    expect(parsed.filters.scopes).toHaveLength(17);
    expect(parsed.filters.scopes.at(-1)).toEqual({
      source: SOURCE,
      collisionScope: 'scope-16',
    });
    expect(parsed.query).toBe('keep');
  });

  it('drops a repeated facet value rather than spending the bound twice', () => {
    const one = `fs,${encodeURIComponent(SOURCE.pluginId)},${encodeURIComponent(SOURCE.localId)}`;
    expect(parseTriageRouteSubPathV1([one, one].join('/')).filters.sources)
      .toEqual([{ source: SOURCE }]);
  });

  it('reads the filters and the Smart precedence from the one reducer state', () => {
    expect(readTriageRouteLensV1({
      ...TRIAGE_SURFACE_INITIAL_STATE_V1,
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] },
      smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
    })).toEqual(lens({
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] },
      smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
    }));
  });

  it('measures the filters as part of the complete route it preflights', () => {
    const scopeValue = (index: number) => ({
      source: SOURCE,
      collisionScope: `${'scope'.repeat(12)}-${index}`,
    });
    const filtered = lens({
      filters: {
        ...TRIAGE_LIST_NO_FILTERS_V1,
        scopes: Array.from({ length: 16 }, (_u, i) => scopeValue(i)),
      },
    });

    // The complete resulting location does not fit. §3.2's refusal is therefore reachable from an
    // ordinary filter edit, not only from a hand-edited URL.
    expect(routeBytes(filtered)).toBeGreaterThan(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
    expect(preflightTriageRouteLensV1(filtered)).toEqual({ kind: 'refused' });
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
