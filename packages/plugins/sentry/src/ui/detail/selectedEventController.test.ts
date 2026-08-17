import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import type { SentryEventProjectionV1 } from '../../privacy/sentryEventProjection.js';

import {
  sentrySelectedEventInitialState,
  sentrySelectedEventReducer,
  type SentrySelectedEventStateV1,
} from './selectedEventController.js';

const FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'permission',
  code: 'sentry-insufficient-permission',
});

function projection(eventId: string): SentryEventProjectionV1 {
  return {
    eventId,
    dateCreatedMs: null,
    title: 'boom',
    message: 'boom',
    location: null,
    culprit: null,
    platform: null,
    sections: [],
    tags: [],
    user: null,
    redactions: [],
    sensitivePaths: [],
    projectionTruncated: false,
    omitted: { sections: 0, frames: 0, breadcrumbs: 0, tags: 0 },
  };
}

function demanded(): SentrySelectedEventStateV1 {
  return sentrySelectedEventReducer(sentrySelectedEventInitialState(), { kind: 'demanded' });
}

describe('Sentry selected-event controller', () => {
  it('starts on the representative occurrence and reads nothing until a consumer asks', () => {
    const initial = sentrySelectedEventInitialState();

    // Scan, occurrence paging, inactive tabs, hover and detail construction all
    // mount this controller; none of them may cost an event body.
    expect(initial.selected).toEqual({ kind: 'representative' });
    expect(initial.read.kind).toBe('idle');
  });

  it('coalesces every same-key demand into one read', () => {
    const first = demanded();
    expect(first.read.kind).toBe('loading');

    // Overview, an explicitly revealed occurrence detail and Stack Trace all
    // demand the same projection. A second in-flight request for one selection
    // would double the provider cost and the PII blast radius for nothing.
    const second = sentrySelectedEventReducer(first, { kind: 'demanded' });
    expect(second).toBe(first);

    const settled = sentrySelectedEventReducer(first, {
      kind: 'settled',
      token: first.token,
      projection: projection('a'),
    });
    expect(sentrySelectedEventReducer(settled, { kind: 'demanded' })).toBe(settled);
  });

  it('publishes only a completion whose key is still the mounted one', () => {
    const loading = demanded();
    const superseded = sentrySelectedEventReducer(loading, {
      kind: 'selected',
      occurrence: { kind: 'event', eventId: 'b'.repeat(32) },
    });

    // The prior read completes late. It described an occurrence nobody is
    // looking at any more, so it is discarded rather than rendered.
    const late = sentrySelectedEventReducer(superseded, {
      kind: 'settled',
      token: loading.token,
      projection: projection('a'.repeat(32)),
    });
    expect(late).toBe(superseded);
    expect(late.read.kind).toBe('idle');
  });

  it('clears the former projection the moment the selection changes', () => {
    const settled = sentrySelectedEventReducer(demanded(), {
      kind: 'settled',
      token: demanded().token,
      projection: projection('a'.repeat(32)),
    });
    expect(settled.read.kind).toBe('success');

    const reselected = sentrySelectedEventReducer(settled, {
      kind: 'selected',
      occurrence: { kind: 'event', eventId: 'b'.repeat(32) },
    });
    // Not "loading with the old body still on screen": the previous occurrence's
    // Tier-B/C content stops existing here, before anything can render it beside
    // a heading that names a different event.
    expect(reselected.read.kind).toBe('idle');
    expect(reselected.selected).toEqual({ kind: 'event', eventId: 'b'.repeat(32) });
  });

  it('treats reselecting the current occurrence as no change at all', () => {
    const settled = sentrySelectedEventReducer(demanded(), {
      kind: 'settled',
      token: demanded().token,
      projection: projection('a'.repeat(32)),
    });

    // Re-activating the row a reader is already on must not throw away a loaded
    // trace and refetch it.
    expect(sentrySelectedEventReducer(settled, {
      kind: 'selected',
      occurrence: { kind: 'representative' },
    })).toBe(settled);
  });

  it('keeps the selection but replaces the body on an explicit refresh', () => {
    const settled = sentrySelectedEventReducer(demanded(), {
      kind: 'settled',
      token: demanded().token,
      projection: projection('a'.repeat(32)),
    });
    const refreshed = sentrySelectedEventReducer(settled, { kind: 'refreshRequested' });

    expect(refreshed.selected).toEqual(settled.selected);
    expect(refreshed.read.kind).toBe('loading');
    expect(refreshed.token).not.toBe(settled.token);
  });

  it('states a failed read as a failure rather than as an issue with no trace', () => {
    const loading = demanded();
    const failed = sentrySelectedEventReducer(loading, {
      kind: 'failed',
      token: loading.token,
      failure: FAILURE,
    });

    expect(failed.read).toEqual({ kind: 'error', failure: FAILURE });
    // A failure is settled: it does not silently re-demand in a loop.
    expect(sentrySelectedEventReducer(failed, { kind: 'demanded' })).toBe(failed);
  });

  it('starts a different entry or instance from nothing', () => {
    const settled = sentrySelectedEventReducer(demanded(), {
      kind: 'settled',
      token: demanded().token,
      projection: projection('a'.repeat(32)),
    });

    const moved = sentrySelectedEventReducer(settled, { kind: 'identityChanged' });
    expect(moved.selected).toEqual({ kind: 'representative' });
    expect(moved.read.kind).toBe('idle');
  });
});
