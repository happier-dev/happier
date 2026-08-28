// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
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
    target: { kind: 'reviewStart', promptInvocationId: null },
  });
}

describe('the mounted configured entry action controls', () => {
  it('restores focus to the exact formal review action that opened a chooser', async () => {
    const requests: TriageEntryActionRequestV1[] = [];
    const focused: string[] = [];
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
        preparesReviewWorkspace
        onAction={(request) => { requests.push(request); }}
      />
    ));
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.triage',
        pluginVersion: '0.0.0',
        viewId: 'configured-entry-actions',
        generation: 'configured-entry-actions-test',
      },
      surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({
        physicalFocus(target) {
          target.focus();
          const label = document.activeElement?.getAttribute('aria-label');
          if (label !== null && label !== undefined) focused.push(label);
          return true;
        },
      }),
    });
    mounted.push(fixture);

    await fixture.press(await fixture.getByRole('button', { name: 'Security review' }));
    expect(requests).toHaveLength(1);
    await act(async () => { requests[0]?.returnFocusTarget?.focus(); });
    expect(focused.at(-1)).toBe('Security review');

    await fixture.press(await fixture.getByRole('button', { name: 'Architecture review' }));
    expect(requests).toHaveLength(2);
    await act(async () => { requests[1]?.returnFocusTarget?.focus(); });
    expect(focused.at(-1)).toBe('Architecture review');
  });
});
