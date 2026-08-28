// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID } from '../sentryContracts.js';

import { renderSurface } from './renderSurface.js';
import { SENTRY_UI_TRANSLATIONS } from './translations.js';

/**
 * The Sentry detail body, mounted the way the host mounts it.
 *
 * Nothing between the tab strip and the source's own Actions is stood in for: the surface
 * reaches them through the SDK's own mounted Host API client, and every response here is
 * a real provider-shaped body that the source's read path projects. That is the whole
 * point of these cases — the rules this file checks are lifetime rules, and a test that
 * imports a reducer proves the reducer, not that the mounted composition obeys it.
 *
 * Three of them are the ones that would fail silently:
 *
 * - opening a detail must not cost an event body (`SENTRY.md` §7.2a "no prefetch");
 * - three consumers of one selected projection must not become three reads; and
 * - a Stack Trace tab must be absent, not empty, when the occurrence has no trace.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INSTANCE = {
  v: 1,
  instance: {
    source: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-issues' },
    sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
  },
  binding: {
    purpose: 'sentry-account-use',
    account: {
      service: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-account' },
      accountId: 'account-1',
    },
  },
  localInstanceKey: 'https://us.sentry.io42',
  configuration: { v: 1, token: 'sentry-configuration-token-v1' },
  locator: { v: 1, displayLabel: 'acme-org' },
} as const;

const DETAIL_INPUT = TriageDetailSurfaceInputV1Schema.parse({
  v: 1,
  instance: INSTANCE,
  observation: {
    entryRef: {
      source: INSTANCE.instance.source,
      kindId: 'error-issue',
      collisionScope: 'https://us.sentry.io42',
      entryId: '1234',
    },
    observedAtMs: 1_760_000_700_000,
    locator: {
      v: 1,
      webUrl: 'https://us.sentry.io/organizations/acme-org/issues/1234/',
      displayPath: 'acme-org/checkout · ACME-42',
    },
    snapshot: {
      v: 1,
      title: 'ChargeDeclined: card was declined',
      scopeLabel: 'acme-org/checkout',
      state: { presentation: 'active', nativeLabel: 'Unresolved' },
      facts: [],
    },
    viewer: { involvement: [] },
  },
  linkedSessions: [],
});

const ISSUE_BODY: JsonValue = {
  kind: 'overview',
  statePresentation: 'active',
  nativeStateLabel: 'Unresolved',
  eventCount: '4021',
};

const TAGS_BODY: JsonValue = {
  kind: 'tags',
  tags: [],
  omittedTagCount: 0,
  projectionTruncated: false,
};

const ACTIVITY_BODY: JsonValue = {
  kind: 'activity',
  activity: {
    status: 'available',
    items: [],
    malformedItemCount: 0,
    omittedItemCount: 0,
    projectionTruncated: false,
  },
};

function eventProjection(overrides: Readonly<Record<string, JsonValue>> = {}): JsonValue {
  return {
    kind: 'event',
    projection: {
      eventId: 'a'.repeat(32),
      dateCreatedMs: 1_760_000_000_000,
      title: 'ChargeDeclined',
      message: 'card was declined',
      location: null,
      culprit: null,
      platform: 'javascript',
      sections: [{
        kind: 'exception',
        type: 'ChargeDeclined',
        value: 'card was declined',
        frames: [{
          filename: 'app/checkout.ts',
          function: 'submitOrder',
          lineNo: 42,
          colNo: 7,
          inApp: true,
          contextLine: 'await charge(card, total);',
          vars: {},
        }],
      }],
      tags: [],
      user: null,
      redactions: [],
      sensitivePaths: [],
      projectionTruncated: false,
      omitted: {
        sections: 0,
        frames: 0,
        breadcrumbs: 0,
        tags: 0,
        redactions: 0,
        sensitivePaths: 0,
      },
      ...overrides,
    },
  };
}

/** A performance issue: a real occurrence that simply carries no trace. */
const TRACELESS_EVENT: JsonValue = eventProjection({
  sections: [{ kind: 'message', formatted: 'slow checkout render' }],
});

type Invocation = Readonly<{ localId: string; input: unknown }>;

function createHarness(options: Readonly<{
  event?: JsonValue;
  eventSequence?: readonly JsonValue[];
  events?: JsonValue;
  tags?: JsonValue;
}> = {}) {
  const invocations: Invocation[] = [];

  async function executeAction(
    { action, input }: Readonly<{ action: unknown; input: unknown }>,
  ): Promise<JsonValue> {
    const ref = action as Readonly<{ localId?: string }>;
    const localId = ref.localId ?? '';
    invocations.push({ localId, input });
    if (localId === SENTRY_ACTION_IDS.readIssue) {
      const projection = (input as Readonly<{ projection?: string }>).projection;
      if (projection === 'tags') return options.tags ?? TAGS_BODY;
      if (projection === 'activity') return ACTIVITY_BODY;
      return ISSUE_BODY;
    }
    if (localId === SENTRY_ACTION_IDS.listIssueEvents) {
      return options.events ?? {
        kind: 'events',
        rows: [
          { eventId: 'b'.repeat(32), headline: 'card was declined', atMs: 1_760_000_100_000 },
        ],
        omittedRowCount: 0,
        projectionTruncated: false,
      };
    }
    if (localId === SENTRY_ACTION_IDS.readEvent) {
      const readIndex = invocations.filter(
        (entry) => entry.localId === SENTRY_ACTION_IDS.readEvent,
      ).length - 1;
      return options.eventSequence?.[readIndex] ?? options.event ?? eventProjection();
    }
    if (localId === SENTRY_ACTION_IDS.listTagValues) {
      return {
        kind: 'tagValues',
        tagKey: 'url',
        rows: [],
        omittedRowCount: 0,
        projectionTruncated: false,
      };
    }
    throw new Error(`unexpected action ${localId}`);
  }

  return {
    invocations,
    executeAction,
    countOf(localId: string): number {
      return invocations.filter((entry) => entry.localId === localId).length;
    },
  };
}

const mounted: PluginUiTestkit[] = [];

async function mountDetail(
  harness: ReturnType<typeof createHarness>,
  surfaceContext = createSurfaceContextFixture(),
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: SENTRY_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'sentry-detail',
        generation: 'sentry-detail-mount',
      },
      surface: renderSurface,
      surfaceContext,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: DETAIL_INPUT as unknown as JsonValue,
      handlers: {
        executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

async function selectTab(page: PluginUiTestkit, name: string): Promise<void> {
  await act(async () => {
    await page.press(await page.getByRole('tab', { name }));
  });
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Sentry issue detail body', () => {
  it('reads one occurrence because Overview asked, and reads it once', async () => {
    const harness = createHarness();
    const page = await mountDetail(harness);

    // Overview is the default tab and demands the representative occurrence, so
    // exactly one event read exists — and it names Sentry's own word for the
    // selection rather than calling it the latest event.
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);
    expect(harness.invocations.find((entry) => entry.localId === SENTRY_ACTION_IDS.readEvent)?.input)
      .toMatchObject({ selector: { kind: 'representative' } });
    await expect(page.getByText('ChargeDeclined: card was declined')).resolves.toBeDefined();
  });

  it('discloses a provider-scrubbed value on the default tab, not only inside the panels', async () => {
    const harness = createHarness({
      event: eventProjection({
        redactions: [{ path: 'exception.values.0.value', reason: 'providerScrubbed' }],
      }),
    });
    const page = await mountDetail(harness);

    // Overview is the DEFAULT tab and renders the exception value itself. The
    // other two Tier-B/C regions already carry this notice, and
    // `RedactionNotice`'s own doc calls it "the redaction disclosure every
    // Tier-B/C region owes its reader" (`SENTRY.md` §8.2). Without it here a
    // reader sees a value this organization's own Sentry rules already scrubbed
    // with nothing on screen saying so — indistinguishable from a value that
    // was never touched.
    await expect(page.getByText('Sentry redacted some values')).resolves.toBeDefined();
  });

  it('keeps every issue tag and discloses that their values are unclassified', async () => {
    const harness = createHarness({
      tags: {
        kind: 'tags',
        tags: [{
          key: 'checkout_session',
          name: 'checkout_session',
          totalValues: 3,
          topValues: [{ value: 'sess_9f3a1c', count: 12 }],
        }],
        omittedTagCount: 0,
        projectionTruncated: false,
      },
    });
    const page = await mountDetail(harness);

    // The gate on this plane is `isSentryRoutableTagKey`, a path-segment safety
    // test — not a privacy allow-list — and the row subtitle and drill-down both
    // render the tag's VALUE. Keeping the customer's own key is the product
    // decision (`SENTRY.md` §7.3a): applying the event allow-list here would
    // delete the custom-tag distribution teams rely on most. So the honesty this
    // plane owes its reader is a disclosure, and without it a value nobody
    // classified reads exactly like one that was.
    const rows = await page.getAllByRole('button');
    expect(rows.some((candidate) => candidate.name?.includes('sess_9f3a1c') === true)).toBe(true);
    await expect(page.getByText('These tag values are unclassified')).resolves.toBeDefined();
  });

  it('gives Stack Trace the projection Overview already has, without a second read', async () => {
    const harness = createHarness();
    const page = await mountDetail(harness);
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);

    await selectTab(page, 'Stack Trace');
    await expect(page.getByText('submitOrder — app/checkout.ts:42')).resolves.toBeDefined();

    // Three consumers of one selected projection must not become three reads;
    // a tab switch is presentation, not a lifetime boundary.
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);

    await selectTab(page, 'Overview');
    await selectTab(page, 'Stack Trace');
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);
  });

  it('keeps the last-known-good occurrence visible when its explicit reread fails', async () => {
    const harness = createHarness({
      eventSequence: [
        eventProjection({
          sections: [{
            kind: 'exception',
            type: 'ProjectionFailure',
            value: 'retained body',
            frames: [],
          }],
        }),
        {
          kind: 'unavailable',
          failure: { class: 'transient', code: 'sentry-temporarily-unavailable' },
        },
      ],
    });
    const page = await mountDetail(harness);
    await expect(page.getByText('ProjectionFailure: retained body')).resolves.toBeDefined();

    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Reread this occurrence' }));
    });

    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(2);
    await expect(page.getByText('ProjectionFailure: retained body')).resolves.toBeDefined();
    await expect(page.getByText('Showing the last observation')).resolves.toBeDefined();
  });

  it('gives an occurrence with no trace no Stack Trace tab at all', async () => {
    const harness = createHarness({ event: TRACELESS_EVENT });
    const page = await mountDetail(harness);

    // An unbuilt tab, an empty tab and an inapplicable one look identical to a
    // reader, and only one of them is true here.
    await expect(page.queryByRole('tab', { name: 'Stack Trace' })).resolves.toBeUndefined();
    await expect(page.getByRole('tab', { name: 'Overview' })).resolves.toBeDefined();
    await expect(page.getByRole('tab', { name: 'Occurrences' })).resolves.toBeDefined();
    await expect(page.getByRole('tab', { name: 'Activity' })).resolves.toBeDefined();
  });

  it('reads a chosen occurrence only when the reader chooses it', async () => {
    const harness = createHarness();
    const page = await mountDetail(harness);
    await selectTab(page, 'Occurrences');

    // Paging the list does not fetch a body: the second read exists because the
    // row was activated, and it names that exact event.
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);

    const rows = await page.getAllByRole('button');
    const row = rows.find((candidate) => candidate.name?.startsWith('card was declined') === true);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await act(async () => {
      await page.press(row);
    });

    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(2);
    expect(harness.invocations.at(-1)?.input)
      .toMatchObject({ selector: { kind: 'event', eventId: 'b'.repeat(32) } });
  });

  it('states when an oversized provider continuation made the occurrence walk stop short', async () => {
    const harness = createHarness({
      events: {
        kind: 'events',
        rows: [{ eventId: 'b'.repeat(32), headline: 'retained occurrence' }],
        omittedRowCount: 0,
        projectionTruncated: false,
        incomplete: 'continuationUnavailable',
      },
    });
    const page = await mountDetail(harness);

    await selectTab(page, 'Occurrences');

    await expect(page.getByText(
      'Sentry offered the next page in a form this build will not follow, so this list stops here.',
    )).resolves.toBeDefined();
    await expect(page.queryByRole('button', { name: 'Load more retained events' }))
      .resolves.toBeUndefined();
  });

  it('names its tab strip and every tab in the reader’s own locale', async () => {
    // The shared tab primitive takes plain strings and no keys, so an
    // untranslated declaration renders English on ten of the eleven locales
    // this plugin ships and NOTHING fails — the silent half of a missing
    // translation, and worst of all on the strip's accessible name.
    const harness = createHarness();
    const page = await mountDetail(harness, createSurfaceContextFixture({
      locale: 'ja',
      translations: SENTRY_UI_TRANSLATIONS.ja,
    }));

    for (const [key, english] of [
      ['plugins.sentry.ui.tab.overview', 'Overview'],
      ['plugins.sentry.ui.tab.occurrences', 'Occurrences'],
      ['plugins.sentry.ui.tab.stackTrace', 'Stack Trace'],
      ['plugins.sentry.ui.tab.activity', 'Activity'],
    ] as const) {
      const translated = SENTRY_UI_TRANSLATIONS.ja[key];
      expect(translated).not.toBe(english);
      await expect(page.getByRole('tab', { name: translated })).resolves.toBeDefined();
      await expect(page.queryByRole('tab', { name: english })).resolves.toBeUndefined();
    }

    const strip = await page.getByRole('tablist');
    expect(strip.name).toBe(SENTRY_UI_TRANSLATIONS.ja['plugins.sentry.ui.tabsLabel']);
  });

  it('states a refused occurrence read without blanking the rest of the detail', async () => {
    const harness = createHarness({
      event: {
        kind: 'unavailable',
        failure: { class: 'permission', code: 'sentry-insufficient-permission' },
      },
    });
    const page = await mountDetail(harness);

    await expect(page.getByText('This occurrence could not be read')).resolves.toBeDefined();
    // A failed event read is not a failed detail: the issue's own facts are
    // still there, and no Stack Trace tab claims a trace nobody read.
    await expect(page.getByRole('tab', { name: 'Occurrences' })).resolves.toBeDefined();
    await expect(page.queryByRole('tab', { name: 'Stack Trace' })).resolves.toBeUndefined();
  });
});
