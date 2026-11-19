import { describe, expect, it } from 'vitest';
import { formatTriageTimestampV1, MAX_TRIAGE_LIST_SOURCE_BATCH_V1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../internalTasks/configuration.js';
import { REVIEW_DESCRIPTOR_V1 } from '../../reviews/contribution.js';
import {
  TRIAGE_LIST_NO_FILTERS_V1,
} from '../../projection/listWindow.js';
import { readTriageListEmptyState } from './emptyState.js';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import {
  readTriageListFailureLine,
  readTriageListFailureNotice,
  readTriageRefreshPacingNotice,
  readTriageListReadFailureNotice,
  readTriageSourceFailureRowV1,
  resolveTriageListRefreshV1,
  resolveTriageListShellState,
} from './windowState.js';
import type { TriageTextResolverV1 } from './windowState.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = { pluginId: 'happier.tracker', localId: 'issues' } as const;
const OTHER_INSTANCE = '22222222-2222-4222-8222-222222222222';

function window(overrides: Partial<TriageListWindowV1> = {}): TriageListWindowV1 {
  return {
    v: 1,
    rows: [],
    lanes: [],
    facetCensus: { types: [], scopes: [], coverage: 'complete' },
    coverage: 'complete',
    assembledAtMs: 1_760_000_000_000,
    ...overrides,
  };
}

function snapshot(overrides: Partial<TriageListWindowSnapshotV1> = {}): TriageListWindowSnapshotV1 {
  return {
    freshness: 'fresh',
    pending: 'idle',
    passes: 1,
    configuredSources: [{ sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, available: true }],
    ...overrides,
  };
}

describe('resolveTriageListShellState', () => {
  it.each(['plugin_source_missing', 'plugin_manifest_invalid', 'plugin_disabled'])(
    'discloses supplied cold availability cause %s through source Details', (code) => {
      const state = resolveTriageListShellState(snapshot({ window: window(),
        configuredSources: [{ sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE,
          available: false, availabilityFailure: { class: 'unknown', code, detail: SOURCE.pluginId } }],
      }));
      if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a source failure');
      expect(state.failure.sources).toHaveLength(1);
      const details = readTriageListFailureNotice(state.failure).details;
      expect(details).toContain(code);
      expect(details).toContain(SOURCE.pluginId);
      expect(details).not.toContain('Request ID');
    },
  );

  it.each([
    { class: 'unsupportedContract' as const, code: 'plugin_manifest_invalid', detail: 'happier.scm.forge.github: Non-safe plugin actions must declare host confirmation metadata.' },
    { class: 'authentication' as const, code: 'credential_reconnect_required', detail: 'Reconnect the GitHub account.', requestId: 'read-availability-17' },
  ])('retains $code in Details when the configured source is unavailable', (failure) => {
    const state = resolveTriageListShellState(snapshot({
      configuredSources: [{ sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, available: false }],
      window: window({ lanes: [{ source: SOURCE, sourceInstanceId: INSTANCE, exhausted: false,
        health: { kind: 'failed', failure } }] }),
    }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a source failure');
    expect(state.failure.sources).toHaveLength(1);
    const details = readTriageListFailureNotice(state.failure).details;
    expect(details).toContain(failure.code);
    expect(details).toContain(failure.detail);
    if ('requestId' in failure) expect(details).toContain(failure.requestId);
    else expect(details).not.toContain('Request ID');
  });

  it.each([false, true])('keeps one diagnostic per unavailable connection at source batch scale (cold: %s)', (cold) => {
    const configuredSources = Array.from({ length: MAX_TRIAGE_LIST_SOURCE_BATCH_V1 }, (_, index) => ({
      source: SOURCE, sourceInstanceId: `connection-${index}`, configurationRowId: `connection-${index}`, available: false,
      ...(cold ? { availabilityFailure: { class: 'unknown' as const, code: 'plugin_manifest_invalid', detail: SOURCE.pluginId } } : {}),
    }));
    const state = resolveTriageListShellState(snapshot({ configuredSources, window: window({
      lanes: cold ? [] : configuredSources.map(source => ({ source: source.source, sourceInstanceId: source.sourceInstanceId,
        exhausted: false, health: { kind: 'failed' as const, failure: { class: 'authentication' as const,
          code: 'credential_reconnect_required', requestId: `read-${source.sourceInstanceId}` } } })),
    }) }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected source failures');
    expect(state.failure.sources).toHaveLength(configuredSources.length);
    expect(new Set(state.failure.sources.map(source => source.sourceInstanceId)).size).toBe(configuredSources.length);
    expect(state.failure.sources.every(source => cold
      ? source.code === 'plugin_manifest_invalid' && source.requestId === undefined
      : source.requestId === `read-${source.sourceInstanceId}`)).toBe(true);
  });

  it('retains the exact provider Request ID on an admitted source failure', () => {
    const state = resolveTriageListShellState(snapshot({ window: window({ lanes: [{
      source: SOURCE, sourceInstanceId: INSTANCE, exhausted: false,
      health: { kind: 'failed', failure: { class: 'permission', code: 'forbidden', requestId: 'provider-42' } },
    }] }) }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a source failure');
    expect(readTriageListFailureNotice(state.failure).details).toContain('provider-42');
  });

  // QB-24: a throttle exposes the provider's retry time at once, in Manage sources and in the notice.
  it('says when a rate-limited source may be read again', () => {
    const retryNotBeforeMs = 1_760_000_120_000;
    const state = resolveTriageListShellState(snapshot({ window: window({ lanes: [{
      source: SOURCE, sourceInstanceId: INSTANCE, exhausted: false,
      health: { kind: 'failed', failure: { class: 'rateLimit', code: 'rate_limited', retryNotBeforeMs } },
    }] }) }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a source failure');
    const retryAt = formatTriageTimestampV1('en-US', retryNotBeforeMs, 'absolute', retryNotBeforeMs);
    const [source] = state.failure.sources;
    if (source === undefined) throw new Error('Expected a named source');
    expect(readTriageSourceFailureRowV1(source, undefined, 'en-US').reason).toContain(`Try again at ${retryAt}.`);
    expect(readTriageListFailureNotice(state.failure, undefined, 'en-US').description).toContain(`Try again at ${retryAt}.`);
    // One translated sentence owns the time's position and punctuation (ja puts it first).
    const ja: TriageTextResolverV1 = (key, fallback = '') => key === 'plugins.triage.surface.waiting.retryAt' ? '{time}以降に再試行できます。' : fallback;
    const jaAt = formatTriageTimestampV1('ja', retryNotBeforeMs, 'absolute', retryNotBeforeMs);
    expect(readTriageSourceFailureRowV1(source, ja, 'ja').reason).toMatch(new RegExp(`${jaAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}以降に再試行できます。$`));
    expect(readTriageRefreshPacingNotice('sourceRetryDeadline', retryNotBeforeMs, 'ja', ja).description).toMatch(/以降に再試行できます。$/);
    // The line beside the rows is where the reader is, so it names the time too (TRIAGE-UI-ACCEPT-1119 §4).
    expect(readTriageListFailureLine(state.failure, undefined, 'en-US').label).toMatch(new RegExp(`Try again at ${retryAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`));
  });

  // VIEW-HEALTH-1109: the selected view owns the body; the whole scan owns Manage sources.
  it('keeps a healthy empty selected source quiet while six outside sources need attention', () => {
    const lanes = Array.from({ length: 7 }, (_, index) => ({
      source: SOURCE, sourceInstanceId: `connection-${index}`, exhausted: index === 0,
      health: index === 0 ? { kind: 'walkFinished' as const }
        : { kind: 'failed' as const, failure: { class: 'transient' as const, code: 'source_unreachable' } },
    }));
    const input = snapshot({ window: window({ lanes, coverage: 'partial' }), loadMore: { kind: 'available' },
      configuredSources: lanes.map(lane => ({ ...lane, configurationRowId: lane.sourceInstanceId, available: true })) });
    const filters = { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: SOURCE, sourceInstanceId: 'connection-0' }] };
    const state = resolveTriageListShellState(input, { filters });
    expect(state).toMatchObject({ kind: 'window', failure: null,
      body: { kind: 'healthy-empty', coverage: 'complete', loadMore: { kind: 'exhausted' } },
      outsideSourcesAttention: { count: 6, target: 'manageSources' },
      wholeScanFailure: { sources: expect.any(Array) } });
    if (state.kind !== 'window') throw new Error('Expected a window');
    expect(state.wholeScanFailure?.sources).toHaveLength(6);
    expect(readTriageListEmptyState(state, 0, { narrowing: { facets: true, search: false, narrowed: true } }))
      .toMatchObject({ kind: 'noMatch', next: ['clearFilters'] });
    const failed = resolveTriageListShellState(input, { filters: { ...filters,
      sources: [{ source: SOURCE, sourceInstanceId: 'connection-1' }] } });
    expect(failed).toMatchObject({ kind: 'window', body: { kind: 'selected-source-failure' },
      failure: { sources: [{ sourceInstanceId: 'connection-1' }] }, outsideSourcesAttention: { count: 5 } });
    const all = resolveTriageListShellState(input);
    expect(all).toMatchObject({ kind: 'window', body: { kind: 'selected-source-failure', coverage: 'partial' },
      outsideSourcesAttention: null });
    if (all.kind !== 'window') throw new Error('Expected a window');
    expect(all.failure?.sources).toHaveLength(6);
    const reading = resolveTriageListShellState({ ...input,
      window: { ...input.window!, lanes: lanes.map(lane => lane.sourceInstanceId === 'connection-0'
        ? { ...lane, exhausted: false } : lane) } }, { filters });
    expect(reading).toMatchObject({ kind: 'window', failure: null,
      body: { kind: 'incomplete-empty', coverage: 'partial' }, outsideSourcesAttention: { count: 6 } });
    const recovered = resolveTriageListShellState({ ...input,
      window: { ...input.window!, lanes: lanes.map(lane => ({ ...lane, exhausted: true, health: { kind: 'walkFinished' } })),
        coverage: 'complete' } }, { filters });
    expect(recovered).toMatchObject({ kind: 'window', body: { kind: 'healthy-empty' }, outsideSourcesAttention: null });
    const observation = testkitObservation({ sourceInstanceId: 'connection-0' });
    const row = { entryRef: testkitEntryRef({ source: SOURCE }), content: null,
      lane: '1-open' as const, sortAtMs: 1, presence: { kind: 'present' as const, observedAtMs: 1 },
      attention: null, selected: { kind: 'selected' as const, sourceInstanceId: 'connection-0', reason: 'onlyPresent' as const },
      observations: [observation] };
    const populated = resolveTriageListShellState({ ...input, window: { ...input.window!, rows: [row] } }, { filters });
    expect(populated).toMatchObject({ kind: 'window', body: { kind: 'rows' }, failure: null,
      outsideSourcesAttention: { count: 6 } });
    if (populated.kind !== 'window') throw new Error('Expected a window');
    expect(populated.window.rows[0]).toBe(row);
  });

  it('applies view membership, type and scope selection before assigning invocation and unavailable failures', () => {
    const input = snapshot({ window: window({ coverage: 'partial', lanes: [
      { source: SOURCE, sourceInstanceId: INSTANCE, exhausted: true, health: { kind: 'walkFinished' } },
      { source: OTHER_SOURCE, sourceInstanceId: OTHER_INSTANCE, exhausted: false, health: { kind: 'unavailable' } },
    ] }), configuredSources: [
      { source: SOURCE, sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, available: true },
      { source: OTHER_SOURCE, sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE, available: false },
    ], unreadableSources: [{ sourceInstanceId: OTHER_INSTANCE, message: 'Unavailable', code: 'source_unavailable' }] });
    for (const options of [
      { inventory: { includesSource: (source: Readonly<{ pluginId: string }>) => source.pluginId === SOURCE.pluginId,
        includesKind: () => true } },
      { filters: { ...TRIAGE_LIST_NO_FILTERS_V1, types: [{ source: SOURCE, kindId: 'issue' }] } },
      { filters: { ...TRIAGE_LIST_NO_FILTERS_V1, scopes: [{ source: SOURCE, sourceInstanceId: INSTANCE }] } },
    ]) {
      expect(resolveTriageListShellState(input, options)).toMatchObject({ kind: 'window', failure: null,
        body: { kind: 'healthy-empty', coverage: 'complete' }, outsideSourcesAttention: { count: 1 } });
    }
  });

  it('surfaces a partial-family denial in a retained window with its typed reason and remedy', () => {
    const failure = { class: 'permission' as const, code: 'insufficient_scope',
      detail: 'Dependabot alerts could not be read. Reconnect GitHub with security_events access.' };
    const state = resolveTriageListShellState(snapshot({ window: window({ coverage: 'partial', lanes: [{
      sourceInstanceId: INSTANCE, source: SOURCE, exhausted: false, health: { kind: 'partial',
        reason: 'github-alerts-dependabot-permission', failure },
    }] }) }));
    expect(state).toMatchObject({ kind: 'window', showReadWarning: true, failure: { kind: 'sources',
      sources: [{ sourceInstanceId: INSTANCE, code: failure.code, reason: failure.detail }] } });
  });
  it('decides first run from the sources serving the current page', () => {
    const builtin = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance;
    const personalOnly = snapshot({ window: window(), configuredSources: [{ ...builtin,
      configurationRowId: INTERNAL_TASK_SOURCE_RECORD_V1.rowId, available: true }] });
    expect(resolveTriageListShellState(personalOnly).kind).toBe('configureSources');
    expect(resolveTriageListShellState(personalOnly, { tasks: true }).kind).toBe('window');
    expect(resolveTriageListShellState({ ...personalOnly, configuredSources: [
      ...personalOnly.configuredSources, { sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, available: true },
    ] }).kind).toBe('window');
  });
  it('keeps the Desk first run while only setup-free sources are configured and none has a row (QB-63)', () => {
    const reviews = { pluginId: 'happier.triage', localId: 'reviews' } as const;
    const readSourceDescriptor = (source: { pluginId: string; localId: string }) =>
      source.pluginId === reviews.pluginId && source.localId === reviews.localId ? REVIEW_DESCRIPTOR_V1 : null;
    const automatic = { sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE, source: reviews, available: true as const };
    const automaticOnly = snapshot({ window: window(), configuredSources: [automatic] });
    expect(resolveTriageListShellState(automaticOnly, { readSourceDescriptor }).kind).toBe('configureSources');
    const row = { entryRef: testkitEntryRef({ source: reviews }), content: null,
      lane: '1-open' as const, sortAtMs: 1, presence: { kind: 'present' as const, observedAtMs: 1 },
      attention: null, selected: { kind: 'selected' as const, sourceInstanceId: OTHER_INSTANCE, reason: 'onlyPresent' as const },
      observations: [testkitObservation({ sourceInstanceId: OTHER_INSTANCE })] };
    expect(resolveTriageListShellState({ ...automaticOnly, window: window({ rows: [row] }) }, { readSourceDescriptor }).kind)
      .toBe('window');
    expect(resolveTriageListShellState({ ...automaticOnly, configuredSources: [automatic,
      { sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, available: true }] }, { readSourceDescriptor }).kind)
      .toBe('window');
  });
  it('keeps source invocation codes in details rather than the translated explanation', () => {
    const failure = { kind: 'sources' as const, sources: [{ sourceInstanceId: INSTANCE, displayName: 'Personal tasks',
      reason: 'Could not be reached just now.', code: 'source_unavailable' }] };
    const notice = readTriageListFailureNotice(failure, (key, fallback) => key.endsWith('.transient') ? 'Try again later' : fallback ?? key);
    expect(notice.description).not.toContain('source_unavailable');
    expect(notice).toMatchObject({ details: 'Personal tasks — For support: source_unavailable' });
    expect(failure.sources[0]!.code).toBe('source_unavailable');
  });
  it('does not describe a non-retryable invocation refusal as a transient outage', () => {
    const state = resolveTriageListShellState(snapshot({
      window: window({ lanes: [{ sourceInstanceId: INSTANCE, source: SOURCE,
        health: { kind: 'unavailable' }, exhausted: false }] }),
      unreadableSources: [{ sourceInstanceId: INSTANCE, message: 'The source could not be read in this pass.',
        code: 'plugin_activation_failed', retryable: false }],
    }));
    expect(state.kind).toBe('window');
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a named source failure');
    const notice = readTriageListFailureNotice(state.failure, (key, fallback) =>
      key === 'plugins.triage.surface.listFailed.permanent' ? 'Recovery needs a change' : fallback ?? key);
    expect(notice.description).toBe('Recovery needs a change');
    expect(notice).toMatchObject({ details: expect.stringContaining('plugin_activation_failed') });
  });
  it('says a failure beside rows in one line, leading to the one press that can help', () => {
    const transient = { kind: 'sources', sources: [
      { sourceInstanceId: 'a', displayName: 'GitHub', reason: 'Could not be reached just now.' },
    ] } as const;
    expect(readTriageListFailureLine(transient)).toEqual({
      label: 'GitHub could not be reached. Their entries may be missing or out of date.', recovery: 'retry',
    });
    // Several causes: all named, reasons left to Manage sources, and the sentence that told the reader nothing is gone.
    expect(readTriageListFailureLine({ kind: 'sources', sources: [
      { sourceInstanceId: 'a', displayName: 'GitHub', reason: 'Needs you to sign in again.', needsConnectionChange: true },
      { sourceInstanceId: 'b', displayName: 'Linear', reason: 'Could not be reached just now.', retryable: false, needsConnectionChange: true },
    ] }, undefined, 'en')).toEqual({ label: 'GitHub and Linear could not be read. Their entries may be missing or out of date.', recovery: 'manageSources' });
    expect(readTriageListFailureLine({ kind: 'sources', sources: [
      { sourceInstanceId: 'b', displayName: 'Linear', reason: 'Could not be reached just now.', retryable: false, needsConnectionChange: true },
    ] }).label).toBe('Linear could not be read. Their entries may be missing or out of date.');
  });
  it('offers inline retry for a retryable read even beside a connection that needs repair', () => {
    expect(readTriageListFailureLine({ kind: 'sources', sources: [
      { sourceInstanceId: 'a', displayName: 'GitHub', reason: 'Needs you to sign in again.', needsConnectionChange: true },
      { sourceInstanceId: 'b', displayName: 'Linear', reason: 'Could not be reached just now.', retryable: true },
    ] }).recovery).toBe('retry');
  });
  it('offers inline retry for timed-out list reads despite generic outcome-unknown retry advice', () => {
    const state = resolveTriageListShellState(snapshot({
      window: window({ lanes: [{ sourceInstanceId: INSTANCE, source: SOURCE,
        health: { kind: 'unavailable' }, exhausted: false }] }),
      unreadableSources: [{ sourceInstanceId: INSTANCE, message: 'No answer came back in time, so it may still finish.',
        code: 'timeout', retryable: false }],
    }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected the timed-out list read');
    expect(readTriageListFailureLine(state.failure).recovery).toBe('retry');
    expect(state.failure.sources[0]?.needsConnectionChange).toBe(false);
  });
  it('preserves the provider refusal code as well as its readable failure class', () => {
    const state = resolveTriageListShellState(snapshot({ window: window({ lanes: [{
      sourceInstanceId: INSTANCE, source: SOURCE, exhausted: false,
      health: { kind: 'failed', failure: { class: 'authentication', code: 'github_credential_mismatch' } },
    }] }) }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a named source failure');
    expect(readTriageListFailureNotice(state.failure)).toMatchObject({
      description: 'Needs you to sign in again.', details: expect.stringContaining('github_credential_mismatch'),
    });
  });
  it('keeps a provider diagnostic such as its request ID in Details, never in the one-line summary', () => {
    const state = resolveTriageListShellState(snapshot({ window: window({ lanes: [{
      sourceInstanceId: INSTANCE, source: SOURCE, exhausted: false,
      health: { kind: 'failed', failure: { class: 'transient', code: 'http_502', detail: 'GitHub request ID: D4E2:3DFCCB:10C1E2' } },
    }] }) }));
    if (state.kind !== 'window' || state.failure === null) throw new Error('Expected a named source failure');
    const line = readTriageListFailureLine(state.failure);
    expect(line.label).not.toContain('D4E2:3DFCCB:10C1E2');
    expect(line.label).toContain('could not be reached');
    // Details (Manage sources) still carries the provider's own words, request ID included.
    expect(readTriageListFailureNotice(state.failure).description).toContain('GitHub request ID: D4E2:3DFCCB:10C1E2');
  });
  it('keeps age-only staleness truthful without a list read warning', () => {
    const aged = snapshot({
      window: window({ lanes: [{ sourceInstanceId: INSTANCE, source: SOURCE, health: { kind: 'walkFinished' }, exhausted: true }] }),
      freshness: 'stale',
    });
    expect(resolveTriageListShellState(aged)).toMatchObject({
      kind: 'window', stale: true, showReadWarning: false, failure: null,
    });
  });

  it('withholds "configure a source" until a pass has actually looked', () => {
    // Before the first completed cycle nothing has enumerated the configured
    // instances, so accusing the reader of not configuring one would be a guess.
    expect(resolveTriageListShellState(snapshot({ freshness: 'unknown', configuredSources: [] })))
      .toEqual({ kind: 'initial' });
  });

  it('names a genuinely unconfigured aggregate once a window exists', () => {
    expect(resolveTriageListShellState(snapshot({ window: window(), configuredSources: [] })))
      .toEqual({ kind: 'configureSources' });
  });

  it('reports the failure only when no window was ever assembled', () => {
    expect(resolveTriageListShellState(snapshot({
      freshness: 'unknown',
      error: { code: 'plugin_action_failed', message: 'The list could not be read.' },
    }))).toEqual({ kind: 'unavailable', message: 'The list could not be read.', retryable: true });
  });

  it('carries whether retrying can help and the diagnostic, never the bare code as copy', () => {
    expect(resolveTriageListShellState(snapshot({
      freshness: 'unknown',
      error: {
        code: 'plugin_action_failed',
        message: 'unsupported_method',
        retryable: false,
        detail: 'unsupported_method · host_api_method_not_installed:executeAction',
      },
    }))).toEqual({
      kind: 'unavailable',
      message: 'unsupported_method',
      retryable: false,
      detail: 'unsupported_method · host_api_method_not_installed:executeAction',
    });
  });

  it('says the wait out loud instead of leaving Refresh to do nothing', () => {
    const blocked = snapshot({
      window: window(),
      refreshBlocked: { reason: 'sourceRetryDeadline', nextEligibleAtMs: 9_000 },
    });

    // `core/CORPUS.md` §4.2: a Refresh the coordinator is already refusing must
    // be stated, not silently ignored. The deadline is the coordinator's answer,
    // read rather than recomputed from lane health.
    expect(resolveTriageListRefreshV1(blocked, 8_999))
      .toEqual({ kind: 'blocked', reason: 'sourceRetryDeadline', nextEligibleAtMs: 9_000 });
    // At the deadline the refusal is over; a surface that kept disabling the
    // control here would strand the reader behind an expired wait.
    expect(resolveTriageListRefreshV1(blocked, 9_000)).toEqual({ kind: 'available' });
    expect(resolveTriageListRefreshV1(snapshot({ window: window() }), 9_000))
      .toEqual({ kind: 'available' });
    // A pass already running outranks the pacing that will govern the next one.
    expect(resolveTriageListRefreshV1(snapshot({
      window: window(),
      pending: 'refresh',
      refreshBlocked: { reason: 'sourceRetryDeadline', nextEligibleAtMs: 9_000 },
    }), 1).kind).toBe('running');
  });

  it('shows the coordinator deadline as the exact retry time', () => {
    const retryAtMs = Date.parse('2026-08-28T14:30:00.000Z');
    const notice = readTriageRefreshPacingNotice(
      'sourceRetryDeadline',
      retryAtMs,
      'en-US',
    );

    // SURFACE §6.1 requires the provider/source retry evidence to reach the reader. The shell
    // must present that exact time, not re-derive another retry estimate.
    expect(notice.description).toContain(
      formatTriageTimestampV1('en-US', retryAtMs, 'absolute', retryAtMs),
    );
  });

  it('keeps durable user state its own reachability answer', () => {
    const unread = snapshot({
      freshness: 'unknown',
      error: { code: 'plugin_action_machine_required', message: 'The list could not be read.' },
    });

    // `core/SURFACE.md` §6.2 states 5 and 6 are two different answers. With the
    // reader's pins still readable, the surface may not take away the Pinned
    // section, saved views and Pin/Unpin — those are Collection state and no
    // source read is involved in them.
    expect(resolveTriageListShellState(unread, { durableStateReachable: true }))
      .toEqual({ kind: 'sourcesUnreachable', message: 'The list could not be read.', retryable: true });
    expect(resolveTriageListShellState(unread, { durableStateReachable: false }))
      .toEqual({ kind: 'unavailable', message: 'The list could not be read.', retryable: true });
    // Fails closed: a caller that cannot answer promises the reader nothing.
    expect(resolveTriageListShellState(unread).kind).toBe('unavailable');
  });

  it.each(['plugin_surface_client_action_unavailable', 'plugin_surface_contributed_action_unavailable', 'plugin_action_failed', 'unavailable'])(
    'does not classify an Action read failure as machine unreachability (%s)', code => {
      const state = resolveTriageListShellState(snapshot({ freshness: 'unknown',
        error: { code, message: code, retryable: false } }), { durableStateReachable: true });
      expect(state).toEqual({ kind: 'readFailed', message: code, retryable: false });
    },
  );

  it('uses the structured host reason to distinguish an unreachable Machine from an Action refusal', () => {
    const error = { code: 'unavailable', message: 'unavailable',
      diagnostics: ['plugin_action_machine_required'] };
    expect(resolveTriageListShellState(snapshot({ error }), { durableStateReachable: true }).kind)
      .toBe('sourcesUnreachable');
    expect(resolveTriageListShellState(snapshot({ error: { ...error,
      diagnostics: ['plugin_surface_client_action_unavailable'] } }), { durableStateReachable: true }).kind)
      .toBe('readFailed');
    expect(resolveTriageListShellState(snapshot({ error: { ...error,
      diagnostics: ['plugin_surface_contributed_action_unavailable'] } }), { durableStateReachable: true }).kind)
      .toBe('readFailed');
  });

  it('keeps a failed refresh beside the rows instead of replacing them', () => {
    const rows = window({ rows: [], coverage: 'partial' });
    const state = resolveTriageListShellState(snapshot({
      window: rows,
      freshness: 'stale',
      error: { code: 'provider-busy', message: 'The source is busy.' },
    }));

    // The one thing this surface must never do is answer a provider failure
    // with a blank list, which reads as "nothing needs you". The rows stay, and
    // they stop being claimed as current.
    //
    // What it must equally never do is title the banner beside them "The list
    // could not be read", which the reader can see is false. This test asserted
    // exactly that shape until now, so the defect it locked survived two
    // repairs. `projection/listWindowStore.ts` no longer publishes the
    // store-wide error beside a retained window, and there is no longer a
    // reader arm that could render one: an aggregate read that fails over rows
    // names its connections, and this resolver reports only named connections.
    expect(state).toMatchObject({
      kind: 'window',
      window: rows,
      refreshing: false,
      stale: true,
      showReadWarning: true,
      failure: null,
    });
  });

  it('names the connection that failed and leaves the healthy one out of it', () => {
    // `REQ-01`: per-source health, visible. With two connections configured and
    // one broken, a reader told only that "a source" failed cannot act — they
    // do not know which of their own connections to go and fix.
    const failed = window({
      lanes: [
        {
          sourceInstanceId: INSTANCE,
          source: SOURCE,
          health: { kind: 'walkFinished' },
          exhausted: true,
        },
        {
          sourceInstanceId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          health: { kind: 'failed', failure: { class: 'permission', code: 'forbidden' } },
          exhausted: false,
        },
      ],
    });
    const state = resolveTriageListShellState(snapshot({
      configuredSources: [
        { sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          displayLabel: 'globex/service',
          available: true,
        },
      ],
      window: failed,
      freshness: 'stale',
    }));

    expect(state).toMatchObject({
      kind: 'window',
      window: failed,
      refreshing: false,
      stale: true,
      showReadWarning: true,
      failure: {
        kind: 'sources',
        sources: [{
          sourceInstanceId: OTHER_INSTANCE,
          displayName: 'globex/service',
          reason: 'Refused this account access.',
          code: 'forbidden',
          needsConnectionChange: true,
        }],
      },
    });
    // The healthy connection is never accused, and the closed classification
    // stays a machine word rather than becoming the sentence a reader is shown.
    const serialized = JSON.stringify(state.kind === 'window' ? state.failure : state);
    expect(serialized).not.toContain('acme/widgets');
    expect(serialized).not.toContain('permission');
  });

  it('falls back to the qualified contribution id when a connection has no label', () => {
    const failed = window({
      lanes: [{
        sourceInstanceId: INSTANCE,
        source: SOURCE,
        health: { kind: 'failed', failure: { class: 'transient', code: 'busy' } },
        exhausted: false,
      }],
    });
    const state = resolveTriageListShellState(snapshot({ window: failed, freshness: 'stale' }));

    // An unlabelled connection loses the label, never the attribution: an
    // internal instance UUID would name it without telling the reader anything.
    expect(state).toMatchObject({
      failure: {
        kind: 'sources',
        sources: [{ displayName: 'happier.forge/items', reason: 'Could not be reached just now.' }],
      },
    });
  });

  it('lists every broken connection rather than summarizing them into a count', () => {
    // `REQ-01` again, at the size that actually matters: a reader with six
    // configured sources and three broken ones needs all three names. A count
    // is not something they can act on, and naming only the first hides two
    // failures behind one that may already be fixed.
    const notice = readTriageListFailureNotice({
      kind: 'sources',
      sources: [
        { sourceInstanceId: INSTANCE, displayName: 'acme/widgets', reason: 'Needs you to sign in again.' },
        { sourceInstanceId: OTHER_INSTANCE, displayName: 'globex/service', reason: 'Refused this account access.' },
      ],
    });

    expect(notice.title).toBe('Some sources could not be read');
    expect(notice.description).toContain('acme/widgets — Needs you to sign in again.');
    expect(notice.description).toContain('globex/service — Refused this account access.');
  });

  it('names the connection an invocation could not reach, beside the rows it still has', () => {
    // The regression this closes: a lane the pass could not read at all left the
    // store's own message in `snapshot.error`, so the banner rendered beside a
    // populated list was titled "The list could not be read" — a sentence the
    // reader could see was false. An unreadable lane is one named connection,
    // exactly like a failed one; it just carries no provider evidence.
    const partial = window({
      rows: [],
      coverage: 'partial',
      lanes: [
        {
          sourceInstanceId: INSTANCE,
          source: SOURCE,
          health: { kind: 'walkFinished' },
          exhausted: true,
        },
        {
          sourceInstanceId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          health: { kind: 'unavailable' },
          exhausted: false,
        },
      ],
    });
    const state = resolveTriageListShellState(snapshot({
      configuredSources: [
        { sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          displayLabel: 'globex/service',
          available: true,
        },
      ],
      window: partial,
      freshness: 'stale',
      unreadableSources: [{
        sourceInstanceId: OTHER_INSTANCE,
        message: 'The source could not be read in this pass.',
      }],
    }));

    expect(state).toMatchObject({
      kind: 'window',
      stale: true,
      showReadWarning: true,
      failure: {
        kind: 'sources',
        sources: [{
          sourceInstanceId: OTHER_INSTANCE,
          displayName: 'globex/service',
          // The store's sentence is its own diagnostic ("in this pass" is mechanism); the reader is told the
          // shell's translated reason for a connection that could not be reached.
          reason: 'Could not be reached just now.',
        }],
      },
    });
    // The banner beside a populated list now says whose connection it is.
    const notice = readTriageListFailureNotice(
      state.kind === 'window' && state.failure !== null ? state.failure : { kind: 'sources', sources: [] },
    );
    expect(notice.title).toBe('globex/service could not be read');
    expect(notice.title).not.toBe('The list could not be read');
    // The healthy connection is never swept into the accusation.
    expect(JSON.stringify(state.kind === 'window' ? state.failure : state)).not.toContain('acme/widgets');
  });

  it('keeps both a failed connection and an unreachable one, rather than the first kind it finds', () => {
    // The shape a "return the failed ones if there are any" implementation gets
    // wrong: with one of each, a reader shown only the failure would go and fix
    // that connection and never learn the other was not read at all.
    const mixed = window({
      coverage: 'partial',
      lanes: [
        {
          sourceInstanceId: INSTANCE,
          source: SOURCE,
          health: { kind: 'failed', failure: { class: 'permission', code: 'forbidden' } },
          exhausted: false,
        },
        {
          sourceInstanceId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          health: { kind: 'unavailable' },
          exhausted: false,
        },
      ],
    });
    const state = resolveTriageListShellState(snapshot({
      configuredSources: [
        { sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          displayLabel: 'globex/service',
          available: true,
        },
      ],
      window: mixed,
      freshness: 'stale',
      unreadableSources: [{
        sourceInstanceId: OTHER_INSTANCE,
        message: 'The source could not be read in this pass.',
      }],
    }));

    expect(state).toMatchObject({
      failure: {
        kind: 'sources',
        sources: [
          { displayName: 'acme/widgets', reason: 'Refused this account access.' },
          { displayName: 'globex/service', reason: 'Could not be reached just now.' },
        ],
      },
    });
    const notice = readTriageListFailureNotice(
      state.kind === 'window' && state.failure !== null ? state.failure : { kind: 'sources', sources: [] },
    );
    expect(notice.title).toBe('Some sources could not be read');
    expect(notice.description).toContain('acme/widgets — Refused this account access.');
    expect(notice.description).toContain('globex/service — Could not be reached just now.');
  });

  it('leaves a source no pass ever asked out of the failure notice', () => {
    // `sourceHealth.ts` excludes `unavailable` from provider-evidence health for
    // a reason: a lane nothing asked is an unfinished walk, not a broken
    // connection. Attribution must come from the store's record of what it
    // actually invoked, never from the health word alone.
    const partial = window({
      coverage: 'partial',
      lanes: [{
        sourceInstanceId: OTHER_INSTANCE,
        source: OTHER_SOURCE,
        health: { kind: 'unavailable' },
        exhausted: false,
      }],
    });
    const state = resolveTriageListShellState(snapshot({
      configuredSources: [
        { sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE, source: OTHER_SOURCE, available: true },
      ],
      window: partial,
      freshness: 'stale',
    }));

    expect(state).toMatchObject({ kind: 'window', stale: true, showReadWarning: true, failure: null });
  });

  it('separates a refresh in flight from staleness', () => {
    const state = resolveTriageListShellState(snapshot({ window: window(), pending: 'refresh' }));
    expect(state).toMatchObject({
      kind: 'window',
      window: window(),
      refreshing: true,
      stale: false,
      showReadWarning: false,
      failure: null,
    });
  });

  it('names a configured connection whose source is not installed on this machine', () => {
    // Configuration admission identifies an unavailable contribution even when
    // the fold supplies a coverage lane; this is separate from read freshness.
    const state = resolveTriageListShellState(snapshot({
      configuredSources: [
        { sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE, configurationRowId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          displayLabel: 'globex/service',
          available: false,
        },
      ],
      window: window(),
      freshness: 'stale',
    }));

    expect(state.kind).toBe('window');
    expect(state).toMatchObject({ showReadWarning: true });
    const failure = state.kind === 'window' ? state.failure : null;
    expect(failure?.kind).toBe('sources');
    expect(failure?.kind === 'sources' ? failure.sources.map((s) => s.sourceInstanceId) : [])
      .toEqual([OTHER_INSTANCE]);
    expect(failure?.kind === 'sources' ? failure.sources[0]?.displayName : undefined)
      .toBe('globex/service');
  });
});

describe('readTriageListReadFailureNotice', () => {
  it.each(['unavailable', 'plugin_action_failed', 'plugin.mounted-caller:unavailable'])('localizes a diagnostic token instead of presenting %s as the explanation', (message) => {
    const notice = readTriageListReadFailureNotice({ kind: 'sourcesUnreachable', message, retryable: true },
      (key, fallback) => key === 'plugins.triage.surface.sourcesUnreachable.description' ? 'Localized recovery explanation' : fallback);
    expect(notice.description).toBe('Localized recovery explanation');
  });

  it('says the host\'s own reason, which names the machine and the next step, instead of a vaguer stand-in', () => {
    // D1: when this device's Run-on Machine cannot answer, the page stays and only its Machine data
    // is unavailable. The host's reason is the one sentence that names that Machine; the generic
    // "a machine" copy hid which one and what to do.
    const notice = readTriageListReadFailureNotice({
      kind: 'sourcesUnreachable',
      message: 'This operation is unavailable on studio-mac. Reconnect it or choose another machine with Run on.',
      retryable: true,
    });
    expect(notice.title).toBe('Your sources could not be reached');
    expect(notice.description).toBe('This operation is unavailable on studio-mac. Reconnect it or choose another machine with Run on.');
  });

  it('keeps the general explanation when the failure carried no words', () => {
    const notice = readTriageListReadFailureNotice({ kind: 'sourcesUnreachable', message: ' ', retryable: true });
    expect(notice.description).toContain('Refresh tries again');
  });
});
