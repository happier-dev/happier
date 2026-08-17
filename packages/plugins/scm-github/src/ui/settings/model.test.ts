import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
  advanceTriageSourceSettingsRowLifecycle,
  describeTriageSourceFailure,
  projectTriageSourceSettingsRow,
  readTriageSourceConfiguration,
  readTriageSourceDiscovery,
  type TriageSourceSettingsCandidateV1,
  type TriageSourceSettingsRowLifecycleV1,
} from './model.js';

/**
 * The settings model is the only thing standing between a published result and
 * what the user is told about their own configuration, so each case here is a
 * pair the page must not collapse: complete vs incomplete enumeration, a
 * created instance vs one that already existed, a source that is no longer
 * admitted vs a provider that failed, and a definite failure vs an outcome
 * nobody knows.
 */

const BINDING = Object.freeze({
  purpose: 'github-connected-account',
  account: Object.freeze({
    service: Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github-account' }),
    accountId: 'account-1',
  }),
});

function draft(localInstanceKey: string, overrides: Readonly<{
  keyStability?: 'stable' | 'locatorDerived';
  displayPath?: string;
}> = {}) {
  return {
    v: 1 as const,
    binding: BINDING,
    localInstanceKey,
    keyStability: overrides.keyStability ?? 'stable',
    configuration: { v: 1 as const, token: `token:${localInstanceKey}` },
    locator: {
      v: 1 as const,
      displayLabel: localInstanceKey,
      ...(overrides.displayPath === undefined ? {} : { displayPath: overrides.displayPath }),
    },
  };
}

describe('the source settings discovery model', () => {
  it('renders rows for a complete listing and reports it as complete', () => {
    const state = readTriageSourceDiscovery({
      status: 'success',
      result: { kind: 'complete', candidates: [draft('acme/api')], failures: [] },
    });

    expect(state).toMatchObject({ kind: 'listed', complete: true });
    if (state.kind !== 'listed') throw new Error('expected a listed discovery state');
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0]).toMatchObject({
      label: 'acme/api',
      accountId: 'account-1',
      keyFollowsProviderName: false,
    });
  });

  it('keeps an incomplete listing distinguishable from a complete one', () => {
    const state = readTriageSourceDiscovery({
      status: 'success',
      result: {
        kind: 'incomplete',
        candidates: [draft('acme/api')],
        failures: [],
        failure: { class: 'rateLimit', code: 'github-secondary-rate-limit' },
      },
    });

    // A short list rendered as complete is how a user concludes an account was
    // removed at the provider.
    expect(state).toMatchObject({ kind: 'listed', complete: false });
    if (state.kind !== 'listed') throw new Error('expected a listed discovery state');
    expect(state.listingFailure).toMatchObject({ class: 'rateLimit' });
  });

  it('carries each exact-binding failure with the account it concerns', () => {
    const state = readTriageSourceDiscovery({
      status: 'success',
      result: {
        kind: 'complete',
        candidates: [],
        failures: [{
          binding: BINDING,
          localInstanceKey: 'acme/legacy',
          failure: { class: 'authentication', code: 'github-token-expired' },
        }],
      },
    });

    if (state.kind !== 'listed') throw new Error('expected a listed discovery state');
    expect(state.failures[0]).toMatchObject({
      accountId: 'account-1',
      localInstanceKey: 'acme/legacy',
      failure: { class: 'authentication' },
    });
  });

  it('reports a failed listing as unreachable rather than as an empty list', () => {
    const state = readTriageSourceDiscovery({
      status: 'success',
      result: { kind: 'failed', failure: { class: 'transient', code: 'github-unreachable' } },
    });

    expect(state).toMatchObject({ kind: 'unreachable', failure: { class: 'transient' } });
  });

  it('refuses a result that does not admit through the published schema', () => {
    expect(readTriageSourceDiscovery({ status: 'success', result: { kind: 'complete' } }))
      .toEqual({ kind: 'unreadable' });
  });

  it('separates a definite dispatch failure from an unknown outcome', () => {
    expect(readTriageSourceDiscovery({
      status: 'error',
      code: 'plugin_action_failed',
      message: 'The daemon is unavailable.',
      retryable: true,
    })).toEqual({ kind: 'unreachable', failure: null, message: 'The daemon is unavailable.' });
    expect(readTriageSourceDiscovery({ status: 'outcomeUnknown', code: 'timeout', message: 'x' }))
      .toEqual({ kind: 'outcomeUnknown' });
  });

  it('says when a candidate key follows the provider display name', () => {
    const state = readTriageSourceDiscovery({
      status: 'success',
      result: {
        kind: 'complete',
        candidates: [draft('acme/api', { keyStability: 'locatorDerived' })],
        failures: [],
      },
    });

    if (state.kind !== 'listed') throw new Error('expected a listed discovery state');
    expect(state.candidates[0]?.keyFollowsProviderName).toBe(true);
  });
});

describe('the source settings configuration model', () => {
  it('distinguishes a newly configured instance from one that already existed', () => {
    expect(readTriageSourceConfiguration({
      status: 'success',
      result: { kind: 'active', sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
    })).toEqual({ kind: 'configured', sourceInstanceId: '11111111-1111-4111-8111-111111111111' });
    expect(readTriageSourceConfiguration({
      status: 'success',
      result: { kind: 'reused', sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
    })).toEqual({
      kind: 'alreadyConfigured',
      sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('keeps the three published failure arms apart', () => {
    expect(readTriageSourceConfiguration({ status: 'success', result: { kind: 'invalidCaller' } }))
      .toEqual({ kind: 'sourceNotAdmitted' });
    expect(readTriageSourceConfiguration({
      status: 'success',
      result: { kind: 'currentnessConflict' },
    })).toEqual({ kind: 'raced' });
    expect(readTriageSourceConfiguration({ status: 'success', result: { kind: 'conflict' } }))
      .toEqual({ kind: 'conflict' });
    // A full configured set is resolved only by removing a connection, so it
    // must not read as a conflict the user could resolve by trying again.
    expect(readTriageSourceConfiguration({ status: 'success', result: { kind: 'atMaximum' } }))
      .toEqual({ kind: 'atMaximum' });
  });

  it('never treats an unknown outcome as a failure the user may simply retry', () => {
    expect(readTriageSourceConfiguration({
      status: 'outcomeUnknown',
      code: 'timeout',
      message: 'The request timed out.',
    })).toEqual({ kind: 'outcomeUnknown', message: 'The request timed out.' });
    expect(readTriageSourceConfiguration({
      status: 'error',
      code: 'denied',
      message: 'Denied.',
      retryable: false,
    })).toEqual({ kind: 'failed', message: 'Denied.', retryable: false });
  });

  it('refuses an administration result that does not admit', () => {
    expect(readTriageSourceConfiguration({ status: 'success', result: { kind: 'active' } }))
      .toEqual({ kind: 'unreadable' });
  });
});

describe('what a row may claim about itself', () => {
  const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

  it('learns a row only from a success arm the target actually returned', () => {
    const created = advanceTriageSourceSettingsRowLifecycle(
      UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
      { kind: 'configured', sourceInstanceId: INSTANCE_ID },
    );
    expect(created).toEqual({ kind: 'configured', sourceInstanceId: INSTANCE_ID });
    expect(advanceTriageSourceSettingsRowLifecycle(created, {
      kind: 'removed',
      sourceInstanceId: INSTANCE_ID,
    })).toEqual({ kind: 'retired', sourceInstanceId: INSTANCE_ID });
    // A row that already existed is still a row this page may now administer.
    expect(advanceTriageSourceSettingsRowLifecycle(
      UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
      { kind: 'alreadyConfigured', sourceInstanceId: INSTANCE_ID },
    )).toEqual({ kind: 'configured', sourceInstanceId: INSTANCE_ID });
  });

  it('leaves what it knows untouched when the target did not say', () => {
    // None of these tells us whether a row exists. Inventing an answer is what
    // would put Remove on a row the target never created.
    for (const outcome of [
      { kind: 'conflict' },
      { kind: 'raced' },
      { kind: 'atMaximum' },
      { kind: 'sourceNotAdmitted' },
      { kind: 'unreadable' },
      { kind: 'outcomeUnknown', message: 'timed out' },
      { kind: 'failed', message: 'denied', retryable: false },
    ] as const) {
      expect(advanceTriageSourceSettingsRowLifecycle(
        UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
        outcome,
      )).toEqual({ kind: 'unknown' });
      expect(advanceTriageSourceSettingsRowLifecycle(
        { kind: 'configured', sourceInstanceId: INSTANCE_ID },
        outcome,
      )).toEqual({ kind: 'configured', sourceInstanceId: INSTANCE_ID });
    }
  });
});

describe('the candidate row projection', () => {
  const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

  function candidate(overrides: Partial<TriageSourceSettingsCandidateV1> = {}): TriageSourceSettingsCandidateV1 {
    return {
      key: 'row-key',
      draft: draft('acme/api'),
      label: 'acme/api',
      path: 'acme/api',
      accountId: 'account-1',
      keyFollowsProviderName: false,
      ...overrides,
    };
  }

  function project(
    lifecycle: TriageSourceSettingsRowLifecycleV1,
    overrides: Partial<TriageSourceSettingsCandidateV1> = {},
  ) {
    return projectTriageSourceSettingsRow({
      candidate: candidate(overrides),
      lifecycle,
      sourceDisplayName: 'GitHub',
    });
  }

  it('drops a locator that only repeats the title', () => {
    // A row that reads `acme/api` twice tells the reader nothing and reads as a
    // rendering fault.
    expect(project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1).locator).toBeNull();
    expect(project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1, { path: 'acme/api/tree' }).locator)
      .toBe('acme/api/tree');
    // No display path at all falls back to the account, and that fallback is
    // dropped on the same rule.
    expect(project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1, { path: null }).locator)
      .toBe('account-1');
  });

  it('says nothing about a row it has never been told about', () => {
    const row = project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1);
    // Not "not added": this page cannot read a configured row it did not write.
    expect(row.status).toBeNull();
    expect(row.sourceInstanceId).toBeNull();
    expect(row.controls.map((control) => control.id)).toEqual(['add']);
  });

  it('offers the exact-row arms only once the target has named the row', () => {
    const configured = project({ kind: 'configured', sourceInstanceId: INSTANCE_ID });
    expect(configured.sourceInstanceId).toBe(INSTANCE_ID);
    expect(configured.controls.map((control) => control.id)).toEqual(['reconfigure', 'remove']);
    expect(configured.status).toBe('In PRs & Issues.');

    // Restore is the only arm that may revive a retired row, so a retired row
    // must not also offer Add: that would ask for a second row for one intent.
    const retired = project({ kind: 'retired', sourceInstanceId: INSTANCE_ID });
    expect(retired.controls.map((control) => control.id)).toEqual(['restore']);
  });

  it('lets the answer the user just caused win over the standing state', () => {
    const row = projectTriageSourceSettingsRow({
      candidate: candidate(),
      lifecycle: { kind: 'configured', sourceInstanceId: INSTANCE_ID },
      outcome: { kind: 'configured', sourceInstanceId: INSTANCE_ID },
      sourceDisplayName: 'GitHub',
    });
    expect(row.status).toBe('Added to PRs & Issues.');
    expect(row.tone).toBe('success');
  });

  it('names the source in the sentence that is about the source', () => {
    const row = projectTriageSourceSettingsRow({
      candidate: candidate(),
      lifecycle: UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
      outcome: { kind: 'sourceNotAdmitted' },
      sourceDisplayName: 'GitHub',
    });
    expect(row.status).toBe('GitHub is no longer an admitted PRs & Issues source on this account.');
    expect(row.tone).toBe('danger');
    // A refused configuration leaves the row exactly where it was.
    expect(row.controls.map((control) => control.id)).toEqual(['add']);
  });

  it('states what removal costs rather than implying it discards the user own state', () => {
    const row = projectTriageSourceSettingsRow({
      candidate: candidate(),
      lifecycle: { kind: 'retired', sourceInstanceId: INSTANCE_ID },
      outcome: { kind: 'removed', sourceInstanceId: INSTANCE_ID },
      sourceDisplayName: 'GitHub',
    });
    expect(row.status).toBe(
      'Removed from PRs & Issues. Its entries leave the list; the pins and Session links you made stay.',
    );
  });
});

describe('the source failure sentence', () => {
  it('gives each class its own remedy rather than one generic line', () => {
    const sentences = new Set([
      describeTriageSourceFailure({ class: 'authentication', code: 'a' }),
      describeTriageSourceFailure({ class: 'permission', code: 'b' }),
      describeTriageSourceFailure({ class: 'rateLimit', code: 'c' }),
      describeTriageSourceFailure({ class: 'transient', code: 'd' }),
      describeTriageSourceFailure({ class: 'unsupportedContract', code: 'e' }),
      describeTriageSourceFailure({ class: 'unknown', code: 'f' }),
    ]);
    expect(sentences.size).toBe(6);
  });
});
