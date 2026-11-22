// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { useReviewWaitsForDecisionV1 } from './decisionPending.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const digest = `sha256:${'2'.repeat(64)}`;

/** The Review owner's own needs-you facts, read through the admitted host Resource (the genuine boundary). */
async function waitsFor(needsYou: Readonly<{ requestedVerdict: boolean; pendingDecisions: boolean }>): Promise<string> {
  const surface = defineUiSurface(() => {
    const waits = useReviewWaitsForDecisionV1('review/one');
    return <Text value={waits ? 'decision first' : 'fix first'} />;
  });
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'review-waits', mountNonce: `waits-${String(needsYou.requestedVerdict)}-${String(needsYou.pendingDecisions)}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        readResource: async () => ({ contentType: 'application/json', digest, bytes: new TextEncoder().encode(JSON.stringify({
          review: { reviewId: 'review/one', state: 'completed', counts: { total: 0, needsDecision: 0 } },
          human: { needsYou: { needsYou: needsYou.requestedVerdict || needsYou.pendingDecisions, ...needsYou } },
        })) }),
        watchResource: async () => ({ digest }),
      },
    });
  });
  try {
    // Until the read lands a Review is taken to wait; read the settled answer.
    await vi.waitFor(() => expect(document.body.textContent).toMatch(/first/));
    await act(async () => { await Promise.resolve(); });
    return document.body.textContent ?? '';
  } finally { await act(async () => { await fixture.dispose(); }); }
}

it('leads with the decision while the reader\'s verdict is requested, even with nothing to fix', async () => {
  expect(await waitsFor({ requestedVerdict: true, pendingDecisions: false })).toContain('decision first');
});

it('leads with the decision while a finding waits, and lets the fix lead once nothing waits', async () => {
  expect(await waitsFor({ requestedVerdict: false, pendingDecisions: true })).toContain('decision first');
  expect(await waitsFor({ requestedVerdict: false, pendingDecisions: false })).toContain('fix first');
});
