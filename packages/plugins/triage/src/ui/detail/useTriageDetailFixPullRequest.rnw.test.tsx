// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkitOpenSurfaceInput } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { Button, defineUiSurface, Stack, Text, type PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';
import { useTriageDetailFixPullRequest, useTriageOffPageFixPullRequest, useTriageFixPullRequestNavigationBinding } from './useTriageDetailFixPullRequest.js';
import type { TriageDetailFixPullRequestNavigationV1 } from '@happier-dev/triage-sources/ui';
import { parseTriageEntryDetailLaunchInput } from '../../composer/entryDetailLaunchInput.js';
import { foldTriagePostMutationObservation, type TriageListRowV1 } from '../../projection/listWindow.js';
import { TriageReadFixPullRequestsResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { buildTriageDetailSurfaceInputV1 } from './input.js';
import { readTriageSelectedObservationV1, type TriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { TriageFixPullRequests } from './fixPullRequests.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function accountScope(): PluginUiEphemeralSharedScope {
  // Account lifetime is host-owned; this read needs only its identity, never a shared value.
  return { acquire: () => null };
}

async function mountOffPageFix(replyKind: 'present' | 'denied' | 'wrongSource' = 'present', holdOpen = false,
  status: JsonValue = { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'statusUnavailable' } }) {
    const fixture = createTriageSourceV1Fixture();
    const observation = fixture.detailInput.observation;
    let owner = accountScope();
    let candidate = { entryRef: observation.entryRef, origins: ['native' as const], status: 'open' as const, display: {},
      sourceContext: { sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId, lastKnownLocator: observation.locator } };
    const pending: ((title: string) => void)[] = [];
    const displayed: string[] = [];
    const selectedReads: (TriageSelectedObservationV1 | null)[] = [];
    const statusReads: JsonValue[] = [];
    const bindings: (TriageDetailFixPullRequestNavigationV1 | null)[] = [];
    const opened: unknown[] = [];
    const navigationSignals: AbortSignal[] = [];
    const releaseOpens: (() => void)[] = [];
    const external: string[] = [];
    const context = createSurfaceContextFixture();
    const surface = defineUiSurface(() => {
      const selected = useTriageOffPageFixPullRequest(candidate);
      selectedReads.push(selected);
      const navigation = useTriageFixPullRequestNavigationBinding(candidate, selected);
      bindings.push(navigation);
      const title = selected?.observation.snapshot.title ?? 'waiting';
      displayed.push(title);
      return <Stack style={{ width: 390 }}>
        <Text value={title} />
        <TriageFixPullRequests pickable={[]} state={{ kind: 'ready', candidates: [candidate], primary: candidate,
          incomplete: false, busy: false, refusal: null, link: () => undefined, unlink: () => undefined }}
          {...(navigation === null ? {} : { onOpenPrimary: () => { void navigation.open(); } })} />
      </Stack>;
    });
    const kit = await createPluginUiTestkit({
      identity: { instanceId: 'off-page-fix', mountNonce: 'off-page-fix-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface, surfaceContext: context,
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ get ephemeralSharedScope() { return owner; } }),
      handlers: { openSurface: async ({ view, input, signal }) => {
        navigationSignals.push(signal);
        if (holdOpen) await new Promise<void>(resolve => releaseOpens.push(resolve));
        if (!signal.aborted) opened.push({ view, input });
      },
        openExternalLink: async ({ url }) => { external.push(url); },
        executeAction: async ({ action, input }) => {
          if (action === 'entries/read-pull-request-status-v1') { statusReads.push(input); return status; }
          return await new Promise<JsonValue>(resolve => pending.push(title => resolve(replyKind === 'denied' ? { kind: 'unavailable' } : {
        kind: 'observed', entryRef: replyKind === 'wrongSource' ? { ...observation.entryRef, source: { ...observation.entryRef.source, localId: 'foreign' } } : observation.entryRef,
        observation: { sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId, observedAtMs: observation.observedAtMs,
          outcome: { kind: 'present', locator: observation.locator, viewer: observation.viewer, snapshot: { ...observation.snapshot, title } } },
      }))); } },
    });
    return { kit, pending, displayed, selectedReads, statusReads, candidate, bindings, opened, external, fixture, navigationSignals, releaseOpens,
      update: async () => { await act(async () => { await kit.updateSurface({ ...context }); }); },
      switchAccount: () => { owner = accountScope(); },
      switchRoute: () => { candidate = { ...candidate, sourceContext: { ...candidate.sourceContext,
        lastKnownLocator: { ...candidate.sourceContext.lastKnownLocator, routingToken: 'new-repository-route' } } }; },
      reply: async (index: number, title: string) => { await act(async () => { pending[index]!(title); }); },
    };
}

describe('off-page fix PR Account lifetime', () => {
  it.each(['status', 'unavailable'] as const)('joins the exact fix PR status facts without losing its snapshot (%s)', async kind => {
    const checks = { id: 'fixture/checks', importance: 'primary',
      value: { kind: 'status', value: '1 failing', tone: 'danger' } } as const;
    const mounted = await mountOffPageFix('present', false, kind === 'unavailable'
      ? { kind, failure: { class: 'transient', code: 'github_unavailable' } }
      : { kind, observedAtMs: 100, checks: null, review: null, merge: null, branch: null, facts: [checks] });
    try {
      await mounted.reply(0, 'Dependency fix');
      const selected = mounted.selectedReads.at(-1);
      expect(selected?.observation.snapshot.title).toBe('Dependency fix');
      const original = mounted.fixture.detailInput.observation.snapshot.facts;
      expect(selected?.observation.snapshot.facts).toEqual(kind === 'status'
        ? [...original.filter(fact => fact.id !== checks.id), checks] : original);
      await mounted.update();
      expect(mounted.statusReads).toEqual([{ v: 1, entryRef: mounted.candidate.entryRef, ...mounted.candidate.sourceContext }]);
    } finally { await mounted.kit.dispose(); }
  });

  it('keeps Open pull request visible at 390 while the admitted off-page fix snapshot is pending', async () => {
    const fixture = await mountOffPageFix();
    try {
      expect(fixture.pending).toHaveLength(1);
      await expect(fixture.kit.getByRole('button', { name: 'Open pull request' })).resolves.toBeDefined();
      expect(fixture.opened).toEqual([]);
    } finally { await fixture.kit.dispose(); }
  });

  it('waits for the native Dependabot fix PR and forwards its qualified selection to the host', async () => {
    const fixture = createTriageSourceV1Fixture();
    const source = { pluginId: 'happier.scm.forge.github', localId: 'github-forge' };
    const alertRef = { source, kindId: 'dependabot-alert', collisionScope: 'github:1424792902', entryId: '1' };
    const pullRequestRef = { ...alertRef, kindId: 'pull-request', entryId: '55' };
    const observation = fixture.detailInput.observation;
    const sourceInstanceId = fixture.configuredInstance.instance.sourceInstanceId;
    const sourceInstanceRowId = 'a'.repeat(43);
    const locator = { v: 1 as const, routingToken: 'happier-dev/triage-qa-sandbox',
      webUrl: 'https://github.com/happier-dev/triage-qa-sandbox/pull/55' };
    const row = foldTriagePostMutationObservation({ row: null, lanes: [], activeSourceInstanceIds: [sourceInstanceId],
      assembledAtMs: observation.observedAtMs, observation: { entryRef: alertRef, sourceInstanceId,
        observedAtMs: observation.observedAtMs, outcome: { kind: 'present', locator,
          snapshot: observation.snapshot, viewer: observation.viewer } } });
    if (row === null) throw new Error('Expected the selected Dependabot alert');
    const primary = { entryRef: pullRequestRef, origins: ['native'], status: 'open', display: { title: 'Dependency fix' },
      sourceContext: { sourceInstanceId, sourceInstanceRowId, lastKnownLocator: locator } };
    const answer = TriageReadFixPullRequestsResultV1Schema.parse({ v: 1, candidates: [primary], primary, incomplete: false });
    const context = createSurfaceContextFixture();
    const opened: PluginUiTestkitOpenSurfaceInput[] = [];
    const reads: string[] = [];
    const detailInputs: unknown[] = [];
    let resolveAssociation: (() => void) | undefined;
    const kit = await createPluginUiTestkit({
      identity: { instanceId: 'dependabot-fix-navigation', mountNonce: 'dependabot-fix-navigation' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surfaceContext: context,
      surface: defineUiSurface(() => {
        const fix = useTriageDetailFixPullRequest({ context, row, rows: [row], workflowSubject: 'issue',
          instance: fixture.configuredInstance,
          display: { title: 'Dependency alert', scopeLabel: 'triage-qa-sandbox' } });
        return fix.navigation === null ? <Text value="Resolving fix" />
          : <Button title="Open pull request" onPress={() => { void fix.navigation?.open(); }} />;
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: accountScope() }),
      handlers: {
        executeAction: async ({ action, input }) => {
          if (typeof action !== 'string') throw new Error('Expected a Triage Action');
          reads.push(action);
          if (action === 'marks/read-fix-pull-requests-v1') {
            await new Promise<void>(resolve => { resolveAssociation = resolve; });
            return answer;
          }
          if (action === 'entries/reobserve-v1') return { kind: 'observed', entryRef: pullRequestRef,
            observation: { sourceInstanceId, observedAtMs: observation.observedAtMs,
              outcome: { kind: 'present', locator, viewer: observation.viewer,
                snapshot: { ...observation.snapshot, title: 'Dependency fix' } } } };
          if (action === 'entries/read-detail-v1') { detailInputs.push(input); return { kind: 'unavailable' }; }
          throw new Error(`Unexpected Action: ${action}`);
        },
        openSurface: async request => { opened.push(request); },
      },
    });
    try {
      expect(opened).toEqual([]);
      await expect(kit.queryByRole('button', { name: 'Open pull request' })).resolves.toBeUndefined();
      await act(async () => { resolveAssociation?.(); });
      await act(async () => { await kit.press(await kit.getByRole('button', { name: 'Open pull request' })); });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.view).toEqual({ pluginId: 'happier.triage', localId: 'triage' });
      expect(parseTriageEntryDetailLaunchInput(opened[0]?.input)).toMatchObject({ status: 'valid',
        input: { entryRef: pullRequestRef, sourceInstance: { source, sourceInstanceId } } });
      expect(reads.filter(action => action === 'entries/reobserve-v1')).toHaveLength(1);
      expect(detailInputs).toEqual([{ v: 1, entryRef: pullRequestRef, sourceInstanceId, sourceInstanceRowId }]);
    } finally { resolveAssociation?.(); await kit.dispose(); }
  });

  it('finishes an Open pull request click when only the selected observation refreshes', async () => {
    const fixture = createTriageSourceV1Fixture();
    const candidate = { entryRef: fixture.detailInput.observation.entryRef, origins: ['native' as const],
      status: 'open' as const, display: {}, sourceContext: {
        sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        lastKnownLocator: fixture.detailInput.observation.locator,
      } };
    let selected = { sourceInstanceId: candidate.sourceContext.sourceInstanceId,
      observation: fixture.detailInput.observation };
    const owner = accountScope();
    const signals: AbortSignal[] = [];
    const opened: unknown[] = [];
    let release: (() => void) | undefined;
    let opening: ReturnType<TriageDetailFixPullRequestNavigationV1['open']> | undefined;
    const context = createSurfaceContextFixture();
    const kit = await createPluginUiTestkit({
      identity: { instanceId: 'refreshing-fix-navigation', mountNonce: 'refreshing-fix-navigation' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surfaceContext: context,
      surface: defineUiSurface(() => {
        const navigation = useTriageFixPullRequestNavigationBinding(candidate, selected);
        return <Button title="Open pull request" onPress={() => { opening = navigation?.open(); }} />;
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: owner }),
      handlers: { openSurface: async ({ input, signal }) => {
        signals.push(signal);
        await new Promise<void>(resolve => { release = resolve; });
        if (!signal.aborted) opened.push(input);
      } },
    });
    try {
      await act(async () => { await kit.press(await kit.getByRole('button', { name: 'Open pull request' })); });
      expect(signals).toHaveLength(1);
      selected = { ...selected, observation: { ...selected.observation,
        observedAtMs: selected.observation.observedAtMs + 1 } };
      await act(async () => { await kit.updateSurface({ ...context }); });
      expect(signals[0]?.aborted).toBe(false);
      await act(async () => { release?.(); });
      expect(await opening).toEqual({ kind: 'opened' });
      expect(parseTriageEntryDetailLaunchInput(opened[0])).toMatchObject({ status: 'valid',
        input: { entryRef: candidate.entryRef } });
    } finally { release?.(); await kit.dispose(); }
  });

  it.each(['before route change', 'after route change'] as const)('settles an alert fix read through rebuilt detail inputs (%s)', async (settlement) => {
    const fixture = createTriageSourceV1Fixture();
    const source = { pluginId: 'happier.scm.forge.github', localId: 'github-forge' };
    const instance = { ...fixture.configuredInstance, instance: { ...fixture.configuredInstance.instance, source } };
    const observation = { ...fixture.detailInput.observation,
      entryRef: { source, kindId: 'dependabot-alert', collisionScope: 'github:1424792902', entryId: '1' } };
    const instanceId = fixture.configuredInstance.instance.sourceInstanceId;
    const fold = (previous: TriageListRowV1 | null, title: string, routingToken = observation.locator.routingToken) => {
      const row = foldTriagePostMutationObservation({ row: previous, lanes: [], activeSourceInstanceIds: [instanceId],
        assembledAtMs: observation.observedAtMs, observation: {
          entryRef: observation.entryRef, sourceInstanceId: instanceId, observedAtMs: observation.observedAtMs,
          outcome: { kind: 'present', locator: { ...observation.locator, routingToken }, viewer: observation.viewer,
            snapshot: { ...observation.snapshot, title } },
        } });
      if (!row) throw new Error('Expected a qualified selected row');
      return row;
    };
    let row = fold(null, 'Selected task');
    const context = createSurfaceContextFixture();
    const owner = accountScope();
    const signals: AbortSignal[] = [];
    const replies: (() => void)[] = [];
    const surface = defineUiSurface(() => {
      const detail = React.useMemo(() => {
        const selected = readTriageSelectedObservationV1(row);
        if (selected === null) throw new Error('Expected a selected alert');
        return buildTriageDetailSurfaceInputV1({ selection: { entryRef: row.entryRef, sourceInstanceId: instanceId },
          instance, observation: selected.observation, linkedSessions: [] });
      }, [row]);
      if (detail.kind !== 'admitted') throw new Error('Expected an admitted alert detail');
      const fix = useTriageDetailFixPullRequest({ context, row, rows: [row], workflowSubject: 'errorIssue',
        instance: detail.input.instance,
        display: { title: 'Selected task', scopeLabel: 'Project' } });
      return <Text value={`${row.content?.outcome.snapshot.title}:${fix.state?.kind}`} />;
    });
    const kit = await createPluginUiTestkit({ identity: { instanceId: 'pending-task-marks', mountNonce: 'pending-task-marks' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface, surfaceContext: context,
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: owner }), handlers: {
        executeAction: async ({ action, signal }) => {
          expect(action).toBe('marks/read-fix-pull-requests-v1');
          signals.push(signal);
          return await new Promise<JsonValue>(resolve => replies.push(() => resolve({ v: 1, candidates: [], primary: null, incomplete: false })));
        },
      } });
    try {
      expect(signals).toHaveLength(1);
      const initial = row;
      row = fold(row, 'Updated task');
      expect(row).not.toBe(initial);
      await act(async () => { await kit.updateSurface({ ...context }); });
      expect(signals[0]?.aborted).toBe(false);
      expect(signals).toHaveLength(1);
      await expect(kit.getByText('Updated task:reading')).resolves.toBeDefined();
      if (settlement === 'before route change') {
        await act(async () => { replies[0]!(); });
        await expect(kit.getByText('Updated task:ready')).resolves.toBeDefined();
      }

      row = fold(row, 'Updated task', 'new-authoritative-route');
      await act(async () => { await kit.updateSurface({ ...context }); });
      if (settlement === 'after route change') expect(signals[0]?.aborted).toBe(true);
      expect(signals).toHaveLength(2);
      await act(async () => { replies[1]!(); });
      await expect(kit.getByText('Updated task:ready')).resolves.toBeDefined();
      if (settlement === 'after route change') {
        await act(async () => { replies[0]!(); });
        await expect(kit.getByText('Updated task:ready')).resolves.toBeDefined();
      }
    } finally { for (const reply of replies) reply(); await kit.dispose(); }
  });

  it('opens the admitted off-page primary through the canonical launch parser with no additional exact reads', async () => {
    const fixture = await mountOffPageFix();
    try {
      const navigation = fixture.bindings.at(-1)!;
      expect(navigation?.url).toBe(fixture.fixture.detailInput.observation.locator.webUrl);
      expect(await navigation?.open()).toEqual({ kind: 'opened' });
      expect(fixture.opened).toHaveLength(1);
      const opened = fixture.opened[0] as { input: unknown };
      expect(parseTriageEntryDetailLaunchInput(opened.input)).toMatchObject({ status: 'valid', input: {
        entryRef: fixture.fixture.detailInput.observation.entryRef, sourceInstance: fixture.fixture.configuredInstance.instance,
      } });
      await navigation?.openExternal();
      expect(fixture.external).toEqual([navigation?.url]);
      await fixture.reply(0, 'Exact PR');
      expect(fixture.bindings.at(-1)?.title).toBe('Exact PR');
      const controller = new AbortController(); controller.abort();
      expect(await navigation?.open({ signal: controller.signal })).toEqual({ kind: 'cancelled' });
      expect(fixture.opened).toHaveLength(1);
      const refreshedNavigation = fixture.bindings.at(-1);
      await fixture.update();
      expect(fixture.bindings.at(-1)).toBe(refreshedNavigation);
      expect(fixture.pending).toHaveLength(1);
      await fixture.kit.dispose();
      expect(await navigation?.open()).toEqual({ kind: 'cancelled' });
      await navigation?.openExternal();
      expect(fixture.opened).toHaveLength(1);
      expect(fixture.external).toHaveLength(1);
    } finally { await fixture.kit.dispose(); }
  });

  it.each(['denied', 'wrongSource'] as const)('retains admitted navigation without using an %s snapshot', async (replyKind) => {
    const fixture = await mountOffPageFix(replyKind);
    try {
      await fixture.reply(0, 'Unadmitted PR');
      await expect(fixture.kit.getByRole('button', { name: 'Open pull request' })).resolves.toBeDefined();
      expect(fixture.bindings.at(-1)?.title).not.toBe('Unadmitted PR');
      await expect(fixture.kit.queryByText('Unadmitted PR')).resolves.toBeUndefined();
      expect(fixture.opened).toEqual([]);
    } finally { await fixture.kit.dispose(); }
  });
  it.each(['Account', 'route', 'unmount'] as const)('cancels an in-flight navigation at the host boundary on %s retirement', async (change) => {
    const fixture = await mountOffPageFix('present', true);
    try {
      await fixture.reply(0, 'Exact PR');
      let opening: ReturnType<TriageDetailFixPullRequestNavigationV1['open']> | undefined;
      await act(async () => { opening = fixture.bindings.at(-1)!.open(); });
      expect(fixture.navigationSignals).toHaveLength(1);
      if (change === 'unmount') await fixture.kit.dispose();
      else {
        if (change === 'Account') fixture.switchAccount(); else fixture.switchRoute();
        await fixture.update();
      }
      expect(fixture.navigationSignals[0]?.aborted).toBe(true);
      expect(await opening).toEqual({ kind: 'cancelled' });
      await act(async () => { fixture.releaseOpens[0]!(); });
      expect(fixture.opened).toEqual([]);
    } finally { await fixture.kit.dispose(); }
  });
  it('cancels an in-flight navigation when its caller aborts without retiring the primary', async () => {
    const fixture = await mountOffPageFix('present', true);
    try {
      await fixture.reply(0, 'Exact PR');
      const controller = new AbortController();
      let opening: ReturnType<TriageDetailFixPullRequestNavigationV1['open']> | undefined;
      await act(async () => { opening = fixture.bindings.at(-1)!.open({ signal: controller.signal }); });
      controller.abort();
      expect(fixture.navigationSignals[0]?.aborted).toBe(true);
      expect(await opening).toEqual({ kind: 'cancelled' });
      await act(async () => { fixture.releaseOpens[0]!(); });
      expect(fixture.opened).toEqual([]);
      expect(fixture.bindings.at(-1)?.title).toBe('Exact PR');
    } finally { await fixture.kit.dispose(); }
  });
  it.each(['Account', 'route'] as const)('clears the prior %s answer synchronously with identical entry ids and retains equal candidates', async (change) => {
    const fixture = await mountOffPageFix();
    try {
      expect(fixture.pending).toHaveLength(1);
      await fixture.reply(0, 'Previous answer');
      const previousNavigation = fixture.bindings.at(-1);
      await expect(fixture.kit.getByText('Previous answer')).resolves.toBeDefined();
      await fixture.update();
      expect(fixture.pending).toHaveLength(1);
      if (change === 'Account') fixture.switchAccount(); else fixture.switchRoute();
      const boundary = fixture.displayed.length;
      await fixture.update();
      expect(await previousNavigation?.open()).toEqual({ kind: 'cancelled' });
      await previousNavigation?.openExternal();
      expect(fixture.opened).toEqual([]);
      expect(fixture.external).toEqual([]);
      expect(fixture.displayed.slice(boundary)).not.toContain('Previous answer');
      expect(fixture.pending).toHaveLength(2);
      await expect(fixture.kit.queryByText('Previous answer')).resolves.toBeUndefined();
      await fixture.reply(1, 'Current answer');
      await expect(fixture.kit.getByText('Current answer')).resolves.toBeDefined();
    } finally { await fixture.kit.dispose(); }
  });

  it.each(['Account', 'route'] as const)('drops a late cancelled %s reply after the current answer is visible', async (change) => {
    const fixture = await mountOffPageFix();
    try {
      expect(fixture.pending).toHaveLength(1);
      if (change === 'Account') fixture.switchAccount(); else fixture.switchRoute();
      await fixture.update();
      expect(fixture.pending).toHaveLength(2);
      await fixture.reply(1, 'Current answer');
      await expect(fixture.kit.getByText('Current answer')).resolves.toBeDefined();
      await fixture.reply(0, 'Late previous answer');
      expect(fixture.bindings.at(-1)?.title).toBe('Current answer');
      await expect(fixture.kit.queryByText('Late previous answer')).resolves.toBeUndefined();
      await expect(fixture.kit.getByText('Current answer')).resolves.toBeDefined();
    } finally { await fixture.kit.dispose(); }
  });
});
