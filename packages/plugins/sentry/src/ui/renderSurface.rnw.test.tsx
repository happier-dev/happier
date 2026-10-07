// @vitest-environment jsdom
import React, { act } from 'react';
import { defineUiSurface, Tabs, Text } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema, type TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import {
  TriageDetailPanelNavigationProvider,
  type TriageDetailPanelNavigationV1,
  type TriageEvidenceCandidateV1,
  type TriageEvidenceDisclosureOutcomeV1,
} from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID } from '../sentryContracts.js';
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';

import { renderSurface } from './renderSurface.js';
import { SENTRY_UI_TRANSLATIONS } from './translations.js';
import { SourcePanelActionsFixture, invokeSourcePanelFixtureAction } from '../../../triage/src/ui/sourcePanelActions.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from '../../../triage/src/ui/window/ephemeralSharedScope.test-support.js';

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
  localInstanceKey: 'https://us.sentry.io\u001f42',
  configuration: {
    v: 1,
    token: encodeSentryInstanceConfiguration({
      v: 1,
      organizationId: '42',
      projectScope: { kind: 'allAccessible' },
      environmentScope: { kind: 'all' },
    }),
  },
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
  /** Successive answers to the occurrence walk, when a case needs them to differ. */
  eventPageSequence?: readonly (JsonValue | ((signal: AbortSignal) => Promise<JsonValue>))[];
  tags?: JsonValue;
  readEvent?: (signal: AbortSignal) => Promise<JsonValue>;
  readSummary?: (signal: AbortSignal) => Promise<JsonValue>;
  activity?: JsonValue;
}> = {}) {
  const invocations: Invocation[] = [];

  async function executeAction(
    { action, input, signal }: Readonly<{ action: unknown; input: unknown; signal: AbortSignal }>,
  ): Promise<JsonValue> {
    const ref = action as Readonly<{ localId?: string }>;
    const localId = ref.localId ?? '';
    invocations.push({ localId, input });
    if (localId === SENTRY_ACTION_IDS.readIssue) {
      const projection = (input as Readonly<{ projection?: string }>).projection;
      if (projection === 'tags') return options.tags ?? TAGS_BODY;
      if (projection === 'activity') return options.activity ?? ACTIVITY_BODY;
      return options.readSummary === undefined ? ISSUE_BODY : await options.readSummary(signal);
    }
    if (localId === SENTRY_ACTION_IDS.listIssueEvents) {
      const pageIndex = invocations.filter(
        (entry) => entry.localId === SENTRY_ACTION_IDS.listIssueEvents,
      ).length - 1;
      const sequenced = options.eventPageSequence?.[pageIndex];
      if (sequenced !== undefined) return typeof sequenced === 'function'
        ? await sequenced(signal) : sequenced;
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
      if (options.readEvent !== undefined) return await options.readEvent(signal);
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
/** The Triage frame's panel selection, when a case mounts the source inside one. */
let frameNavigation: TriageDetailPanelNavigationV1 | null = null;

function SourceHostTabs({ children }: Readonly<{ children: React.ReactNode }>) {
  const [panel, setPanel] = React.useState('source');
  return <Tabs value={panel} onValueChange={setPanel}>
    <Tabs.Item value="source" title="Source" retention="retain">{children}</Tabs.Item>
    <Tabs.Item value="session" title="Session"><Text value="Session content" /></Tabs.Item>
  </Tabs>;
}

async function mountDetail(
  harness: ReturnType<typeof createHarness>,
  surfaceContext = createSurfaceContextFixture(),
  disclosure?: Readonly<{
    available: boolean;
    disclose(resolve: (signal: AbortSignal) => Promise<TriageEvidenceCandidateV1 | null>): Promise<TriageEvidenceDisclosureOutcomeV1>;
    confirm?: (input: Readonly<{ message: string; title?: string }>) => boolean | Promise<boolean>;
  }>,
  panel?: string | (() => string),
  ancestorTabs = false,
  detailInput?: () => TriageDetailSurfaceInputV1,
): Promise<PluginUiTestkit> {
  const scope = createTriageEphemeralSharedScopeFixture();
  const sourceSurface = defineUiSurface((context) => {
    const source = renderSurface(typeof panel === 'function'
      ? { ...context, launchInput: { ...(detailInput?.() ?? DETAIL_INPUT), panel: panel() } as unknown as JsonValue }
      : detailInput === undefined ? context : { ...context, launchInput: detailInput() as unknown as JsonValue });
    const actions = <SourcePanelActionsFixture scope={scope} disclosure={disclosure}>{source}</SourcePanelActionsFixture>;
    const body = frameNavigation === null ? actions
      : <TriageDetailPanelNavigationProvider navigation={frameNavigation}>{actions}</TriageDetailPanelNavigationProvider>;
    return ancestorTabs ? <SourceHostTabs>{body}</SourceHostTabs> : body;
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-173', mountNonce: 'fixture-mount-173' },
      authorPlugin: { id: SENTRY_PLUGIN_ID, version: '0.0.0' },
      surface: sourceSurface,
      surfaceContext,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: { ...DETAIL_INPUT, ...(typeof panel === 'string' ? { panel } : {}) } as unknown as JsonValue,
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          return localId.startsWith('ui/')
            ? await invokeSourcePanelFixtureAction(scope, localId, input, fixture.context, signal, disclosure?.confirm)
            : await harness.executeAction({ action, input, signal });
        },
        ...(disclosure?.confirm === undefined ? {} : { confirm: disclosure.confirm }),
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
  frameNavigation = null;
});

describe('the mounted Sentry issue detail body', () => {
  it('replaces settled selected evidence when the exact account authority changes', async () => {
    let input = TriageDetailSurfaceInputV1Schema.parse({ ...DETAIL_INPUT, panel: 'overview' });
    const harness = createHarness({ eventSequence: [
      eventProjection({ sections: [{ kind: 'exception', type: 'OldAccountError', value: 'old evidence', frames: [] }] }),
      eventProjection({ sections: [{ kind: 'exception', type: 'NewAccountError', value: 'current evidence', frames: [] }] }),
    ] });
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, 'overview', false, () => input);
    await expect(page.getByText('OldAccountError: old evidence')).resolves.toBeDefined();
    input = TriageDetailSurfaceInputV1Schema.parse({
      ...DETAIL_INPUT,
      instance: { ...DETAIL_INPUT.instance, binding: {
        ...DETAIL_INPUT.instance.binding,
        account: { ...DETAIL_INPUT.instance.binding.account, accountId: 'account-2' },
      } },
      panel: 'overview',
    });
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    await expect(page.getByText('NewAccountError: current evidence')).resolves.toBeDefined();
    await expect(page.queryByText('OldAccountError: old evidence')).resolves.toBeUndefined();
    expect(harness.invocations.filter((entry) => entry.localId === SENTRY_ACTION_IDS.readEvent)
      .at(-1)?.input).toMatchObject({ instance: { binding: { account: { accountId: 'account-2' } } } });
  });
  it('pauses unfinished root reads while Session hides the source and resumes safely', async () => {
    const summarySignals: AbortSignal[] = [];
    const eventSignals: AbortSignal[] = [];
    const summarySettlers: ((result: JsonValue) => void)[] = [];
    const eventSettlers: ((result: JsonValue) => void)[] = [];
    const harness = createHarness({
      readSummary: async (signal) => {
        summarySignals.push(signal);
        return await new Promise<JsonValue>((resolve) => { summarySettlers.push(resolve); });
      },
      readEvent: async (signal) => {
        eventSignals.push(signal);
        return await new Promise<JsonValue>((resolve) => { eventSettlers.push(resolve); });
      },
    });
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, 'overview', true);
    await selectTab(page, 'Session');
    expect(summarySignals[0]?.aborted).toBe(true);
    expect(eventSignals[0]?.aborted).toBe(true);
    await selectTab(page, 'Source');
    expect(summarySignals[1]?.aborted).toBe(false);
    expect(eventSignals[1]?.aborted).toBe(false);
    await act(async () => {
      summarySettlers[1]?.(ISSUE_BODY);
      eventSettlers[1]?.(eventProjection({ sections: [{
        kind: 'exception', type: 'ResumedError', value: 'current evidence', frames: [],
      }] }));
      summarySettlers[0]?.({ kind: 'overview', statePresentation: 'active', nativeStateLabel: 'Abandoned summary' });
      eventSettlers[0]?.(eventProjection({ sections: [{
        kind: 'exception', type: 'AbandonedError', value: 'stale evidence', frames: [],
      }] }));
    });
    await expect(page.getByText('ResumedError: current evidence')).resolves.toBeDefined();
    await expect(page.queryByText('AbandonedError: stale evidence')).resolves.toBeUndefined();
    await expect(page.queryByText('Abandoned summary')).resolves.toBeUndefined();
  });
  it('renders provider history records as one chronological Activity timeline', async () => {
    const harness = createHarness({ activity: {
      kind: 'activity', activity: { status: 'available',
        // Sentry states its history newest first; the timeline reads oldest first.
        items: [
          { id: 'record-2', type: 'set_resolved', actor: 'Mara', atMs: 1_760_000_600_000 },
          { id: 'record-1', type: 'set_regression', atMs: 1_760_000_100_000 },
        ],
        malformedItemCount: 0, omittedItemCount: 0, projectionTruncated: false },
    } });
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, 'activity');
    // The shared timeline is the panel: no numbered "Activity" step above it.
    await expect(page.queryByRole('heading', { name: 'Activity' })).resolves.toBeUndefined();
    await expect(page.getByText('Mara')).resolves.toBeDefined();
    await expect(page.getByText('set_resolved')).resolves.toBeDefined();
    const text = document.body.textContent ?? '';
    expect(text.indexOf('set_regression')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('set_regression')).toBeLessThan(text.indexOf('set_resolved'));
    await expect(page.getByText('2 activity record(s) read. Sentry states this history on the issue itself and does not paginate it.')).resolves.toBeDefined();
    await expect(page.queryByRole('tab')).resolves.toBeUndefined();
  });
  it('aborts hidden occurrence paging and resumes from its settled continuation', async () => {
    let panel = 'occurrences';
    let pendingSignal: AbortSignal | undefined;
    let settle!: (result: JsonValue) => void;
    const pending = new Promise<JsonValue>((resolve) => { settle = resolve; });
    const pageResult = (id: string, headline: string, continuation?: string): JsonValue => ({
      kind: 'events', rows: [{ eventId: id.repeat(32), headline }],
      omittedRowCount: 0, projectionTruncated: false,
      ...(continuation === undefined ? {} : { continuation }),
    });
    const harness = createHarness({ eventPageSequence: [
      pageResult('b', 'Settled first page', 'next-page'),
      async (signal) => { pendingSignal = signal; return await pending; },
      pageResult('c', 'Resumed second page'),
    ] });
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, () => panel, true);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Load more retained events' })); });
    expect(pendingSignal?.aborted).toBe(false);
    panel = 'activity';
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    expect(pendingSignal?.aborted).toBe(true);
    panel = 'occurrences';
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    await expect(page.getByText('Settled first page')).resolves.toBeDefined();
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Load more retained events' })); });
    await expect(page.getByText('Resumed second page')).resolves.toBeDefined();
    await act(async () => { settle(pageResult('d', 'Late abandoned page')); await pending; });
    await expect(page.queryByText('Late abandoned page')).resolves.toBeUndefined();
    expect(harness.invocations.filter((entry) => entry.localId === SENTRY_ACTION_IDS.listIssueEvents)
      .map((entry) => entry.input)).toMatchObject([
      {}, { continuation: 'next-page' }, { continuation: 'next-page' },
    ]);
  });
  it('aborts the selected-event read when the detail retires', async () => {
    let panel = 'overview';
    let pendingSignal: AbortSignal | undefined;
    let settle!: (result: JsonValue) => void;
    const pending = new Promise<JsonValue>((resolve) => { settle = resolve; });
    const page = await mountDetail(createHarness({ readEvent: async (signal) => {
      pendingSignal = signal;
      return await pending;
    } }), createSurfaceContextFixture(), undefined, () => panel);
    expect(pendingSignal?.aborted).toBe(false);
    const originalSignal = pendingSignal;
    panel = 'activity';
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    expect(originalSignal?.aborted).toBe(false);
    expect(pendingSignal).toBe(originalSignal);
    await act(async () => { await page.retire(); });
    expect(originalSignal?.aborted).toBe(true);
    await act(async () => { settle(eventProjection({ title: 'late retired event' })); await pending; });
    expect(document.body.textContent).not.toContain('late retired event');
  });
  it('keeps the second selected event and settled pages when the host changes panels', async () => {
    let panel = 'occurrences';
    const secondId = 'c'.repeat(32);
    const harness = createHarness({
      eventPageSequence: [{
        kind: 'events',
        rows: [{ eventId: 'b'.repeat(32), headline: 'First event', atMs: 1_760_000_100_000 }],
        omittedRowCount: 0,
        projectionTruncated: false,
        continuation: 'second-page',
      }, {
        kind: 'events',
        rows: [{ eventId: secondId, headline: 'Second event', atMs: 1_760_000_200_000 }],
        omittedRowCount: 0,
        projectionTruncated: false,
      }],
      event: eventProjection({ eventId: secondId, title: 'Second selected event', sections: [{
        kind: 'exception', type: 'SecondSelectedEvent', value: 'selected evidence', frames: [],
      }], tags: [{ key: 'url', value: 'selected-event-tag' }] }),
    });
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, () => panel, true);
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Load more retained events' })); });
    const row = (await page.getAllByRole('button')).find((candidate) => candidate.name?.startsWith('Second event'));
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('second occurrence must be reachable');
    await act(async () => { await page.press(row); });
    await selectTab(page, 'Session');
    await selectTab(page, 'Source');
    expect(harness.invocations.find((entry) => entry.localId === SENTRY_ACTION_IDS.readEvent)?.input)
      .toMatchObject({ selector: { kind: 'event', eventId: secondId } });
    panel = 'activity';
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    expect(document.body.textContent).not.toContain('selected-event-tag');
    panel = 'overview';
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    await expect(page.getByText('SecondSelectedEvent: selected evidence')).resolves.toBeDefined();
    panel = 'occurrences';
    await act(async () => { await page.updateSurface(createSurfaceContextFixture()); });
    await expect(page.getByText('First event')).resolves.toBeDefined();
    await expect(page.getByText('Second event')).resolves.toBeDefined();
    expect(harness.countOf(SENTRY_ACTION_IDS.listIssueEvents)).toBe(2);
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);
  });
  it('renders the host Overview as what happened with the source-owned representative occurrence', async () => {
    const harness = createHarness();
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, 'overview');
    await expect(page.getByRole('heading', { name: 'What happened' })).resolves.toBeDefined();
    await expect(page.queryByRole('tab')).resolves.toBeUndefined();
    expect(harness.countOf(SENTRY_ACTION_IDS.readEvent)).toBe(1);
  });
  it('states the spread once, from the issue read, and drops the observation chrome', async () => {
    const harness = createHarness({
      readSummary: async () => ({
        ...(ISSUE_BODY as Readonly<Record<string, JsonValue>>),
        userCount: 112,
        firstRelease: { version: 'checkout@4.12.0' },
        eventTrend: [
          { atMs: 1_760_000_000_000 - 3_600_000, count: 3 },
          { atMs: 1_760_000_000_000, count: 44 },
        ],
      }),
    });
    const select = vi.fn();
    frameNavigation = { panels: ['overview', 'activity', 'stack-trace'], select };
    const withFacts = (): TriageDetailSurfaceInputV1 => TriageDetailSurfaceInputV1Schema.parse({
      ...DETAIL_INPUT,
      observation: {
        ...DETAIL_INPUT.observation,
        snapshot: {
          ...DETAIL_INPUT.observation.snapshot,
          facts: [
            { id: 'level', importance: 'primary', value: { kind: 'text', value: 'fatal' } },
            { id: 'events', importance: 'secondary', value: { kind: 'number', value: 4021, format: 'compact', approximate: true } },
            { id: 'users', importance: 'secondary', value: { kind: 'number', value: 112, format: 'compact', approximate: true } },
            { id: 'last-release', importance: 'supplementary', value: { kind: 'detailOnly' } },
          ],
        },
      },
    });
    const page = await mountDetail(harness, createSurfaceContextFixture(), undefined, () => 'overview', false, withFacts);

    await expect(page.getByRole('heading', { name: 'Spread' })).resolves.toBeDefined();
    await expect(page.getByText('Users affected')).resolves.toBeDefined();
    await expect(page.getByText('checkout@4.12.0')).resolves.toBeDefined();
    await expect(page.getByText('First seen in')).resolves.toBeDefined();
    await expect(page.getByText('Last 24 hours')).resolves.toBeDefined();
    // Users and events are read once and shown once: the tile, not a Facts row or a "Sentry now" row too.
    const bodyText = document.body.textContent ?? '';
    expect(bodyText.match(/112/gu) ?? []).toHaveLength(1);
    expect(bodyText.match(/4k|4021|4,021/giu) ?? []).toHaveLength(1);
    // Facts the spread does not own stay.
    await expect(page.getByText('fatal')).resolves.toBeDefined();
    // Chrome the story no longer carries.
    for (const gone of ['Observation', 'Observed', 'No projected facts', 'Read only in this detail body:']) {
      await expect(page.queryByText(gone)).resolves.toBeUndefined();
    }

    // Stack trace is the frame's own panel: the inline control asks the frame for it.
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Open the stack trace' })); });
    expect(select).toHaveBeenCalledWith('stack-trace');
  });

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

  it('discloses the selected occurrence through Triage without Composer authority', async () => {
    let candidate: TriageEvidenceCandidateV1 | null = null;
    const confirm = vi.fn(async () => true);
    const harness = createHarness();
    const page = await mountDetail(harness, createSurfaceContextFixture(), {
      available: true,
      confirm,
      async disclose(resolve) {
        candidate = await resolve(new AbortController().signal);
        return candidate === null ? { kind: 'cancelled' } : { kind: 'applied' };
      },
    });
    await selectTab(page, 'Occurrences');
    const rows = await page.getAllByRole('button');
    const row = rows.find((entry) => entry.name?.startsWith('card was declined') === true);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await act(async () => { await page.press(row); });

    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add selected occurrence to message',
      }));
    });

    expect(candidate).toMatchObject({
      reference: { pluginId: SENTRY_PLUGIN_ID, localId: 'sentry-evidence' },
      candidate: { label: `Sentry occurrence ${'a'.repeat(32)}` },
    });
    expect(candidate?.candidate.id).not.toContain('https://us.sentry.io');
    expect(candidate).not.toHaveProperty('composer');
    // Approval now names the Action and describes the forwarded evidence;
    // exact projection counts remain visible beside Add in the source panel.
    const confirmation = String(confirm.mock.calls[0]?.[0]?.message);
    expect(confirmation).toContain('stack frames');
    expect(confirmation).toContain('frame local variables');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Add selected occurrence to message',
    }));
  });

  /**
   * A notice that spoke only of provider scrubbing said NOTHING for the case it
   * matters most in: an occurrence whose frame locals this source withheld and
   * whose event user fields it retained. Both are facts about the values on
   * screen, and a reader deciding whether to forward them needs each.
   */
  it('discloses withheld values and retained sensitive fields, not only provider scrubbing', async () => {
    const harness = createHarness({
      event: eventProjection({
        redactions: [
          { path: 'entries[0].data.frames[0].vars', reason: 'pluginWithheld' },
        ],
        sensitivePaths: ['user.email'],
      }),
    });
    const page = await mountDetail(harness);

    await expect(page.getByText('Some values are withheld')).resolves.toBeDefined();
    await expect(page.getByText(
      '1 value(s) are withheld by Happier, including every frame’s local variables.'
      + ' 1 sensitive value(s), such as event user fields and tag values, are shown here.',
    )).resolves.toBeDefined();
  });

  /**
   * `[SCHEMA]` `sample=true` reorders the retained events pseudo-randomly and
   * deterministically. It is the reader's own choice (`SENTRY.md` §7.4), so it
   * has a control, it is labelled as an ordering rather than a statistical
   * sample, and choosing it restarts the walk instead of appending a differently
   * ordered tail to the list already read.
   */
  it('offers the explicit spread of retained events and re-reads under that ordering', async () => {
    const harness = createHarness();
    const page = await mountDetail(harness);
    await selectTab(page, 'Occurrences');

    const eventPages = () => harness.invocations.filter(
      (entry) => entry.localId === SENTRY_ACTION_IDS.listIssueEvents,
    );
    expect(eventPages()).toHaveLength(1);
    expect(eventPages()[0]?.input).not.toHaveProperty('sample');

    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Show a spread of events' }));
    });

    expect(eventPages()).toHaveLength(2);
    expect(eventPages()[1]?.input).toMatchObject({ sample: true });
    // The spread replaces the list; it never continues the ordinary walk.
    expect(eventPages()[1]?.input).not.toHaveProperty('continuation');
    await expect(page.getByText(
      'A spread is a pseudo-random deterministic ordering of the same retained events,'
      + ' not a statistical sample.',
    )).resolves.toBeDefined();

    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Show Sentry’s own order' }));
    });
    expect(eventPages()).toHaveLength(3);
    expect(eventPages()[2]?.input).not.toHaveProperty('sample');
  });

  it('issues no selected-evidence candidate when disclosure confirmation is declined', async () => {
    const disclose = vi.fn();
    const harness = createHarness();
    const page = await mountDetail(harness, createSurfaceContextFixture(), {
      available: true,
      confirm: async () => false,
      disclose,
    });
    await selectTab(page, 'Occurrences');
    const rows = await page.getAllByRole('button');
    const row = rows.find((entry) => entry.name?.startsWith('card was declined') === true);
    expect(row).toBeDefined();
    if (row === undefined) return;
    await act(async () => { await page.press(row); });
    await act(async () => {
      await page.press(await page.getByRole('button', {
        name: 'Add selected occurrence to message',
      }));
    });

    expect(disclose).not.toHaveBeenCalled();
  });

  it('asks Sentry again for the occurrence page it refused', async () => {
    const harness = createHarness({
      eventPageSequence: [
        {
          kind: 'events',
          rows: [{ eventId: 'b'.repeat(32), headline: 'card was declined' }],
          omittedRowCount: 0,
          projectionTruncated: false,
          continuation: 'sentry-events-page-2',
        },
        { kind: 'unavailable', failure: { class: 'transient', code: 'sentry-page-refused' } },
        {
          kind: 'events',
          rows: [{ eventId: 'c'.repeat(32), headline: 'card expired' }],
          omittedRowCount: 0,
          projectionTruncated: false,
        },
      ],
    });
    const page = await mountDetail(harness);
    await selectTab(page, 'Occurrences');

    const loadMore = async (): Promise<void> => {
      await act(async () => {
        await page.press(await page.getByRole('button', { name: 'Load more retained events' }));
      });
    };
    await loadMore();
    // The refused page keeps the events already read, and the control stays
    // mounted and enabled — which is the walk offering a retry.
    await expect(page.getByText('1 retained event(s) read.')).resolves.toBeDefined();
    expect(harness.countOf(SENTRY_ACTION_IDS.listIssueEvents)).toBe(2);

    await loadMore();

    expect(harness.countOf(SENTRY_ACTION_IDS.listIssueEvents)).toBe(3);
    expect(harness.invocations.filter(
      (entry) => entry.localId === SENTRY_ACTION_IDS.listIssueEvents,
    ).at(-1)?.input).toMatchObject({ continuation: 'sentry-events-page-2' });
    await expect(page.getByText('2 retained event(s) read.')).resolves.toBeDefined();
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
    // untranslated declaration renders English in every locale missing its
    // own entry and NOTHING fails — the silent half of a missing
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
