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

const RAW_USER_ID = 'e47cce90-1361-41c5-8176-11345c8ae910';

async function mountReview(needsDecision: number, sink: Readonly<{ opened: unknown[]; reads: unknown[] }>) {
  const input = createTriageSourceV1Fixture().detailInput;
  const launchInput = { ...input, observation: { ...input.observation,
    entryRef: { source: REVIEW_TRIAGE_SOURCE_V1, ...reviewTriageLocalRefV1('review/one') } } };
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'review', mountNonce: `review-detail-${needsDecision}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(), launchInput,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        openResource: ({ resource }) => { sink.opened.push(resource); },
        // The admitted host Resource is the boundary; the real shared summary reads it.
        readResource: async ({ resource }) => {
          if (typeof resource === 'string' || !('hostRead' in resource)) throw new Error('Expected the admitted Review Resource');
          sink.reads.push(resource);
          const value = resource.hostRead === 'review.get' ? {
            review: { reviewId: 'review/one', state: 'completed', counts: { total: 1, needsDecision } },
            human: { needsYou: { needsYou: needsDecision > 0, pendingDecisions: needsDecision > 0 } },
          } : {
            status: 'loaded', cursor: null, pending: {}, comments: [], unavailableFindings: [],
            rows: [{ rowId: 'finding-1',
              finding: { id: 'finding-1', title: 'Settings modal remounts on every tab switch', severity: 'high',
                category: 'correctness', summary: 'The modal remounts.', filePath: 'SettingsModal.tsx', startLine: 142 },
              comment: { id: 'finding-1', threadId: 'finding-1', body: 'The modal remounts.', reviewId: 'review/one', state: 'open',
                author: { kind: 'user', userId: RAW_USER_ID }, transitions: [], edits: [] } }],
          };
          return { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)), digest };
        },
        watchResource: async () => ({ digest }),
      },
    });
  });
  return fixture;
}

function fillOf(name: string): string {
  const node = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(candidate => candidate.textContent === name);
  if (node === undefined) throw new Error(`No ${name} button`);
  return getComputedStyle(node).backgroundColor;
}

it('embeds the shared Review summary, whose own link opens the selected Review', async () => {
  const sink = { opened: [] as unknown[], reads: [] as unknown[] };
  const fixture = await mountReview(1, sink);
  try {
    const open = await fixture.findByRole('button', { name: 'Open review' });
    await expect(fixture.getByText('Settings modal remounts on every tab switch')).resolves.toBeDefined();
    expect(sink.reads).toContainEqual({ hostRead: 'review.get', input: { reviewId: 'review/one' } });
    // One way into the Review: the summary's own link, never a second full-width button.
    await expect(fixture.queryByRole('button', { name: 'Open Review' })).resolves.toBeUndefined();
    await act(async () => { await fixture.press(open); });
    expect(sink.opened).toEqual([{ kind: 'artifact', artifactId: 'review/one' }]);
  } finally { await act(async () => { await fixture.dispose(); }); }
});

it('says where a finding is, never an id, and states the Review once', async () => {
  const fixture = await mountReview(1, { opened: [], reads: [] });
  try {
    await fixture.findByRole('button', { name: 'Open review' });
    await expect(fixture.getByText('SettingsModal.tsx:142')).resolves.toBeDefined();
    expect(document.body.textContent).not.toContain(RAW_USER_ID);
    // The verdict sentence is the Review's one state; no second "Needs you" beside it.
    await expect(fixture.getByText('1 finding to decide')).resolves.toBeDefined();
    await expect(fixture.queryByText('Needs you')).resolves.toBeUndefined();
  } finally { await act(async () => { await fixture.dispose(); }); }
});

it('leads with Open review while a finding waits for a decision, and quiets it once every finding is decided', async () => {
  const pending = await mountReview(1, { opened: [], reads: [] });
  let waiting: string;
  try {
    await pending.findByRole('button', { name: 'Open review' });
    waiting = fillOf('Open review');
  } finally { await act(async () => { await pending.dispose(); }); }
  const decided = await mountReview(0, { opened: [], reads: [] });
  try {
    await decided.findByRole('button', { name: 'Open review' });
    expect(fillOf('Open review')).not.toBe(waiting);
  } finally { await act(async () => { await decided.dispose(); }); }
});
