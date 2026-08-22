// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type {
  TriageEntryRefV1,
  TriageSourceInstanceIdV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import {
  TriageSessionIntentControls,
  planTriageSessionIntentControlsV1,
  type TriageSessionIntentRequestV1,
} from './sessionIntentControls.js';

/**
 * The one source-neutral Session-intent control set (`core/SESSIONS.md` §1, §6).
 *
 * The controls are the header's, not a source's: what a reader may start from a
 * selected entry is decided by the entry's Contract-owned workflow subject and
 * the selected source's declared preparation capability, and by nothing the
 * source's own detail body renders. So these cases assert the exact control set
 * per subject and that nothing else is offered beside it.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111' as TriageSourceInstanceIdV1;

function entryRef(kindId: string, entryId: string): TriageEntryRefV1 {
  return { source: SOURCE, kindId, collisionScope: 'example/repository', entryId };
}

function selected(kindId: string, entryId: string): TriageActionTargetV1 {
  return {
    kind: 'entry',
    sectionId: 'open',
    entryRef: entryRef(kindId, entryId),
    sourceInstanceId: INSTANCE,
  };
}

const mounted: PluginUiTestkit[] = [];

type MountInput = Readonly<{
  target: TriageActionTargetV1;
  workflowSubject: TriageSourceWorkflowSubjectV1;
  preparesReviewWorkspace?: boolean;
}>;

async function mountControls(input: MountInput): Promise<Readonly<{
  fixture: PluginUiTestkit;
  requests: readonly TriageSessionIntentRequestV1[];
}>> {
  const requests: TriageSessionIntentRequestV1[] = [];
  const surface = defineUiSurface((_context: RenderContext) => (
    <TriageSessionIntentControls
      target={input.target}
      workflowSubject={input.workflowSubject}
      preparesReviewWorkspace={input.preparesReviewWorkspace ?? true}
      onIntent={(request) => { requests.push(request); }}
    />
  ));
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.triage',
        pluginVersion: '0.0.0',
        viewId: 'triage-list',
        generation: 'triage-session-intent-controls',
      },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  mounted.push(fixture);
  return { fixture, requests };
}

async function buttonNames(fixture: PluginUiTestkit): Promise<readonly string[]> {
  const buttons = await fixture.queryAllByRole('button');
  return buttons.map((button) => button.name ?? '');
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the common header Session-intent controls', () => {
  it('offers a pull request exactly Ask and Fix / review', async () => {
    const { fixture } = await mountControls({
      target: selected('pull-request', '17'),
      workflowSubject: 'pullRequest',
    });

    // "Exactly" is the whole contract here: a seventh control, a Session
    // picker, or a Review-in-a-Session affordance beside these two would be a
    // second start owner, which is the split brain §7 removes.
    expect(await buttonNames(fixture)).toEqual(['Ask', 'Fix / review']);
  });

  it('offers a code issue exactly Ask and Fix', async () => {
    const { fixture } = await mountControls({
      target: selected('issue', '42'),
      workflowSubject: 'issue',
    });

    expect(await buttonNames(fixture)).toEqual(['Ask', 'Fix']);
  });

  it('offers an error issue exactly Ask and Fix', async () => {
    const { fixture } = await mountControls({
      target: selected('error-group', 'PROJECT-9'),
      workflowSubject: 'errorIssue',
    });

    // An error never reaches a checkout through review preparation, so it is
    // offered the same plain Fix a code issue is — never Fix / review.
    expect(await buttonNames(fixture)).toEqual(['Ask', 'Fix']);
  });

  it('offers any other fixable subject exactly Ask and Fix', async () => {
    const { fixture } = await mountControls({
      target: selected('discussion', '5'),
      workflowSubject: 'other',
    });

    expect(await buttonNames(fixture)).toEqual(['Ask', 'Fix']);
  });

  it('reports the exact selected entry and the orchestrator intent it was pressed for', async () => {
    const { fixture, requests } = await mountControls({
      target: selected('pull-request', '17'),
      workflowSubject: 'pullRequest',
    });

    await act(async () => {
      await fixture.press(await fixture.getByRole('button', { name: 'Ask' }));
    });
    await act(async () => {
      await fixture.press(await fixture.getByRole('button', { name: 'Fix / review' }));
    });

    // Fix / review is the pull request's own wording for the one `fix` intent.
    // A third intent value here would be a second vocabulary the orchestrator's
    // gate does not know.
    expect(requests).toEqual([
      { intent: 'ask', entryRef: entryRef('pull-request', '17'), sourceInstanceId: INSTANCE },
      { intent: 'fix', entryRef: entryRef('pull-request', '17'), sourceInstanceId: INSTANCE },
    ]);
  });

  it('says why a pull request cannot be fixed when its source prepares no workspace', async () => {
    const { fixture, requests } = await mountControls({
      target: selected('pull-request', '17'),
      workflowSubject: 'pullRequest',
      preparesReviewWorkspace: false,
    });

    // The control stays rendered: a pull request's control set does not change
    // shape with a capability. It is disabled with a stated reason instead,
    // because a Fix that always resolves the workspace refusal is a control
    // that silently does nothing.
    expect(await buttonNames(fixture)).toEqual(['Ask', 'Fix / review']);
    await expect(fixture.getByRole('button', {
      name: 'Fix / review',
      state: { disabled: true },
    })).resolves.toBeDefined();
    await expect(fixture.getByText(
      'This source cannot prepare a review workspace, so a pull request cannot be fixed here.',
    )).resolves.toEqual({
      content: 'This source cannot prepare a review workspace, so a pull request cannot be fixed here.',
    });

    // Disabled is the whole guarantee: the mounted semantic surface refuses the
    // press outright, so no intent can leave for a start that would only reach
    // the workspace refusal.
    await expect(fixture.press(await fixture.getByRole('button', { name: 'Fix / review' })))
      .rejects.toThrow(/pressable/u);
    expect(requests).toEqual([]);

    // Ask never materializes a workspace, so it is unaffected by the same
    // absent capability.
    await act(async () => {
      await fixture.press(await fixture.getByRole('button', { name: 'Ask' }));
    });
    expect(requests).toEqual([
      { intent: 'ask', entryRef: entryRef('pull-request', '17'), sourceInstanceId: INSTANCE },
    ]);
  });

  it('states the typed refusal instead of acting on a row nobody selected', async () => {
    const { fixture } = await mountControls({
      target: { kind: 'refused', reason: 'noSelectedEntry' },
      workflowSubject: 'pullRequest',
    });

    // The one action-target reader reads `selection`, never `focus`. A control
    // rendered here would act on whichever row a keyboard cursor happened to
    // be parked on.
    expect(await buttonNames(fixture)).toEqual([]);
    await expect(fixture.getByText('Select an entry to start a session from it.'))
      .resolves.toEqual({ content: 'Select an entry to start a session from it.' });
  });
});

describe('the offered-control plan', () => {
  it('is decided by the workflow subject alone, so split and stacked layouts render one set', () => {
    // The plan takes no layout, no mount, no platform and no source body: the
    // same call answers for the wide split composition and the compact stacked
    // one, which is why §1 can promise the same controls in both.
    expect(planTriageSessionIntentControlsV1('pullRequest').map((control) => control.intent))
      .toEqual(['ask', 'fix']);
    for (const subject of ['issue', 'errorIssue', 'other'] as const) {
      expect(planTriageSessionIntentControlsV1(subject).map((control) => control.intent), subject)
        .toEqual(['ask', 'fix']);
    }
  });
});
