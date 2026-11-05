import { describe, expect, it } from 'vitest';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListWindowV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import {
  readTriageListFailureLine,
  readTriageListFailureNotice,
  readTriageRefreshPacingNotice,
  readTriageListReadFailureNotice,
  resolveTriageListRefreshV1,
  resolveTriageListShellState,
} from './windowState.js';

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
    configuredSources: [{ sourceInstanceId: INSTANCE, source: SOURCE, available: true }],
    ...overrides,
  };
}

describe('resolveTriageListShellState', () => {
  it('keeps source invocation codes in details rather than the translated explanation', () => {
    const failure = { kind: 'sources' as const, sources: [{ sourceInstanceId: INSTANCE, displayName: 'Personal tasks',
      reason: 'Could not be reached just now.', code: 'source_unavailable' }] };
    const notice = readTriageListFailureNotice(failure, (key, fallback) => key.endsWith('.transient') ? 'Try again later' : fallback ?? key);
    expect(notice.description).not.toContain('source_unavailable');
    expect(notice).toMatchObject({ details: 'Personal tasks — source_unavailable' });
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
      label: 'GitHub could not be read. Could not be reached just now.', recovery: 'retry',
    });
    // Several causes: all named, reasons left to Manage sources, and the sentence that told the reader nothing is gone.
    expect(readTriageListFailureLine({ kind: 'sources', sources: [
      { sourceInstanceId: 'a', displayName: 'GitHub', reason: 'Needs you to sign in again.', needsConnectionChange: true },
      { sourceInstanceId: 'b', displayName: 'Linear', reason: 'Could not be reached just now.', retryable: false, needsConnectionChange: true },
    ] }, undefined, 'en')).toEqual({ label: 'GitHub and Linear could not be read.', recovery: 'manageSources' });
    expect(readTriageListFailureLine({ kind: 'sources', sources: [
      { sourceInstanceId: 'b', displayName: 'Linear', reason: 'Could not be reached just now.', retryable: false, needsConnectionChange: true },
    ] }).label).toBe('Linear could not be read.');
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
      refreshBlocked: { reason: 'failureBackoff', nextEligibleAtMs: 9_000 },
    });

    // `core/CORPUS.md` §4.2: a Refresh the coordinator is already refusing must
    // be stated, not silently ignored. The deadline is the coordinator's answer,
    // read rather than recomputed from lane health.
    expect(resolveTriageListRefreshV1(blocked, 8_999))
      .toEqual({ kind: 'blocked', reason: 'failureBackoff', nextEligibleAtMs: 9_000 });
    // At the deadline the refusal is over; a surface that kept disabling the
    // control here would strand the reader behind an expired wait.
    expect(resolveTriageListRefreshV1(blocked, 9_000)).toEqual({ kind: 'available' });
    expect(resolveTriageListRefreshV1(snapshot({ window: window() }), 9_000))
      .toEqual({ kind: 'available' });
    // A pass already running outranks the pacing that will govern the next one.
    expect(resolveTriageListRefreshV1(snapshot({
      window: window(),
      pending: 'refresh',
      refreshBlocked: { reason: 'minimumInterval', nextEligibleAtMs: 9_000 },
    }), 1).kind).toBe('running');
  });

  it('gives each pacing reason its own words rather than one generic wait', () => {
    const reasons = ['minimumInterval', 'sourceRetryDeadline', 'failureBackoff'] as const;
    const descriptions = reasons.map(
      (reason) => readTriageRefreshPacingNotice(reason, 9_000, 'en-US').description,
    );

    // Three different refusals: "read a moment ago", "the source asked us to
    // wait" and "the last read failed" are different things to a reader, and
    // one shared sentence would hide which of them is happening.
    expect(new Set(descriptions).size).toBe(reasons.length);
    expect(descriptions.every((description) => description.length > 0)).toBe(true);
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
    expect(state).toEqual({
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
        { sourceInstanceId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE,
          source: OTHER_SOURCE,
          displayLabel: 'globex/service',
          available: true,
        },
      ],
      window: failed,
      freshness: 'stale',
    }));

    expect(state).toEqual({
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
        { sourceInstanceId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE,
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
        { sourceInstanceId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE,
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
        { sourceInstanceId: OTHER_INSTANCE, source: OTHER_SOURCE, available: true },
      ],
      window: partial,
      freshness: 'stale',
    }));

    expect(state).toMatchObject({ kind: 'window', stale: true, showReadWarning: true, failure: null });
  });

  it('separates a refresh in flight from staleness', () => {
    const state = resolveTriageListShellState(snapshot({ window: window(), pending: 'refresh' }));
    expect(state).toEqual({
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
        { sourceInstanceId: INSTANCE, source: SOURCE, displayLabel: 'acme/widgets', available: true },
        {
          sourceInstanceId: OTHER_INSTANCE,
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
