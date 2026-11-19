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
  type TriageRouteWriteQueueV1,
} from './location.js';
import { reduceTriageSurfaceV1, TRIAGE_SURFACE_INITIAL_STATE_V1 } from '../state/surface.js';
import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../../corpus/query/smartPolicy.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from '../../composer/openEntryDetails.js';
import { applyTriageSettledSubPathV1 } from '../shell/settledLocation.js';

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
  it('shares only the selected entry ref and retains the live connection on settlement', () => {
    const selection = { sectionId: null, entryRef: entryRef(), sourceInstanceId: '22222222-2222-4222-8222-222222222222' };
    const state = { ...TRIAGE_SURFACE_INITIAL_STATE_V1, selection };
    const shared = lens({ selection: selection.entryRef });
    const subPath = buildTriageRouteSubPathV1(readTriageRouteLensV1(state));
    expect(subPath).toBe(buildTriageRouteSubPathV1(shared));
    expect(parseTriageRouteSubPathV1(`${subPath}/ei,${selection.sourceInstanceId}`)).toEqual(shared);
    expect(applyTriageSettledSubPathV1({ candidate: state,
      previous: TRIAGE_SURFACE_INITIAL_STATE_V1, subPath, rowsByKey: new Map() }).selection).toEqual(selection);
  });
  it('shares source and unit facets without configured-instance identities', async () => {
    const value = lens({ filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [
      { source: SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
      { source: SOURCE, sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
    ], scopes: [
      { source: SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111', unitId: 'team,one/a' },
      { source: SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111', unitId: 'team-two', collisionScope: 'acme/web' },
      { source: SOURCE, sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
      { source: SOURCE, sourceInstanceId: '11111111-1111-4111-8111-111111111111', collisionScope: 'acme/web' },
    ] } });
    const shared = lens({ filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
      sources: [{ source: SOURCE }],
      scopes: [{ source: SOURCE, unitId: 'team,one/a' }, { source: SOURCE, unitId: 'team-two', collisionScope: 'acme/web' }, { source: SOURCE },
        { source: SOURCE, collisionScope: 'acme/web' }],
    } });
    const subPath = buildTriageRouteSubPathV1(value);
    expect(subPath).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(subPath).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(parseTriageRouteSubPathV1(subPath)).toEqual(shared);
    expect(buildTriageRouteSubPathV1(parseTriageRouteSubPathV1(subPath))).toBe(subPath);
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (next) => ({ subPath: next }));
    await writeTriageRouteLensV1(hostApiWith({ methods: ['replacePageLocation'], replace }),
      { ...value, selection: entryRef() });
    expect(replace).toHaveBeenCalledWith(buildTriageRouteSubPathV1({ ...shared, selection: entryRef() }), {
      backLocation: subPath, view: TRIAGE_APP_PAGE_LOCAL_ID_V1,
    });
    const candidate = { ...TRIAGE_SURFACE_INITIAL_STATE_V1, filters: value.filters };
    const ownSettlement = applyTriageSettledSubPathV1({ candidate, previous: candidate, subPath, rowsByKey: new Map() });
    expect(ownSettlement.filters).toBe(candidate.filters);
    const external = applyTriageSettledSubPathV1({ candidate: TRIAGE_SURFACE_INITIAL_STATE_V1,
      previous: TRIAGE_SURFACE_INITIAL_STATE_V1, subPath, rowsByKey: new Map() });
    expect(external.filters).toEqual(shared.filters);
  });
  it('round trips the Tasks audience with selection and the ordinary saved-view lens', () => {
    const tasks = lens({ filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'agents' }, query: 'auth', selectedViewId: 'work', selection: entryRef() });
    expect(parseTriageRouteSubPathV1(buildTriageRouteSubPathV1(tasks))).toEqual(tasks);
    expect(parseTriageRouteSubPathV1('tasks,unknown/q,auth').filters).toEqual(TRIAGE_LIST_NO_FILTERS_V1);
  });
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
    const settlements: Array<Readonly<{
      query: string;
      subPath: string | null;
      superseded: boolean;
    }>> = [];
    const record = (query: string) => (settlement: Parameters<NonNullable<
      Parameters<TriageRouteWriteQueueV1['write']>[1]
    >>[0]) => {
      settlements.push({
        query,
        subPath: settlement.result?.kind === 'settled' ? settlement.result.subPath : null,
        superseded: settlement.superseded,
      });
    };

    queue.write(lens({ query: 'first' }), record('first'));
    queue.write(lens({ query: 'second' }), record('second'));
    queue.write(lens({ query: 'newest' }), record('newest'));
    await Promise.resolve();
    expect(replace.mock.calls.map(([subPath]) => subPath)).toEqual(['q,first']);

    settleFirst({ subPath: 'q,first' });
    await queue.whenSettled();
    expect(replace.mock.calls.map(([subPath]) => subPath)).toEqual(['q,first', 'q,newest']);
    expect(settlements).toEqual([
      { query: 'second', subPath: null, superseded: true },
      { query: 'first', subPath: 'q,first', superseded: true },
      { query: 'newest', subPath: 'q,newest', superseded: false },
    ]);
    queue.dispose();
  });

  it('knows a late echo of its own older write after that write finished (QB-82)', async () => {
    // Live c3e5a241bcda: Tasks, PRs & Issues pressed quickly. The host published the Tasks location after both
    // writes had settled; read as an outside move, it repainted Tasks over the newer PRs & Issues choice.
    const queue = createTriageRouteWriteQueueV1(hostApiWith({ methods: ['replacePageLocation'] }));
    queue.write(lens({ filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'mine' } }));
    await queue.whenSettled();
    queue.write(lens());
    await queue.whenSettled();
    expect(queue.adoptHostLocation('tasks,mine')).toBe(true);
    // The newest write's own echo is current, and a location this mount never wrote is the host's own move.
    expect(queue.adoptHostLocation('')).toBe(false);
    expect(queue.adoptHostLocation('q,elsewhere')).toBe(false);
    queue.dispose();
  });

  it('follows Back to an earlier view once the host has answered the newest choice (QB-82)', async () => {
    // Live READY240: the host publishes only where it ends up, so PRs & Issues, Tasks, PRs & Issues pressed quickly
    // echo once. The newest echo answers every earlier choice; a later Back to Tasks is the reader's own move.
    const tasks = lens({ filters: { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'mine' } });
    const queue = createTriageRouteWriteQueueV1(hostApiWith({ methods: ['replacePageLocation'] }), 'tasks,mine');
    for (const choice of [lens(), tasks, lens()]) {
      queue.write(choice);
      await queue.whenSettled();
    }
    expect(queue.adoptHostLocation('')).toBe(false);
    expect(queue.adoptHostLocation('tasks,mine')).toBe(false);
    queue.dispose();
  });

  it('settles retired route requests without allowing a saved-view continuation to write', async () => {
    let finish!: (value: { subPath: string }) => void;
    const hostWrite = new Promise<{ subPath: string }>((resolve) => { finish = resolve; });
    const queue = createTriageRouteWriteQueueV1(hostApiWith({
      methods: ['replacePageLocation'],
      replace: async () => hostWrite,
    }));
    const settlements: Array<{ query: string; result: unknown; superseded: boolean }> = [];
    const request = (query: string) => queue.write(lens({ query }), (settlement) => {
      settlements.push({ query, result: settlement.result, superseded: settlement.superseded });
    });
    request('active');
    request('pending');
    queue.dispose();
    request('retired');
    finish({ subPath: 'q,active' });
    await queue.whenSettled();
    expect(settlements).toEqual([
      { query: 'pending', result: null, superseded: true },
      { query: 'retired', result: null, superseded: true },
      { query: 'active', result: null, superseded: true },
    ]);
  });

  it('supersedes the active request and its successor when Back arrives before acknowledgment', async () => {
    let finish!: (value: { subPath: string }) => void;
    const hostWrite = new Promise<{ subPath: string }>((resolve) => { finish = resolve; });
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(() => hostWrite);
    const queue = createTriageRouteWriteQueueV1(hostApiWith({ methods: ['replacePageLocation'], replace }), '');
    const active = vi.fn();
    const successor = vi.fn();
    queue.write(lens({ query: 'first' }), active);
    queue.write(lens({ query: 'next' }), successor);
    expect(queue.adoptHostLocation('q,back')).toBe(false);
    finish({ subPath: 'q,first' });
    await queue.whenSettled();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result: null, superseded: true }));
    expect(successor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result: null, superseded: true }));
  });

  it('replaces A with the exact direct-open B tuple and the edited saved-view lens', async () => {
    const viewId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const sourceInstanceId = 'bbbbbbbb-0000-4000-8000-000000000002';
    const filters = { ...TRIAGE_LIST_NO_FILTERS_V1, types: [{ source: SOURCE, kindId: 'pullRequest' }] };
    const entryA = entryRef();
    const entryB = entryRef({ collisionScope: 'acme,web', entryId: 'a/b' });
    const initial = reduceTriageSurfaceV1(TRIAGE_SURFACE_INITIAL_STATE_V1, {
      kind: 'rowActivated', sectionId: null, entryRef: entryA, sourceInstanceId,
    });
    const selectedView = reduceTriageSurfaceV1(initial, {
      kind: 'savedViewApplied', viewId, query: 'initial', filters, order: 'newest', smartPolicy: CORPUS_DEFAULT_SMART_POLICY_V1,
    });
    const searched = reduceTriageSurfaceV1(selectedView, { kind: 'searchChanged', query: 'fix, please/now' });
    const filtered = reduceTriageSurfaceV1(searched, { kind: 'filterValueToggled', facet: 'states', value: 'open' });
    const reordered = reduceTriageSurfaceV1(filtered, { kind: 'orderChanged', order: 'smart' });
    const smartPolicy = { v: 1, precedence: ['activity', 'attention'] } as const;
    const beforeOpen = reduceTriageSurfaceV1(reordered, { kind: 'smartPolicyChanged', smartPolicy });
    const candidate = reduceTriageSurfaceV1(beforeOpen, { kind: 'rowActivated', sectionId: null, entryRef: entryB, sourceInstanceId });
    let location = buildTriageRouteSubPathV1(readTriageRouteLensV1(beforeOpen));
    expect(parseTriageRouteSubPathV1(location).selection).toEqual(entryA);
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (subPath) => {
      location = subPath;
      return { subPath };
    });

    await expect(writeTriageRouteLensV1(hostApiWith({ methods: ['replacePageLocation'], replace }),
      readTriageRouteLensV1(candidate))).resolves.toEqual({ kind: 'settled', subPath: expect.any(String) });

    const expected = lens({ order: 'smart', query: 'fix, please/now', smartPolicy,
      filters: { ...filters, states: ['open'] }, selectedViewId: viewId, selection: entryB });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(location).not.toContain(sourceInstanceId);
    expect(location).not.toContain('acme,web');
    expect(location).not.toContain('a/b');
    expect(parseTriageRouteSubPathV1(location)).toEqual(expected);
    const settled = applyTriageSettledSubPathV1({ candidate, previous: beforeOpen, subPath: location, rowsByKey: new Map() });
    expect(readTriageRouteLensV1(settled)).toEqual(expected);
  });

  it('keeps the default lens out of the location entirely', () => {
    expect(buildTriageRouteSubPathV1(TRIAGE_ROUTE_DEFAULT_LENS_V1)).toBe('');
    expect(parseTriageRouteSubPathV1('')).toEqual(TRIAGE_ROUTE_DEFAULT_LENS_V1);
    expect(parseTriageRouteSubPathV1(undefined)).toEqual(TRIAGE_ROUTE_DEFAULT_LENS_V1);
  });

  it('drops the unreleased grouping segment because no section planner consumes it', () => {
    const parsed = parseTriageRouteSubPathV1('g,scope/q,keep');

    expect(buildTriageRouteSubPathV1(parsed)).toBe('q,keep');
  });

  it('drops only the unreadable field and keeps every other valid one', () => {
    const parsed = parseTriageRouteSubPathV1([
      'g,scope',
      'o,sideways',
      'q,keep%20me',
      'e,acme.scm',
      'unknown,thing',
    ].join('/'));

    // An unknown order, the retired grouping segment and a truncated selection are dropped…
    expect(parsed.order).toBe('newest');
    expect(parsed.selection).toBeNull();
    // …and the query the user typed survives both.
    expect(parsed.query).toBe('keep me');
  });

  it('uses the canonical source, kind and scope schemas for routed filters', () => {
    const parsed = parseTriageRouteSubPathV1([
      'fs,not-a-plugin,github',
      `ft,acme.scm,github,${'k'.repeat(129)}`,
      `fp,acme.scm,github,${encodeURIComponent('scope\nchild')}`,
      'fst,open',
    ].join('/'));

    expect(parsed.filters).toEqual({
      ...TRIAGE_LIST_NO_FILTERS_V1,
      states: ['open'],
    });
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

  it('names the declared view each lens presents, so the host titles Tasks and PRs & Issues truthfully', async () => {
    const replace = vi.fn<PluginUiHostApi['replacePageLocation']>(async (subPath) => ({ subPath }));
    const host = hostApiWith({ methods: ['replacePageLocation'], replace });
    await writeTriageRouteLensV1(host, lens({ filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'mine' } }));
    await writeTriageRouteLensV1(host, lens({ query: 'bug' }));
    expect(replace.mock.calls.map(([, options]) => options?.view)).toEqual(['tasks', 'triage']);
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
        replace: async () => ({ subPath: 'q,canonical' }),
      }),
      lens({ query: 'requested' }),
    )).resolves.toEqual({ kind: 'settled', subPath: 'q,canonical' });
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

  it('drops an invalid entry and invalid facet values while retaining the valid lens', () => {
    const parsed = parseTriageRouteSubPathV1([
      'fst,open,sideways,unresolved',
      'fa,required,loud',
      // A type value missing its kind, beside a complete one.
      `ft,${encodeURIComponent(SOURCE.pluginId)},${encodeURIComponent(SOURCE.localId)}`,
      `ft,${encodeURIComponent(SOURCE.pluginId)},${encodeURIComponent(SOURCE.localId)},issue`,
      'sp,sideways',
      'e,acme.scm,github,issue,acme%2Fweb',
      'q,keep%20me',
    ].join('/'));

    expect(parsed.selection).toBeNull();
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
      lens({ query: 'bug' }),
    )).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(replace).not.toHaveBeenCalled();

    await expect(writeTriageRouteLensV1(
      hostApiWith({
        methods: ['replacePageLocation'],
        replace: async () => { throw new Error('host refused'); },
      }),
      lens({ query: 'bug' }),
    )).resolves.toEqual({ kind: 'refused', reason: 'rejected' });
  });
});

it('round-trips the source-owned field sort through copied and settled routes', () => {
  const sort = { field: 'created', direction: 'asc' } as const;
  const route = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, sort, query: 'retain me' });
  expect(parseTriageRouteSubPathV1(route)).toMatchObject({ sort, query: 'retain me' });
  expect(parseTriageRouteSubPathV1('s,created,sideways/q,retain%20me')).toMatchObject({ query: 'retain me' });
  expect(parseTriageRouteSubPathV1('s,created,sideways')).not.toHaveProperty('sort');
  const sorted = { ...TRIAGE_SURFACE_INITIAL_STATE_V1, sort };
  expect(applyTriageSettledSubPathV1({ candidate: sorted, previous: sorted, subPath: 'q,retain%20me', rowsByKey: new Map() }).sort).toBeUndefined();
});
