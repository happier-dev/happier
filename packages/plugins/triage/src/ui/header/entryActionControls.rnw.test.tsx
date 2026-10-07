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
  TriageEntryActionControls,
  type TriageEntryActionRequestV1,
} from './entryActionControls.js';

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
        preparesReviewWorkspace
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
    await fixture.press(await fixture.getByRole('button', { name: 'Architecture review' }));
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
        preparesReviewWorkspace
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

describe('the one primary entry action', () => {
  const ask = Object.freeze({ ...formalAction('ask', 'Ask'), appliesTo: ['pullRequest', 'issue', 'errorIssue', 'other'] as const, workspaceMode: 'reference_only' as const, target: { kind: 'agent' as const, promptInvocationId: null, delivery: 'compose' as const } });
  const fix = Object.freeze({ ...ask, actionId: 'fix', label: 'Fix', workspaceMode: 'repository' as const });
  const review = Object.freeze({ ...ask, actionId: 'review', label: 'Review', appliesTo: ['pullRequest'] as const, workspaceMode: 'pull_request' as const });

  it('is what the entry asks of the reader: review someone else\'s change, fix your own, fix an issue or an error', () => {
    const offered = [ask, fix, review];
    expect(readTriagePrimaryActionIdV1(offered, true, { workflowSubject: 'pullRequest', viewerIsAuthor: false })).toBe('review');
    expect(readTriagePrimaryActionIdV1(offered, true, { workflowSubject: 'pullRequest', viewerIsAuthor: true })).toBe('fix');
    expect(readTriagePrimaryActionIdV1([ask, fix], true, { workflowSubject: 'issue', viewerIsAuthor: false })).toBe('fix');
    expect(readTriagePrimaryActionIdV1([ask, fix], true, { workflowSubject: 'errorIssue', viewerIsAuthor: false })).toBe('fix');
  });

  it('never makes Ask primary while a working action exists, and never a blocked one', () => {
    const security = formalAction('formal-review-one', 'Security review');
    const pr = { workflowSubject: 'pullRequest' as const, viewerIsAuthor: false };
    // A review the source cannot prepare is blocked; the next action that does work leads.
    expect(readTriagePrimaryActionIdV1([ask, security, fix], false, pr)).toBe('fix');
    expect(readTriagePrimaryActionIdV1([ask, security], false, pr)).toBe('ask');
    expect(readTriagePrimaryActionIdV1([security], false, pr)).toBeNull();
    expect(readTriagePrimaryActionIdV1([], true, pr)).toBeNull();
  });
});
