import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import * as authorBarrel from '../../index.public.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';

/**
 * The Review summary as a plugin author reaches it (a pull request page draws its Review with it): from the
 * public author barrel, inside a mounted surface's environment, with no Happier core host.
 */
const { HappierReviewSummary } = authorBarrel;

function inSurface(children: ReactNode) {
  return (
    <HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContext())}>
      {children}
    </HappierUiEnvironmentProvider>
  );
}

function byTestId(root: Element, testID: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

describe('HappierReviewSummary for plugin authors', () => {
  it('draws the Review, its verdict and its first findings, and opens a finding from its row', () => {
    const opened = vi.fn();
    const glance = { sentence: '2 blockers found', tone: 'attention', facts: ['3 findings', '1 of 2 verified'] } as const;
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierReviewSummary
          testID="pr-review"
          heading="Review"
          subject="#2481"
          status={{ label: 'Needs decision', tone: 'quiet' }}
          glance={glance}
          rows={[
            { rowId: 'f1', severity: 'blocker', severityLabel: 'Blocker', title: 'Retry loses the socket', reviewer: 'Claude' },
            { rowId: 'f2', severity: 'high', severityLabel: 'High', title: 'Backoff never resets', reviewer: 'Codex' },
          ]}
          onOpenRow={opened}
          more={<span data-testid="more" />}
          reviewers="Claude and Codex"
          actions={<button data-testid="open-review" />}
        />,
      ),
    );
    try {
      const card = byTestId(mounted.container, 'pr-review')!;
      const content = card.textContent ?? '';
      const glanceParts = [glance.sentence, ...glance.facts];
      for (const part of glanceParts) expect(content.split(part)).toHaveLength(2);
      expect(glanceParts.map(part => content.indexOf(part)))
        .toEqual([...glanceParts.map(part => content.indexOf(part))].sort((left, right) => left - right));
      expect(card.textContent).toContain('#2481');
      expect(byTestId(card, 'review-summary:row:f2')?.textContent).toContain('Backoff never resets');
      expect(byTestId(card, 'more')).not.toBeNull();
      expect(byTestId(card, 'open-review')).not.toBeNull();
      byTestId(card, 'review-summary:row:f1')!.click();
      expect(opened).toHaveBeenCalledWith('f1');
    } finally {
      mounted.unmount();
    }
  });
});

it('uses the requested-verdict fact for a finding-free people Review', () => {
  const words = { running: 'Running', failed: 'Failed', noFindings: 'Nothing to fix', allDecided: 'All decided',
    partialNoFindings: 'Didn’t finish · no findings yet', requestedFromYou: 'Review requested from you', toDecide: (count: number) => `${count} to decide` };
  const review = { state: 'completed', counts: { total: 0, needsDecision: 0 }, needsYou: { requestedVerdict: true } };
  expect(authorBarrel.projectHappierReviewGlance(undefined, review, words))
    .toMatchObject({ sentence: words.requestedFromYou, tone: 'attention' });
  expect(authorBarrel.projectHappierReviewGlance(undefined, { ...review, needsYou: { requestedVerdict: false } }, words))
    .toMatchObject({ sentence: words.noFindings, tone: 'quiet' });
});

it.each(['partial', 'completed'])('describes a finding-free %s Review without implying complete coverage', state => {
  const words = { running: 'Running', failed: 'Failed', noFindings: 'Nothing to fix', allDecided: 'All decided',
    partialNoFindings: 'Didn’t finish · no findings yet', requestedFromYou: 'Review requested from you',
    toDecide: (count: number) => `${count} to decide` };
  const review = { state, counts: { total: 0, needsDecision: 0 }, needsYou: { requestedVerdict: false } };
  expect(authorBarrel.projectHappierReviewGlance(undefined, review, words))
    .toMatchObject({ sentence: state === 'partial' ? words.partialNoFindings : words.noFindings, tone: 'quiet' });
  expect(authorBarrel.projectHappierReviewGlance(undefined, { ...review, needsYou: { requestedVerdict: true } }, words))
    .toMatchObject({ sentence: words.requestedFromYou, tone: 'attention' });
});

it('says on the title line which revision was reviewed, the sha in the code face (U8 R5 T3, lab pr-verdict)', () => {
  const mounted = mountThroughReactNativeWeb(inSurface(<HappierReviewSummary testID="pr-review" heading="Review" subject={null}
    revision={{ label: 'at', value: '9c1e4b2' }} glance={{ sentence: 'Nothing to fix', tone: 'quiet', facts: [] }}
    rows={[]} reviewers="" />));
  try {
    const revision = byTestId(mounted.container, 'review-summary:revision')!;
    expect(revision.textContent).toBe('at 9c1e4b2');
  } finally { mounted.unmount(); }
});
