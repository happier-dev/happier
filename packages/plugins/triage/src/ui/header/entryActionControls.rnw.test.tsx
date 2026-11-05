// @vitest-environment jsdom
import * as React from 'react';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import type { TriageActionV1 } from '../../settings/actions.js';
import {
  readTriagePrimaryActionIdV1,
  resolveTriageReviewPreparationV1,
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from './entryActionControls.js';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

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
});

async function mountSourceWrite(sourceWrite: TriageDetailPrimaryWriteV1, id: string): Promise<PluginUiTestkit> {
  const surface = defineUiSurface(() => (
    <TriageEntryActionControls
      target={{
        kind: 'entry',
        sectionId: 'open',
        entryRef: testkitEntryRef({ entryId: '17', kindId: 'pull-request' }),
        sourceInstanceId: '11111111-1111-4111-8111-111111111111',
      }}
      actions={[formalAction('formal-review-one', 'Review')]}
      workflowSubject="pullRequest"
      viewerIsAuthor={false}
      reviewPreparation="ready"
      onAction={() => null}
      sourceWrite={sourceWrite}
    />
  ));
  const fixture = await createPluginUiTestkit({
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
    const pendingHead = resolveTriageReviewPreparationV1({ sourceCanPrepare: true, workspaceReady: false });
    expect(pendingHead).toBe('pending');
    expect(readTriagePrimaryActionIdV1([ask, fix, review], pendingHead, pr)).toBe('review');
    expect(resolveTriageReviewPreparationV1({ sourceCanPrepare: true, workspaceReady: true })).toBe('ready');
    expect(resolveTriageReviewPreparationV1({ sourceCanPrepare: false, workspaceReady: false })).toBe('unsupported');
  });
});
