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
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierReviewSummary
          testID="pr-review"
          heading="Review"
          subject="#2481"
          status={{ label: 'Needs decision', tone: 'quiet' }}
          glance={{ sentence: '2 blockers found', tone: 'attention', facts: ['3 findings'] }}
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
      expect(card.textContent).toContain('2 blockers found');
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
