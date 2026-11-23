// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import {
  createPluginUiActionControlTestHost,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { TRIAGE_DEFAULT_ACTIONS_V1, type TriageActionV1 } from '../../settings/actions.js';
import { TRIAGE_DEFAULT_FIX_ACTION_ID_V1, TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1, TriagePullRequestStatusV1Schema } from '@happier-dev/triage-protocol/v1';
import {
  readTriagePrimaryActionIdV1,
  resolveTriageReviewPreparationV1,
  TRIAGE_ACTION_BAND_CONTROLS_TEST_ID_V1,
  TRIAGE_ACTION_BAND_ROOM_TEST_ID_V1,
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from './entryActionControls.js';
import type { TriageAgentEntryV1 } from '../detail/storyRail.js';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';
import { TriageSourceWriteCluster } from './sourceWriteCluster.js';
import { operationOffers } from '../../sessions/testkit/sessionPullRequestOperations.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

function formalAction(actionId: string, label: string): TriageActionV1 {
  return Object.freeze({
    actionId,
    label,
    enabled: true,
    appliesTo: ['pullRequest'],
    profileId: null,
    workspaceMode: 'pull_request',
    target: {
      kind: 'reviewStart',
      promptInvocationId: null,
      seededFallbackInstruction: 'Review this change.',
    },
  });
}

describe('the mounted configured entry action controls', () => {
  it('opens the existing task draft from an error with its exact origin, without creating anything', async () => {
    const entryRef = testkitEntryRef({ kindId: 'error-issue', entryId: 'checkout-error' });
    const originError = { entryRef, display: { title: 'Checkout fails after payment', scopeLabel: 'Production' } };
    const writes: Array<{ action: string; input: unknown }> = [];
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'error-make-task', mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open', entryRef, sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1} workflowSubject="errorIssue" viewerIsAuthor={false}
        reviewPreparation="unsupported" taskDraft={{ title: originError.display.title, originError }}
        onAction={() => undefined} />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: ({ action, input }) => { writes.push({ action, input }); return { status: 'applied' }; } },
    });
    mounted.push(fixture);
    // Make task is a rarer action than Ask: it waits behind More, so the row is the primary, Ask and ⋯.
    await expect(fixture.queryByRole('button', { name: 'Make task' })).resolves.toBeUndefined();
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'More actions' })); });
    await act(async () => { await fixture.press(await fixture.getByRole('menuitem', { name: 'Make task' })); });
    expect(writes.filter(write => write.action.startsWith('tasks/'))).toEqual([{ action: 'tasks/open-create-v1', input: { title: originError.display.title, originError } }]);
  });
  it('quiets the agent action while the entry asks for a decision first, keeping its place and press', async () => {
    const fillOfFix = async (decisionFirst: boolean) => {
      const requests: TriageEntryActionRequestV1[] = [];
      const fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-decision', mountNonce: `decision-${String(decisionFirst)}` },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => <TriageEntryActionControls
          target={{ kind: 'entry', sectionId: 'open', entryRef: testkitEntryRef({ entryId: 'r1', kindId: 'issue' }),
            sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
          actions={TRIAGE_DEFAULT_ACTIONS_V1} workflowSubject="issue" viewerIsAuthor={false}
          reviewPreparation="unsupported" {...(decisionFirst ? { decisionFirst: true } : {})}
          onAction={(request) => { requests.push(request); }} />),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      });
      try {
        const fix = await fixture.getByRole('button', { name: 'Fix' });
        const node = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(candidate => candidate.textContent === 'Fix');
        if (node === undefined) throw new Error('No Fix button');
        const fill = getComputedStyle(node).backgroundColor;
        await act(async () => { await fixture.press(fix); });
        return { fill, pressed: requests.map(request => request.action.actionId) };
      } finally { await fixture.dispose(); }
    };
    const leading = await fillOfFix(false);
    const deciding = await fillOfFix(true);
    // Same action, same press; only its emphasis yields to the body's way to decide.
    expect(deciding.pressed).toEqual(leading.pressed);
    expect(deciding.fill).not.toBe(leading.fill);
  });
  it('names the seeded Fix "Start" on an entry with no code repository, and leads the row with its status control', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: 't1', kindId: 'task' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        withoutRepository
        leading={<Button title="In progress" variant="secondary" onPress={() => undefined} />}
        onAction={(request) => { requests.push(request); }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-start', mountNonce: 'fixture-mount-start' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);

    await expect(fixture.queryByRole('button', { name: 'Fix' })).resolves.toBeUndefined();
    await fixture.getByRole('button', { name: 'In progress' });
    await fixture.press(await fixture.getByRole('button', { name: 'Start' }));
    expect(requests[0]?.action.actionId).toBe(TRIAGE_DEFAULT_FIX_ACTION_ID_V1);
  });

  it('lends its primary agent Start and Send to a Session to the story, through the same press', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const sends: TriageEntryActionRequestV1[] = [];
    let entry: TriageAgentEntryV1 | null = null;
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open', entryRef: testkitEntryRef({ entryId: 't1', kindId: 'task' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        withoutRepository
        onAction={(request) => { requests.push(request); }}
        sendControl={{ prepare: async request => { sends.push(request); return { input: { v: 1 } }; },
          onSettled: () => undefined }}
        onAgentEntry={(next) => { entry = next; }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-entry', mountNonce: 'fixture-mount-entry' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);
    expect(entry).not.toBeNull();
    entry!.start();
    await entry!.sendControl.prepare({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.action.target.kind).toBe('agent');
    expect(requests[0]).not.toHaveProperty('destinationChoice');
    expect(sends).toEqual(requests);
  });

  it('lends its Review action\'s own press to the frame, and withdraws it while the workspace cannot be prepared', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const lent: Array<{ start(): void } | null> = [];
    let preparation: 'ready' | 'unsupported' = 'ready';
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: '17', kindId: 'pull-request' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={[formalAction('formal-review-one', 'Review')]}
        workflowSubject="pullRequest"
        viewerIsAuthor={false}
        reviewPreparation={preparation}
        onAction={(request) => { requests.push(request); }}
        onReviewEntry={(entry) => { lent.push(entry); }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-review-entry', mountNonce: 'fixture-mount-review-entry' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);

    const entry = lent.at(-1);
    expect(entry).not.toBeNull();
    await act(async () => { entry?.start(); });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: { actionId: 'formal-review-one' }, sourceInstanceId: '11111111-1111-4111-8111-111111111111' });
    preparation = 'unsupported';
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(lent.at(-1)).toBeNull();
  });

  it('offers no Fix on an entry with nothing to fix, in its row or its More menu (T2)', async () => {
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open', entryRef: testkitEntryRef({ entryId: 'review-1', kindId: 'review' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        nothingToFix
        onAction={() => null}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-nothing-to-fix', mountNonce: 'fixture-mount-nothing-to-fix' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);
    const names = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((node) => node.getAttribute('aria-label') ?? node.textContent ?? '');
    expect(names.some((name) => /^Fix\b/u.test(name))).toBe(false);
    const more = await fixture.queryByRole('button', { name: 'More actions' });
    if (more !== undefined) {
      await fixture.press(more);
      await expect(fixture.queryByRole('menuitem', { name: 'Fix' })).resolves.toBeUndefined();
    }
    // What the entry can do still stands: its question.
    await expect(fixture.getByRole('button', { name: 'Ask' })).resolves.toBeDefined();
  });

  it('names the settled agent on a row-opened pull request from first paint, while its workspace still reads (F10)', async () => {
    // Opening a row: the next pull request's review preparation is still pending at first paint. The primary already
    // names the agent the last entry settled on, so "Review with Claude Code" never draws as "Review" and grows,
    // and Ask and ⋯ beside it never move when the preparation and the default agent land.
    let entryId = 'pr-a';
    let preparation: 'ready' | 'pending' = 'ready';
    let holdReads = false;
    const held: Array<() => void> = [];
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open', entryRef: testkitEntryRef({ entryId, kindId: 'pull-request' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="pullRequest"
        viewerIsAuthor={false}
        reviewPreparation={preparation}
        onAction={() => null}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-row-width', mountNonce: 'fixture-mount-row-width' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: async ({ action }) => {
        const id = typeof action === 'string' ? action : action.localId;
        if (holdReads) await new Promise<void>((resolve) => { held.push(resolve); });
        if (id === 'agents.backends.list') return { defaultTargetKey: 'backend:claude', items: [{
          targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
          identity: { pluginId: 'happier.claude', localId: 'claude' },
        }] } as never;
        if (id === 'projects.list') return { items: [], truncated: false } as never;
        throw new Error(`Unexpected Action ${id}`);
      } },
    });
    mounted.push(fixture);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    await expect(fixture.getByRole('button', { name: 'Review with Claude Code' })).resolves.toBeDefined();
    const row = () => Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((node) => node.getAttribute('aria-label') ?? node.textContent ?? '').filter((name) => name !== '');
    const settledRow = row();

    // The row opens the next pull request: its workspace and its own default agent both still read.
    holdReads = true;
    entryId = 'pr-b';
    preparation = 'pending';
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(row()).toEqual(settledRow);

    preparation = 'ready';
    holdReads = false;
    await act(async () => {
      for (const release of held.splice(0)) release();
      await fixture.updateSurface(createSurfaceContextFixture());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(row()).toEqual(settledRow);
  });

  it('names the Account\'s preferred Agent from first paint, unchanged when the catalog read lands (F10)', async () => {
    // A cold document: the host's surface context already names the preferred Agent, so the primary draws
    // "Review with Codex" before `agents.backends.list` answers, and the same words after.
    const held: Array<() => void> = [];
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open', entryRef: testkitEntryRef({ entryId: 'pr-preferred', kindId: 'pull-request' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        // A repository no earlier entry in this document settled, so no last-known default answers for it.
        repository={{ kind: 'github', deployment: 'github.com', repository: 'acme/preferred-agent' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="pullRequest"
        viewerIsAuthor={false}
        reviewPreparation="ready"
        onAction={() => null}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-preferred', mountNonce: 'fixture-mount-preferred' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture({ preferredAgent: { targetKey: 'backend:codex', label: 'Codex' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: async ({ action }) => {
        const id = typeof action === 'string' ? action : action.localId;
        await new Promise<void>((resolve) => { held.push(resolve); });
        if (id === 'agents.backends.list') return { defaultTargetKey: 'backend:codex', items: [{
          targetKey: 'backend:codex', label: 'Codex', enabled: true,
          identity: { pluginId: 'happier.codex', localId: 'codex' },
        }] } as never;
        if (id === 'projects.list') return { items: [], truncated: false } as never;
        throw new Error(`Unexpected Action ${id}`);
      } },
    });
    mounted.push(fixture);
    const row = () => Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((node) => node.getAttribute('aria-label') ?? node.textContent ?? '').filter((name) => name !== '');
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    const firstPaint = row();
    expect(firstPaint).toContain('Review with Codex');
    await act(async () => {
      for (const release of held.splice(0)) release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      for (const release of held.splice(0)) release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(row()).toEqual(firstPaint);
  });

  it('orders the wide row as the house header does: Ask, the primary, then ⋯ on the trailing edge', async () => {
    // UI refinements 2026-11-23 08:22Z: "…" sits on the trailing edge at the same x on every page, the primary nearest it.
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{ kind: 'entry', sectionId: 'open', entryRef: testkitEntryRef({ entryId: 'pr-order', kindId: 'pull-request' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="pullRequest"
        viewerIsAuthor={false}
        reviewPreparation="ready"
        onAction={() => null}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-row-order', mountNonce: 'fixture-mount-row-order' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { executeAction: async ({ action }) => {
        const id = typeof action === 'string' ? action : action.localId;
        if (id === 'agents.backends.list') return { defaultTargetKey: 'backend:claude', items: [{
          targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
          identity: { pluginId: 'happier.claude', localId: 'claude' },
        }] } as never;
        if (id === 'projects.list') return { items: [], truncated: false } as never;
        throw new Error(`Unexpected Action ${id}`);
      } },
    });
    mounted.push(fixture);
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    await expect(fixture.getByRole('button', { name: 'Review with Claude Code' })).resolves.toBeDefined();
    const names = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((node) => node.getAttribute('aria-label') ?? node.textContent ?? '');
    const primary = names.indexOf('Review with Claude Code');
    expect(names.indexOf('Ask')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Ask')).toBeLessThan(primary);
    expect(names.indexOf('More actions')).toBeGreaterThan(primary);
  });

  it('dispatches the exact formal review action that was pressed', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const actions = [
      formalAction('formal-review-one', 'Security review'),
      formalAction('formal-review-two', 'Architecture review'),
    ];
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: '17', kindId: 'pull-request' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={actions}
        workflowSubject="pullRequest"
        viewerIsAuthor={false}
        reviewPreparation="ready"
        onAction={(request) => { requests.push(request); }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-192', mountNonce: 'fixture-mount-192' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);

    await fixture.press(await fixture.getByRole('button', { name: 'Security review' }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.action.actionId).toBe('formal-review-one');

    // One filled primary; every other action is one press behind the header's More actions.
    await expect(fixture.queryByRole('button', { name: 'Architecture review' })).resolves.toBeUndefined();
    await fixture.press(await fixture.getByRole('button', { name: 'More actions' }));
    // More is the shared menu: its rows are menu items in the menu's own anatomy, never buttons or a form.
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Architecture review' }));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.action.actionId).toBe('formal-review-two');
  });

  it('keeps the agent start destinations on the primary\'s own caret, not in the row\'s ⋯', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const edited: string[] = [];
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: 't2', kindId: 'task' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        withoutRepository
        onAction={(request) => { requests.push(request); }}
        onEditAction={(actionId) => { edited.push(actionId); }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-split', mountNonce: 'fixture-mount-split' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);

    // One split (owner ruling 2026-11-07): the face uses the action's launch mode; the chevron offers the other one.
    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Add instructions…' }));
    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Start now' }));
    expect(requests.map((request) => request.launchMode)).toEqual(['review', 'start']);
    expect(requests.every((request) => request.destinationChoice === undefined)).toBe(true);
    // Edit action… follows the two launches and opens the actions editor on the primary action itself.
    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((node) => node.textContent?.trim());
    expect(items.slice(0, 3)).toEqual(['Start now', 'Add instructions…', 'Edit action…']);
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Edit action…' }));
    expect(edited).toHaveLength(1);
    expect(TRIAGE_DEFAULT_ACTIONS_V1.some((action) => action.actionId === edited[0])).toBe(true);
    expect(requests).toHaveLength(2);
    // The chooser it replaces is gone: the composer's own agent and where chips are that choice.
    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    await expect(fixture.queryByRole('menuitem', { name: 'Choose agent and machine…' })).resolves.toBeUndefined();

    // Nothing but those destinations lived in ⋯ for this entry, so the row draws none.
    await expect(fixture.queryByRole('button', { name: 'More actions' })).resolves.toBeUndefined();
  });

  it('sends to a recent Session by its qualified address, and lists only Sessions it can address', async () => {
    const committed: unknown[] = [];
    const controls = createPluginUiActionControlTestHost(async ({ input }) => {
      committed.push(input);
      return { ok: true, result: null };
    });
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: 't3', kindId: 'task' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        withoutRepository
        onAction={() => { throw new Error('A recent Send is a host commit'); }}
        sendControl={{ prepare: async (_request, _options, session) => ({ input: session }),
          onSettled: () => undefined }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-recent', mountNonce: 'fixture-mount-recent' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true, actionBindings: controls }),
      handlers: { readSession: async ({ sessionId }) => ({
        sessionId, serverId: 'home-a', lifecycle: 'active', runtime: 'idle', operational: 'ready',
        workStatus: { state: 'ready', bucket: 'finished', tone: 'neutral', attentionType: null, word: 'Ready' },
        pendingPermissions: [],
        acceptedWorkspace: { checkout: { serverId: 'home-a', workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/workspaces/qa' } },
      }), executeAction: async ({ action }) => {
        const id = typeof action === 'string' ? action : action.localId;
        if (id === 'agents.backends.list') return { defaultTargetKey: null, items: [] } as never;
        if (id === 'projects.list') return { items: [], truncated: false } as never;
        if (id === 'session.list') {
          return { sessions: [
            { id: 'session-a', serverId: 'home-a', title: 'Investigate sign in', active: false, presence: null, updatedAt: 20 },
            { id: 'session-b', title: 'No known Home', active: false, presence: null, updatedAt: 10 },
            { id: 'session-c', serverId: 'home-a', title: 'Checkout retry', active: true, presence: null, updatedAt: 30,
              path: '/home/me/.happier/workspaces/38b5311d8cc9936b17aa426156ddf6bc086082e614166e8d384257436ef7b6a6', host: 'studio-mac', runtimeActivityState: 'active' },
            { id: 'session-d', serverId: 'home-a', title: 'checkout-web', active: false, presence: null, updatedAt: 5,
              path: 'C:\\src\\checkout-web', host: 'build-box' },
          ], nextCursor: null, hasNext: false } as never;
        }
        throw new Error(`Unexpected Action ${id}`);
      } },
    });
    mounted.push(fixture);

    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    await vi.waitFor(() => expect(fixture.getByRole('menuitem', { name: 'Investigate sign in' })).resolves.toBeDefined());
    // Each row says where it runs, and what it is doing only when that is a fact the host states.
    // A managed workspace's content-hash folder is never shown as its name.
    await expect(fixture.getByText('Working · studio-mac')).resolves.toBeDefined();
    // A workspace already named by the title is not said twice.
    await expect(fixture.getByText('build-box')).resolves.toBeDefined();
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Investigate sign in' }));
    expect(committed).toEqual([{ serverId: 'home-a', sessionId: 'session-a' }]);

    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    await expect(fixture.queryByRole('menuitem', { name: 'No known Home' })).resolves.toBeUndefined();
  });

  it('shows the three most recent Sessions, then the way to find the rest (lab t1 start)', async () => {
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: 't3', kindId: 'task' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1}
        workflowSubject="issue"
        viewerIsAuthor
        reviewPreparation="unsupported"
        withoutRepository
        onAction={() => undefined}
        sendControl={{ prepare: async () => null, onSettled: () => undefined }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-recent', mountNonce: 'fixture-mount-recent' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { readSession: async ({ sessionId }) => ({
        sessionId, serverId: 'home-a', lifecycle: 'active', runtime: 'idle', operational: 'ready',
        workStatus: { state: 'ready', bucket: 'finished', tone: 'neutral', attentionType: null, word: 'Ready' },
        pendingPermissions: [],
        acceptedWorkspace: { checkout: { serverId: 'home-a', workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/workspaces/qa' } },
      }), executeAction: async ({ action }) => {
        const id = typeof action === 'string' ? action : action.localId;
        if (id === 'agents.backends.list') return { defaultTargetKey: null, items: [] } as never;
        if (id === 'projects.list') return { items: [], truncated: false } as never;
        if (id === 'session.list') {
          return { sessions: [
            { id: 'recent-1', serverId: 'home-a', title: 'Recent 1', active: false, presence: null, updatedAt: 49 },
            { id: 'recent-2', serverId: 'home-a', title: 'Recent 2', active: false, presence: null, updatedAt: 48 },
            { id: 'recent-3', serverId: 'home-a', title: 'Recent 3', active: false, presence: null, updatedAt: 47 },
            { id: 'recent-4', serverId: 'home-a', title: 'Recent 4', active: false, presence: null, updatedAt: 46 },
            { id: 'recent-5', serverId: 'home-a', title: 'Recent 5', active: false, presence: null, updatedAt: 45 },
          ], nextCursor: null, hasNext: false } as never;
        }
        throw new Error(`Unexpected Action ${id}`);
      } },
    });
    mounted.push(fixture);

    await fixture.press(await fixture.getByRole('button', { name: 'Start options' }));
    await vi.waitFor(() => expect(fixture.getByRole('menuitem', { name: 'Recent 1' })).resolves.toBeDefined());
    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent ?? '');
    const recent = rows.filter((row) => row.startsWith('Recent '));
    expect(recent).toEqual(['Recent 1', 'Recent 2', 'Recent 3']);
    const find = rows.findIndex((row) => row.startsWith('Find a Session'));
    expect(find).toBeGreaterThan(rows.findIndex((row) => row.startsWith('Recent 3')));
  });

  it('says why a press started nothing instead of doing nothing', async () => {
    const surface = defineUiSurface(() => (
      <TriageEntryActionControls
        target={{
          kind: 'entry',
          sectionId: 'open',
          entryRef: testkitEntryRef({ entryId: '17', kindId: 'pull-request' }),
          sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        }}
        actions={[formalAction('formal-review-one', 'Security review')]}
        workflowSubject="pullRequest"
        viewerIsAuthor={false}
        reviewPreparation="ready"
        // The catalog changed between render and press: the action is gone.
        onAction={async () => ({ kind: 'missing' as const })}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-refused', mountNonce: 'fixture-mount-refused' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    mounted.push(fixture);

    await fixture.press(await fixture.getByRole('button', { name: 'Security review' }));
    await expect(fixture.getByText('That action is no longer available for this entry.'))
      .resolves.toBeDefined();
  });

  it('keeps the primary\'s whole word in a narrow phone band: Ask yields into ⋯, and comes back when the band widens', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const entryRef = testkitEntryRef({ kindId: 'error-issue', entryId: 'narrow-band' });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'narrow-band', mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageEntryActionControls compact
        target={{ kind: 'entry', sectionId: 'open', entryRef, sourceInstanceId: '11111111-1111-4111-8111-111111111111' }}
        actions={TRIAGE_DEFAULT_ACTIONS_V1} workflowSubject="errorIssue" viewerIsAuthor={false}
        reviewPreparation="unsupported" taskDraft={{ title: 'Checkout fails after payment', originError: { entryRef,
          display: { title: 'Checkout fails after payment', scopeLabel: 'Production' } } }}
        onAction={(request) => { requests.push(request); }} />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);
    await fixture.getByRole('button', { name: 'Ask' });
    // RNW reports layout through the element's handler; jsdom lays nothing out, so the test hands it the widths.
    const layout = (testID: string, width: number) => act(() => {
      const node = document.querySelector(`[data-testid="${testID}"]`) as unknown as
        { __reactLayoutHandler?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void } | null;
      node?.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 36 } } });
    });
    // The band has 200 px; the primary, Ask and ⋯ need 260 at their own widths.
    layout(TRIAGE_ACTION_BAND_ROOM_TEST_ID_V1, 200);
    layout(TRIAGE_ACTION_BAND_CONTROLS_TEST_ID_V1, 260);
    await expect(fixture.queryByRole('button', { name: 'Ask' })).resolves.toBeUndefined();
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'More actions' })); });
    // The question that left the band leads the menu, ahead of rarer rows such as Make task.
    expect((await fixture.getAllByRole('menuitem'))[0]?.name).toBe('Ask');
    await act(async () => { await fixture.press(await fixture.getByRole('menuitem', { name: 'Ask' })); });
    expect(requests.map((request) => request.action.actionId)).toEqual(['ask']);
    // Room for all three again: Ask returns beside the primary.
    layout(TRIAGE_ACTION_BAND_ROOM_TEST_ID_V1, 300);
    await expect(fixture.getByRole('button', { name: 'Ask' })).resolves.toBeDefined();
  });
});

async function mountSourceWrite(sourceWrite: TriageDetailPrimaryWriteV1, id: string, compact = false,
  actions: readonly TriageActionV1[] = [formalAction('formal-review-one', 'Review')],
  actionHost?: ReturnType<typeof createPluginUiActionControlTestHost>): Promise<PluginUiTestkit> {
  const surface = defineUiSurface(() => (
    <TriageEntryActionControls
      target={{
        kind: 'entry',
        sectionId: 'open',
        entryRef: testkitEntryRef({ entryId: '17', kindId: 'pull-request' }),
        sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      }}
      actions={actions}
      workflowSubject="pullRequest"
      viewerIsAuthor={false}
      reviewPreparation="ready"
      onAction={() => null}
      sourceWrite={sourceWrite}
      compact={compact}
    />
  ));
  const fixture = await createPluginUiTestkit({
    ...(actionHost ? { handlers: { actionControl: actionHost.handler } } : {}),
    identity: { instanceId: `fixture-instance-${id}`, mountNonce: `fixture-mount-${id}` },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
  });
  mounted.push(fixture);
  return fixture;
}

describe("the source's own write in the header", () => {
  it('lets the host own an offered PR button press without calling plugin automation', async () => {
    const sent: unknown[] = [];
    const host = createPluginUiActionControlTestHost(async request => { sent.push(request); return { ok: true, result: null }; });
    const actionRef = { pluginId: 'happier.scm-github', localId: 'mark-ready' };
    const settlements: unknown[] = [];
    await mountSourceWrite({ title: 'Mark ready', disabledReason: null, pending: false, actionRef,
      execute: async () => { throw new Error('Raw execution is not a UI press'); },
      controllerFor: () => ({ prepare: async () => ({ input: { revision: 'reviewed' } }),
        onSettled: execution => { settlements.push(execution); } }) }, 'host-primary', false, [], host);
    await act(async () => { await host.press('Mark ready'); });
    expect(sent).toEqual([{ action: actionRef, input: { revision: 'reviewed' }, signal: expect.any(AbortSignal) }]);
    expect(settlements).toEqual([{ ok: true, result: null }]);
  });

  // Mirrors the existing expanded-status carrier emitted by the GitLab jobs read, including its issued request ID.
  const checksRequestId = 'gitlab-pipeline-jobs-request-91';
  function checksWrite(state: 'merge' | 'queue' | 'autoMerge' = 'merge', failedRead = true): TriageDetailPrimaryWriteV1 {
    const value = TriagePullRequestStatusV1Schema.parse({
      kind: 'status', observedAtMs: 1_000,
      branch: { head: 'topic', base: 'main', headRevision: 'a'.repeat(40) },
      checks: { state: 'unknown', passed: null, failed: null, pending: null, total: null, rows: [], incomplete: true,
        ...(failedRead ? { failure: { class: 'permission', code: 'forbidden', requestId: checksRequestId } } : {}) },
      review: { decision: 'approved', reviewers: [{ id: '41', name: 'Mara Chen', verb: 'approved' }], incomplete: false },
      merge: { state: 'mergeable', blocker: null, conflicts: false,
        ...(state === 'queue' ? { queue: { id: 'queue-7', state: 'queued', position: 2 } } : {}),
        ...(state === 'autoMerge' ? { autoMerge: { enabled: true, method: 'squash' } } : {}) },
      facts: [], operations: operationOffers,
    });
    return {
      id: state === 'queue' ? 'dequeue' : 'merge', title: state === 'queue' ? 'Leave queue' : 'Merge',
      disabledReason: null, pending: false, nativeStatus: { kind: 'current', value, checkedAtMs: 2_000 },
      readiness: { label: 'Status incomplete', enabled: true, reason: null }, unmetRequirements: [],
      alternatives: [{ id: state === 'autoMerge' ? 'cancelAutoMerge' : 'updateBranch',
        title: state === 'autoMerge' ? 'Cancel auto-merge' : 'Update branch', disabledReason: null, pending: false,
        execute: async () => { throw new Error('Reading diagnostics must not write'); } }],
      execute: async () => { throw new Error('Reading diagnostics must not write'); },
    };
  }

  async function expectChecksDetails(fixture: PluginUiTestkit): Promise<void> {
    await expect(fixture.queryByText(checksRequestId)).resolves.toBeUndefined();
    await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
    await expect(fixture.getByText('forbidden')).resolves.toBeDefined();
    await expect(fixture.getByText(checksRequestId)).resolves.toBeDefined();
  }

  it.each([false, true])('discloses the issued Checks failure in the header menu while retaining observed facts and choices (compact=%s)', async (compact) => {
    const fixture = await mountSourceWrite(checksWrite(), `checks-diagnostic-${compact}`, compact);
    expect((await fixture.getByRole('button', { name: 'Review' })).state?.disabled).not.toBe(true);
    await fixture.press(await fixture.getByRole('button', { name: 'More actions' }));
    await fixture.getByText('Mara Chen approved');
    await fixture.getByRole('menuitem', { name: 'Update branch' });
    await expectChecksDetails(fixture);
  });

  it.each(['queue', 'autoMerge'] as const)('discloses the issued Checks failure beside the native %s state and its existing action', async (state) => {
    const fixture = await mountSourceWrite(checksWrite(state), `checks-diagnostic-${state}`);
    await fixture.getByText(state === 'queue' ? '#2 in the merge queue' : 'Merges when the requirements are met');
    await fixture.getByRole('button', { name: state === 'queue' ? 'Leave queue' : 'Cancel auto-merge' });
    await expectChecksDetails(fixture);
  });

  it.each([true, false])('keeps Checks diagnostics in the existing card readiness disclosure only when a failed read exists (failedRead=%s)', async (failedRead) => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `checks-diagnostic-card-${failedRead}`, mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageSourceWriteCluster write={checksWrite('merge', failedRead)} sourceLabel="GitLab" />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
    });
    mounted.push(fixture);
    await fixture.press(await fixture.getByRole('button', { name: 'Merge readiness: Status incomplete, GitLab sent only part of it' }));
    await fixture.getByText('Mara Chen approved');
    if (failedRead) await expectChecksDetails(fixture);
    else await expect(fixture.queryByRole('button', { name: 'Details' })).resolves.toBeUndefined();
  });

  it('keeps the wide header overflow at the trailing edge when a source write is present', async () => {
    const fixture = await mountSourceWrite({
      title: 'Dismiss…', reading: true, disabledReason: null, pending: false, execute: async () => {},
    }, 'write-after-more', false, [formalAction('formal-review-one', 'Review'), formalAction('formal-review-two', 'Architecture review')]);
    const labels = [...document.querySelectorAll('[role="button"],button')]
      .map(node => node.getAttribute('aria-label') ?? node.textContent ?? '');
    const more = labels.findIndex(label => label === 'More actions');
    const write = labels.findIndex(label => label.includes('Dismiss…'));
    expect(write).toBeGreaterThanOrEqual(0);
    expect(more).toBeGreaterThan(write);
    await expect(fixture.getByRole('button', { name: 'More actions' })).resolves.toBeDefined();
  });

  it('keeps a phone band to one row: the source write is a row of ⋯, not a button beside the primary', async () => {
    const calls: (string | undefined)[] = [];
    const fixture = await mountSourceWrite({
      title: 'Merge', disabledReason: null, pending: false,
      execute: async (methodId) => { calls.push(methodId); },
    }, 'compact-band', true);
    await expect(fixture.queryByRole('button', { name: 'Merge' })).resolves.toBeUndefined();
    await fixture.press(await fixture.getByRole('button', { name: 'More actions' }));
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Merge' }));
    expect(calls).toEqual([undefined]);
  });

  it('keeps Review pressable while the independent source writer is reading', async () => {
    const fixture = await mountSourceWrite({
      title: 'Merge', reading: true, disabledReason: null, pending: false,
      execute: async () => { throw new Error('Merge must not run'); },
    }, 'independent-source-read');
    expect((await fixture.getByRole('button', { name: 'Review' })).state?.disabled).not.toBe(true);
  });

  it('says nothing under the row while the source read is still out, so the tabs below do not move', async () => {
    const fixture = await mountSourceWrite({
      title: 'Merge', reading: true, disabledReason: 'Reading the current pull request…', pending: false,
      execute: async () => { throw new Error('Merge must not run'); },
    }, 'reading-keeps-the-row-still');
    await fixture.getByRole('button', { name: 'Review' });
    await expect(fixture.queryByText('Reading the current pull request…')).resolves.toBeUndefined();
  });

  it('asks which method before it merges, and passes exactly the chosen one', async () => {
    const calls: (string | undefined)[] = [];
    const fixture = await mountSourceWrite({
      title: 'Merge', disabledReason: null, pending: false,
      methods: [{ id: 'merge', title: 'Create a merge commit' }, { id: 'squash', title: 'Squash and merge' }],
      execute: async (methodId) => { calls.push(methodId); },
    }, 'write-methods');
    // Opening the choice is not a merge: there is no implicit default method.
    await fixture.press(await fixture.getByRole('button', { name: 'Merge' }));
    expect(calls).toEqual([]);
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Squash and merge' }));
    expect(calls).toEqual(['squash']);
  });

  it('offers Merge\'s alternatives in the row\'s one More menu, never a second ⋯ beside Merge', async () => {
    const calls: string[] = [];
    const fixture = await mountSourceWrite({
      id: 'merge', title: 'Merge', disabledReason: null, pending: false,
      readiness: { label: 'Ready to merge', enabled: true, reason: null },
      unmetRequirements: [],
      alternatives: [{
        id: 'updateBranch', title: 'Update branch', disabledReason: null, pending: false,
        execute: async () => { calls.push('updateBranch'); },
      }],
      execute: async () => { calls.push('merge'); },
    }, 'write-alternatives');
    await expect(fixture.queryByRole('button', { name: 'Merge options' })).resolves.toBeUndefined();
    await fixture.press(await fixture.getByRole('button', { name: 'More actions' }));
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Update branch' }));
    expect(calls).toEqual(['updateBranch']);
  });

  it('runs a write without methods directly (Mark ready)', async () => {
    const calls: (string | undefined)[] = [];
    const fixture = await mountSourceWrite({
      title: 'Mark ready', disabledReason: null, pending: false,
      execute: async (methodId) => { calls.push(methodId); },
    }, 'write-ready');
    await fixture.press(await fixture.getByRole('button', { name: 'Mark ready' }));
    expect(calls).toEqual([undefined]);
  });

  it('says why it cannot run beside a disabled control, and shows the source feedback', async () => {
    const calls: (string | undefined)[] = [];
    const fixture = await mountSourceWrite({
      title: 'Merge', disabledReason: 'This branch has conflicts with the base branch.', pending: false,
      methods: [{ id: 'merge', title: 'Create a merge commit' }],
      feedback: 'Merged by someone else a moment ago.',
      execute: async (methodId) => { calls.push(methodId); },
    }, 'write-disabled');
    const control = await fixture.getByRole('button', { name: 'Merge' });
    expect(control.state?.disabled).toBe(true);
    await expect(fixture.getByText('This branch has conflicts with the base branch.')).resolves.toBeDefined();
    await expect(fixture.getByText('Merged by someone else a moment ago.')).resolves.toBeDefined();
    expect(calls).toEqual([]);
  });

  it('offers the source\'s re-read beside a write that waits on a failed read', async () => {
    let retries = 0;
    const fixture = await mountSourceWrite({
      title: 'Merge', disabledReason: 'Needs a fresh read of this pull request.', pending: false,
      retry: () => { retries += 1; }, execute: async () => { throw new Error('Merge must not run'); },
    }, 'write-retry');
    expect((await fixture.getByRole('button', { name: 'Merge' })).state?.disabled).toBe(true);
    await expect(fixture.getByText('Needs a fresh read of this pull request.')).resolves.toBeDefined();
    await fixture.press(await fixture.getByRole('button', { name: 'Retry' }));
    expect(retries).toBe(1);
  });

  it('keeps that reason and its re-read with Merge on a phone, not as a second line under the band', async () => {
    let retries = 0;
    const fixture = await mountSourceWrite({
      title: 'Merge', disabledReason: 'Needs a fresh read of this pull request.', pending: false,
      retry: () => { retries += 1; }, execute: async () => { throw new Error('Merge must not run'); },
    }, 'write-retry-compact', true);
    await expect(fixture.queryByText('Needs a fresh read of this pull request.')).resolves.toBeUndefined();
    await fixture.press(await fixture.getByRole('button', { name: 'More actions' }));
    await fixture.press(await fixture.getByRole('menuitem', { name: 'Retry' }));
    expect(retries).toBe(1);
  });

  it('cannot be pressed again while its write is pending', async () => {
    const calls: (string | undefined)[] = [];
    const fixture = await mountSourceWrite({
      title: 'Merge', disabledReason: null, pending: true,
      methods: [{ id: 'merge', title: 'Create a merge commit' }, { id: 'squash', title: 'Squash and merge' }],
      execute: async (methodId) => { calls.push(methodId); },
    }, 'write-pending');
    const control = await fixture.getByRole('button', { name: 'Merge' });
    expect(control.state?.disabled).toBe(true);
    await expect(fixture.queryByRole('menuitem', { name: 'Squash and merge' })).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('the one primary entry action', () => {
  const ask = Object.freeze({ ...formalAction('ask', 'Ask'), appliesTo: ['pullRequest', 'issue', 'errorIssue', 'other'] as const, workspaceMode: 'reference_only' as const, target: { kind: 'agent' as const, promptInvocationId: null, delivery: 'compose' as const } });
  const fix = Object.freeze({ ...ask, actionId: 'fix', label: 'Fix', workspaceMode: 'repository' as const });
  const review = Object.freeze({ ...ask, actionId: 'review', label: 'Review', appliesTo: ['pullRequest'] as const, workspaceMode: 'pull_request' as const });

  it('leads an error with the existing Investigate action, retaining the configured label and Fix fallback', () => {
    const investigate = TRIAGE_DEFAULT_ACTIONS_V1.find(action => action.actionId === TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1);
    if (investigate === undefined) throw new Error('the shipped catalog must offer investigation');
    const error = { workflowSubject: 'errorIssue' as const, viewerIsAuthor: false };
    expect(readTriagePrimaryActionIdV1([ask, fix, investigate], 'unsupported', error)).toBe(investigate.actionId);
    expect(readTriagePrimaryActionIdV1([ask, fix, { ...investigate, label: 'Diagnose checkout' }], 'unsupported', error)).toBe(investigate.actionId);
    expect(readTriagePrimaryActionIdV1([ask, fix], 'unsupported', error)).toBe(fix.actionId);
  });

  it('is what the entry asks of the reader: review someone else\'s change, fix your own, fix an issue or an error', () => {
    const offered = [ask, fix, review];
    expect(readTriagePrimaryActionIdV1(offered, 'ready', { workflowSubject: 'pullRequest', viewerIsAuthor: false })).toBe('review');
    expect(readTriagePrimaryActionIdV1(offered, 'ready', { workflowSubject: 'pullRequest', viewerIsAuthor: true })).toBe('fix');
    expect(readTriagePrimaryActionIdV1([ask, fix], 'ready', { workflowSubject: 'issue', viewerIsAuthor: false })).toBe('fix');
    expect(readTriagePrimaryActionIdV1([ask, fix], 'ready', { workflowSubject: 'errorIssue', viewerIsAuthor: false })).toBe('fix');
  });

  it('never makes Ask primary while a working action exists, and never a blocked one', () => {
    const security = formalAction('formal-review-one', 'Security review');
    const pr = { workflowSubject: 'pullRequest' as const, viewerIsAuthor: false };
    // A review the source cannot prepare is blocked; the next action that does work leads.
    expect(readTriagePrimaryActionIdV1([ask, security, fix], 'unsupported', pr)).toBe('fix');
    expect(readTriagePrimaryActionIdV1([ask, security], 'unsupported', pr)).toBe('ask');
    expect(readTriagePrimaryActionIdV1([security], 'unsupported', pr)).toBeNull();
    expect(readTriagePrimaryActionIdV1([], 'ready', pr)).toBeNull();
  });

  it('keeps a review that only waits on this entry\'s read in its place, so the kind\'s verb does not flip when the read lands', () => {
    const pr = { workflowSubject: 'pullRequest' as const, viewerIsAuthor: false };
    expect(readTriagePrimaryActionIdV1([ask, fix, review], 'pending', pr)).toBe('review');
  });

  it('keeps Review primary while durable detail is ready and the exact head is still arriving', () => {
    const pr = { workflowSubject: 'pullRequest' as const, viewerIsAuthor: false };
    const pendingHead = resolveTriageReviewPreparationV1({ sourceCanPrepare: true, entryReady: false });
    expect(pendingHead).toBe('pending');
    expect(readTriagePrimaryActionIdV1([ask, fix, review], pendingHead, pr)).toBe('review');
    expect(resolveTriageReviewPreparationV1({ sourceCanPrepare: true, entryReady: true })).toBe('ready');
    expect(resolveTriageReviewPreparationV1({ sourceCanPrepare: false, entryReady: false })).toBe('unsupported');
    expect(resolveTriageReviewPreparationV1({ sourceCanPrepare: false, entryReady: true })).toBe('unsupported');
  });
});
