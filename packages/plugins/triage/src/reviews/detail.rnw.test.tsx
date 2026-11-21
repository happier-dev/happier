// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { REVIEW_TRIAGE_SOURCE_V1, reviewTriageLocalRefV1 } from '@happier-dev/triage-protocol/v1';
import { renderSurface } from './detail.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const digest = `sha256:${'1'.repeat(64)}`;

it('embeds the shared Review summary, whose own link opens the selected Review', async () => {
  const input = createTriageSourceV1Fixture().detailInput;
  const launchInput = { ...input, observation: { ...input.observation,
    entryRef: { source: REVIEW_TRIAGE_SOURCE_V1, ...reviewTriageLocalRefV1('review/one') } } };
  const opened: unknown[] = [];
  const reads: unknown[] = [];
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'review', mountNonce: 'review-detail' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(), launchInput,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        openResource: ({ resource }) => { opened.push(resource); },
        // The admitted host Resource is the boundary; the real shared summary reads it.
        readResource: async ({ resource }) => {
          if (typeof resource === 'string' || !('hostRead' in resource)) throw new Error('Expected the admitted Review Resource');
          reads.push(resource);
          const value = resource.hostRead === 'review.get' ? {
            review: { reviewId: 'review/one', state: 'completed', counts: { total: 1, needsDecision: 1 } },
            human: { needsYou: { needsYou: true } },
          } : {
            status: 'loaded', cursor: null, pending: {}, comments: [], unavailableFindings: [],
            rows: [{ rowId: 'finding-1',
              finding: { id: 'finding-1', title: 'Settings modal remounts on every tab switch', severity: 'high',
                category: 'correctness', summary: 'The modal remounts.' },
              comment: { id: 'finding-1', threadId: 'finding-1', body: 'The modal remounts.', reviewId: 'review/one', state: 'open',
                author: { kind: 'plugin', pluginId: 'review-engine' }, transitions: [], edits: [] } }],
          };
          return { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)), digest };
        },
        watchResource: async () => ({ digest }),
      },
    });
  });
  try {
    const open = await fixture.findByRole('button', { name: 'Open review' });
    await expect(fixture.getByText('Settings modal remounts on every tab switch')).resolves.toBeDefined();
    expect(reads).toContainEqual({ hostRead: 'review.get', input: { reviewId: 'review/one' } });
    // One way into the Review: the summary's own secondary link, never a second full-width primary.
    await expect(fixture.queryByRole('button', { name: 'Open Review' })).resolves.toBeUndefined();
    await act(async () => { await fixture.press(open); });
    expect(opened).toEqual([{ kind: 'artifact', artifactId: 'review/one' }]);
  } finally { await act(async () => { await fixture.dispose(); }); }
});
