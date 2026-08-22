import { describe, expect, it } from 'vitest';

import { TRIAGE_SOURCE_SETTINGS_TRANSLATIONS_V1 } from './translations.js';

import {
  TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1,
  UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
  advanceTriageSourceSettingsRowLifecycle,
  describeTriageSourceRemovalConfirmation,
  describeTriageSourceConfiguredRead,
  describeTriageSourceFailure,
  projectTriageSourceSettingsRows,
  readTriageSourceConfiguration,
  readTriageSourceConfiguredInstances,
  readTriageSourceDiscovery,
  type TriageSourceSettingsConfigurationV1,
  type TriageSourceSettingsConfiguredV1,
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
  purpose: 'tracker-connected-account',
  account: Object.freeze({
    service: Object.freeze({ pluginId: 'example.tracker', localId: 'tracker-account' }),
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
        failure: { class: 'rateLimit', code: 'provider-secondary-rate-limit' },
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
          failure: { class: 'authentication', code: 'provider-token-expired' },
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
      result: { kind: 'failed', failure: { class: 'transient', code: 'provider-unreachable' } },
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

  /**
   * One discovered row, projected through the composer the page itself calls.
   * Going through the public entry is what keeps these cases honest: a row's
   * sentence, tone and controls are only ever read from a composed list.
   */
  function project(
    lifecycle: TriageSourceSettingsRowLifecycleV1,
    overrides: Readonly<{
      displayPath?: string;
      outcome?: TriageSourceSettingsConfigurationV1;
    }> = {},
  ) {
    const discovery = readTriageSourceDiscovery({
      status: 'success',
      result: {
        kind: 'complete',
        candidates: [draft('acme/api', overrides.displayPath === undefined
          ? {}
          : { displayPath: overrides.displayPath })],
        failures: [],
      },
    });
    const compose = (
      learned: Readonly<Record<string, TriageSourceSettingsRowLifecycleV1>>,
      outcomes: Readonly<Record<string, TriageSourceSettingsConfigurationV1>>,
    ) => projectTriageSourceSettingsRows({
      discovery,
      configured: { kind: 'read', complete: true, instances: [] },
      outcomes,
      learned,
      sourceDisplayName: 'Example Tracker',
    });
    const [bare] = compose({}, {});
    if (bare === undefined) throw new Error('expected one discovered row');
    const [row] = compose(
      lifecycle.kind === 'unknown' ? {} : { [bare.key]: lifecycle },
      overrides.outcome === undefined ? {} : { [bare.key]: overrides.outcome },
    );
    if (row === undefined) throw new Error('expected one discovered row');
    return row;
  }

  it('drops a locator that only repeats the title', () => {
    // A row that reads `acme/api` twice tells the reader nothing and reads as a
    // rendering fault.
    expect(project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1, { displayPath: 'acme/api' }).locator)
      .toBeNull();
    expect(project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1, { displayPath: 'acme/api/tree' }).locator)
      .toBe('acme/api/tree');
    // A candidate the provider gave no path for falls back to the account it
    // binds, which is the one other thing the reader can recognize.
    expect(project(UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1).locator).toBe('account-1');
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
    const row = project(
      { kind: 'configured', sourceInstanceId: INSTANCE_ID },
      { outcome: { kind: 'configured', sourceInstanceId: INSTANCE_ID } },
    );
    expect(row.status).toBe('Added to PRs & Issues.');
    expect(row.tone).toBe('success');
  });

  it('names the source in the sentence that is about the source', () => {
    const row = project(
      UNKNOWN_TRIAGE_SOURCE_SETTINGS_ROW_LIFECYCLE_V1,
      { outcome: { kind: 'sourceNotAdmitted' } },
    );
    expect(row.status).toBe('Example Tracker is no longer an admitted PRs & Issues source on this account.');
    expect(row.tone).toBe('danger');
    // A refused configuration leaves the row exactly where it was.
    expect(row.controls.map((control) => control.id)).toEqual(['add']);
  });

  it('states what removal costs rather than implying it discards the user own state', () => {
    const row = project(
      { kind: 'retired', sourceInstanceId: INSTANCE_ID },
      { outcome: { kind: 'removed', sourceInstanceId: INSTANCE_ID } },
    );
    expect(row.status).toBe(
      'Removed from PRs & Issues. Its entries leave the list; the pins and Session links you made stay.',
    );
  });
});

describe('the configured-instance read', () => {
  const ID_A = '11111111-1111-4111-8111-111111111111';
  const ID_B = '22222222-2222-4222-8222-222222222222';
  const SOURCE = Object.freeze({ pluginId: 'example.tracker', localId: 'tracker' });

  function record(
    localInstanceKey: string,
    lifecycle: 'active' | 'retired',
    sourceInstanceId: string,
    overrides: Readonly<{ locator?: false | Readonly<{ displayPath?: string }> }> = {},
  ) {
    return {
      v: 1 as const,
      lifecycle,
      configured: {
        v: 1 as const,
        instance: { source: SOURCE, sourceInstanceId },
        binding: BINDING,
        localInstanceKey,
        configuration: { v: 1 as const, token: `token:${localInstanceKey}` },
        ...(overrides.locator === false ? {} : {
          locator: {
            v: 1 as const,
            displayLabel: localInstanceKey,
            ...(overrides.locator?.displayPath === undefined
              ? {}
              : { displayPath: overrides.locator.displayPath }),
          },
        }),
      },
    };
  }

  function configuredFrom(...instances: readonly ReturnType<typeof record>[]) {
    return readTriageSourceConfiguredInstances({
      status: 'success',
      result: { kind: 'read', status: 'complete', instances },
    });
  }

  function listing(
    kind: 'complete' | 'incomplete',
    ...keys: readonly string[]
  ) {
    return readTriageSourceDiscovery({
      status: 'success',
      result: {
        kind,
        candidates: keys.map((key) => draft(key)),
        failures: [],
        ...(kind === 'incomplete'
          ? { failure: { class: 'rateLimit', code: 'provider-secondary-rate-limit' } }
          : {}),
      },
    });
  }

  function rows(input: Readonly<{
    discovery?: ReturnType<typeof readTriageSourceDiscovery>;
    configured?: TriageSourceSettingsConfiguredV1;
    outcomes?: Readonly<Record<string, TriageSourceSettingsConfigurationV1>>;
    learned?: Readonly<Record<string, TriageSourceSettingsRowLifecycleV1>>;
  }>) {
    return projectTriageSourceSettingsRows({
      discovery: input.discovery ?? listing('complete'),
      configured: input.configured ?? configuredFrom(),
      outcomes: input.outcomes ?? {},
      learned: input.learned ?? {},
      sourceDisplayName: 'Example Tracker',
    });
  }

  it('seeds a discovered row from the target answer, on the key discovery already uses', () => {
    // This is the whole unit: without it every mount starts at `unknown`, so
    // Update, Remove and Restore are unreachable for anything the user did not
    // configure in this same visit. It only works because both reads project the
    // same identity tuple onto the same row key — a second spelling would put a
    // second row beside the one already configured.
    const projected = rows({
      discovery: listing('complete', 'acme/api'),
      configured: configuredFrom(record('acme/api', 'active', ID_A)),
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.controls.map((control) => control.id)).toEqual(['reconfigure', 'remove']);
    expect(projected[0]?.sourceInstanceId).toBe(ID_A);
    expect(projected[0]?.status).toBe('In PRs & Issues.');
    expect(projected[0]?.draft).toMatchObject({ localInstanceKey: 'acme/api' });
  });

  it('offers Restore under the exact ref the target named, never a second Add', () => {
    const projected = rows({
      discovery: listing('complete', 'acme/api'),
      configured: configuredFrom(record('acme/api', 'retired', ID_A)),
    });

    // Add here would ask the target to mint a sibling row for one intent, which
    // it refuses with `conflict` — the dead end this read exists to remove.
    expect(projected[0]?.controls.map((control) => control.id)).toEqual(['restore']);
    expect(projected[0]?.sourceInstanceId).toBe(ID_A);
    expect(projected[0]?.status).toBe('Removed from PRs & Issues.');
  });

  it('lets a successful press win over the read it followed', () => {
    const projected = rows({
      discovery: listing('complete', 'acme/api'),
      configured: configuredFrom(record('acme/api', 'active', ID_A)),
      learned: { [projected0Key()]: { kind: 'retired', sourceInstanceId: ID_A } },
    });

    expect(projected[0]?.controls.map((control) => control.id)).toEqual(['restore']);
  });

  it('leaves the target answer standing when a press taught nothing', () => {
    // A `conflict` says the target refused; it does not say what the row is. A
    // page that recorded it as knowledge would keep offering Add forever.
    const projected = rows({
      discovery: listing('complete', 'acme/api'),
      configured: configuredFrom(record('acme/api', 'retired', ID_A)),
      outcomes: { [projected0Key()]: { kind: 'conflict' } },
    });

    expect(projected[0]?.controls.map((control) => control.id)).toEqual(['restore']);
    expect(projected[0]?.status).toBe('You removed this earlier. This page cannot bring it back yet.');
  });

  it('lists a configured instance this source can no longer reach, with the arm that still works', () => {
    const projected = rows({
      discovery: listing('complete', 'acme/api'),
      configured: configuredFrom(
        record('acme/api', 'active', ID_A),
        record('acme/legacy', 'active', ID_B),
      ),
    });

    // Dropping it would leave a person with entries that never arrive and no way
    // to remove the source producing them.
    expect(projected.map((row) => row.title)).toEqual(['acme/api', 'acme/legacy']);
    const unreachable = projected[1];
    expect(unreachable?.controls.map((control) => control.id)).toEqual(['remove']);
    expect(unreachable?.draft).toBeNull();
    expect(unreachable?.sourceInstanceId).toBe(ID_B);
    expect(unreachable?.tone).toBe('warning');
    expect(unreachable?.status).toBe(
      'In PRs & Issues, but Example Tracker can no longer reach it. Its entries stop arriving until the account or scope comes back.',
    );
  });

  it('never calls an instance unreachable on the strength of an incomplete listing', () => {
    const projected = rows({
      discovery: listing('incomplete', 'acme/api'),
      configured: configuredFrom(
        record('acme/api', 'active', ID_A),
        record('acme/legacy', 'active', ID_B),
      ),
    });

    // Absence from a listing that did not finish is not evidence, and telling a
    // user to remove a working source is the mistake that distinction prevents.
    expect(projected[1]?.status).toBe(
      'In PRs & Issues. This page could not list it just now, so it may still be working.',
    );
    expect(projected[1]?.tone).toBe('neutral');
    expect(projected[1]?.controls.map((control) => control.id)).toEqual(['remove']);
  });

  it('still lists what is configured when discovery failed outright', () => {
    const projected = rows({
      discovery: readTriageSourceDiscovery({
        status: 'success',
        result: { kind: 'failed', failure: { class: 'authentication', code: 'x' } },
      }),
      configured: configuredFrom(record('acme/api', 'active', ID_A)),
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]?.controls.map((control) => control.id)).toEqual(['remove']);
  });

  it('keeps a removed unreachable instance out of the list unless the user just removed it', () => {
    const configured = configuredFrom(record('acme/legacy', 'retired', ID_B));
    // Retired rows are never deleted, so listing every unreachable one would grow
    // a permanent column of rows with no control on it.
    expect(rows({ configured })).toEqual([]);

    const justRemoved = rows({
      configured,
      outcomes: { [legacyKey()]: { kind: 'removed', sourceInstanceId: ID_B } },
      learned: { [legacyKey()]: { kind: 'retired', sourceInstanceId: ID_B } },
    });
    expect(justRemoved).toHaveLength(1);
    expect(justRemoved[0]?.status).toBe(
      'Removed from PRs & Issues. Its entries leave the list; the pins and Session links you made stay.',
    );
    expect(justRemoved[0]?.controls).toEqual([]);
  });

  it('falls back to what a stored record does carry when it has no locator', () => {
    const projected = rows({
      configured: configuredFrom(record('acme/legacy', 'active', ID_B, { locator: false })),
    });

    expect(projected[0]?.title).toBe('acme/legacy');
    expect(projected[0]?.locator).toBe('account-1');
  });

  it('reports every refusal as its own settled answer rather than an empty set', () => {
    expect(readTriageSourceConfiguredInstances({
      status: 'success',
      result: { kind: 'invalidCaller' },
    })).toEqual({ kind: 'sourceNotAdmitted' });
    expect(readTriageSourceConfiguredInstances({
      status: 'success',
      result: { kind: 'currentnessConflict' },
    })).toEqual({ kind: 'raced' });
    expect(readTriageSourceConfiguredInstances({ status: 'success', result: { kind: 'read' } }))
      .toEqual({ kind: 'unreadable' });
    expect(readTriageSourceConfiguredInstances({ status: 'pending' })).toEqual({ kind: 'loading' });
    expect(readTriageSourceConfiguredInstances({
      status: 'error',
      code: 'plugin_action_failed',
      message: 'No machine answered.',
      retryable: true,
    })).toEqual({ kind: 'unreachable', message: 'No machine answered.' });
    expect(readTriageSourceConfiguredInstances({
      status: 'outcomeUnknown',
      code: 'timeout',
      message: 'x',
    })).toEqual({ kind: 'outcomeUnknown' });
  });

  it('reports a truncated read as truncated rather than as the whole set', () => {
    const configured = readTriageSourceConfiguredInstances({
      status: 'success',
      result: {
        kind: 'read',
        status: 'truncated',
        instances: [record('acme/api', 'active', ID_A)],
      },
    });

    expect(configured).toMatchObject({ kind: 'read', complete: false });
    expect(describeTriageSourceConfiguredRead(configured, 'Example Tracker')).toMatchObject({
      tone: 'warning',
    });
  });

  it('says nothing when it knows exactly what is configured, and says what it cannot', () => {
    expect(describeTriageSourceConfiguredRead(configuredFrom(), 'Example Tracker')).toBeNull();
    // A mount that is still reading is already showing that it is reading.
    expect(describeTriageSourceConfiguredRead({ kind: 'loading' }, 'Example Tracker')).toBeNull();

    const notices = (['unreadable', 'outcomeUnknown', 'sourceNotAdmitted', 'raced'] as const)
      .map((kind) => describeTriageSourceConfiguredRead({ kind }, 'Example Tracker'));
    expect(notices.every((notice) => notice !== null)).toBe(true);
    expect(new Set(notices.map((notice) => notice?.title)).size).toBe(4);
    expect(describeTriageSourceConfiguredRead({ kind: 'unreachable', message: 'Denied.' }, 'Example Tracker'))
      .toMatchObject({ tone: 'warning' });
  });

  function projected0Key(): string {
    const [row] = rows({ discovery: listing('complete', 'acme/api') });
    if (row === undefined) throw new Error('expected one discovered row');
    return row.key;
  }

  function legacyKey(): string {
    const [row] = rows({
      configured: configuredFrom(record('acme/legacy', 'active', ID_B)),
    });
    if (row === undefined) throw new Error('expected one configured row');
    return row.key;
  }
});

describe('the source failure sentence', () => {
  const CLASSES = [
    'authentication',
    'permission',
    'rateLimit',
    'transient',
    'unsupportedContract',
    'unknown',
  ] as const;

  it('quotes the bounded detail the source sent alongside the class remedy, never instead of it', () => {
    // The source knows which repository, project or account could not be read
    // and this page does not, which is exactly why the list shell quotes the
    // same field. A page that answered "the connected account cannot see this
    // scope" while the source said which scope throws away the only fact the
    // reader can act on.
    // The fixture is a REAL producer shape, not a ready-made sentence. Azure
    // DevOps emits `readErrorMessage(error)` verbatim
    // (scm-azure-devops/src/triage/failures.ts:99,192-193), so `detail` is
    // routinely a bare `fetch failed`. A page that SUBSTITUTES that for the
    // class sentence throws away the remedy — which is the only reason this
    // table exists — and renders untranslated on all 11 locales. It must be
    // additive: the remedy stays, the source's words name what failed.
    // Asserted against the function's OWN detail-free answer rather than a copy
    // literal: this pins the additive CONTRACT without policing wording.
    const permissionRemedy = describeTriageSourceFailure({
      class: 'permission',
      code: 'scope_not_visible',
    });
    const permission = describeTriageSourceFailure({
      class: 'permission',
      code: 'scope_not_visible',
      detail: 'acme/api is not visible to this installation.',
    });
    expect(permission).toContain('acme/api is not visible to this installation.');
    expect(permission).toContain(permissionRemedy);

    const transientRemedy = describeTriageSourceFailure({ class: 'transient', code: 'unreachable' });
    const transient = describeTriageSourceFailure({
      class: 'transient',
      code: 'unreachable',
      detail: 'fetch failed',
    });
    expect(transient).toContain('fetch failed');
    expect(transient).toContain(transientRemedy);
    expect(transient).not.toBe('fetch failed');
  });

  it('never routes the source own words through the translation catalogue', () => {
    // Provider words arrive already written; there is no key for them.
    const composed = describeTriageSourceFailure(
      { class: 'transient', code: 'unreachable', detail: 'gitlab.example could not be reached.' },
      (key) => `translated:${key}`,
    );
    // The provider's words survive verbatim...
    expect(composed).toContain('gitlab.example could not be reached.');
    // ...while the class sentence beside them still goes through the resolver.
    expect(composed).toContain('translated:');
  });

  it('resolves every class sentence through the caller text resolver', () => {
    // Six hard-coded English sentences render untranslated on every locale for
    // all six sources, and nothing fails when they do.
    const asked: string[] = [];
    const sentences = CLASSES.map((failureClass) => describeTriageSourceFailure(
      { class: failureClass, code: 'x' },
      (key) => {
        asked.push(key);
        return `translated:${key}`;
      },
    ));

    expect(new Set(asked).size).toBe(6);
    expect(new Set(sentences).size).toBe(6);
    expect(sentences.every((sentence) => sentence.startsWith('translated:'))).toBe(true);
  });

  it('keeps its own keys rather than borrowing the list shell predicates', () => {
    // The list suffixes a predicate to a connection name; this page states the
    // fix the reader came here to make. One key namespace for both would put
    // one of the two wrong sentences on both surfaces.
    const keys = CLASSES.map((failureClass) => describeTriageSourceFailure(
      { class: failureClass, code: 'x' },
      (key) => key,
    ));

    expect(keys).toEqual(CLASSES.map(
      (failureClass) => `plugins.triage.sourceSettings.failure.${failureClass}`,
    ));
  });

  it('carries every declared sentence in every locale the sources declare', () => {
    // A key with no bundle entry renders its English fallback on that locale and
    // nothing fails, which is exactly how six hard-coded sentences survived.
    // Every key this page can resolve is derived from the describers themselves,
    // so a sentence added to one and forgotten in the bundle fails here.
    const keys = [
      ...CLASSES.map((failureClass) => describeTriageSourceFailure(
        { class: failureClass, code: 'x' },
        (key) => key,
      )),
      ...Object.values(TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1),
    ].sort();
    const locales = Object.keys(TRIAGE_SOURCE_SETTINGS_TRANSLATIONS_V1);

    expect(locales).toEqual([
      'en', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja',
    ]);
    for (const locale of locales) {
      const bundle = TRIAGE_SOURCE_SETTINGS_TRANSLATIONS_V1[
        locale as keyof typeof TRIAGE_SOURCE_SETTINGS_TRANSLATIONS_V1
      ];
      expect(Object.keys(bundle).sort()).toEqual(keys);
      expect(Object.values(bundle).every((sentence) => sentence.trim().length > 0)).toBe(true);
    }
  });

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

describe('the source removal question', () => {
  it('names the exact row and both halves of what removal costs', () => {
    const question = describeTriageSourceRemovalConfirmation({
      rowTitle: 'acme/api',
      sourceDisplayName: 'Example Tracker',
    });

    expect(question.title).toBe('Remove acme/api from PRs & Issues?');
    // The source alone is not enough: a person with several scopes configured
    // from one account is choosing between rows, not between sources.
    expect(question.message).toContain('acme/api');
    expect(question.message).toContain('Example Tracker');
    // Entries go, commitments stay. Either half alone misleads — "entries leave"
    // on its own reads as losing the pins too.
    expect(question.message).toContain('Its entries leave the list');
    expect(question.message).toContain('pins and Session links you made stay');
  });

  it('resolves through the reader own bundle rather than a hard-coded sentence', () => {
    const question = describeTriageSourceRemovalConfirmation(
      { rowTitle: 'acme/api', sourceDisplayName: 'Example Tracker' },
      (key, _fallback, values) => `${key}|${String(values?.scope)}|${String(values?.source)}`,
    );

    expect(question.title).toBe(
      `${TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1.title}|acme/api|Example Tracker`,
    );
    expect(question.message).toBe(
      `${TRIAGE_SOURCE_REMOVAL_CONFIRMATION_TRANSLATION_KEYS_V1.message}|acme/api|Example Tracker`,
    );
  });
});
