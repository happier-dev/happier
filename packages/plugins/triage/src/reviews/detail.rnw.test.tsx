// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { REVIEW_TRIAGE_SOURCE_V1, reviewTriageLocalRefV1 } from '@happier-dev/triage-protocol/v1';
import { renderSurface } from './detail.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('opens the selected Review through the host Artifact resource bridge', async () => {
  const input = createTriageSourceV1Fixture().detailInput;
  const launchInput = { ...input, observation: { ...input.observation,
    entryRef: { source: REVIEW_TRIAGE_SOURCE_V1, ...reviewTriageLocalRefV1('review/one') } } };
  const opened: unknown[] = [];
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'review', mountNonce: 'review-detail' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(), launchInput,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { openResource: ({ resource }) => { opened.push(resource); } },
    });
  });
  try {
    const open = await fixture.findByRole('button', { name: 'Open Review' });
    await act(async () => { await fixture.press(open); });
    expect(opened).toEqual([{ kind: 'artifact', artifactId: 'review/one' }]);
  } finally { await act(async () => { await fixture.dispose(); }); }
});
