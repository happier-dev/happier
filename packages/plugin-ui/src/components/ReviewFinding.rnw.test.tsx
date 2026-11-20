import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';

import { HappierUiEnvironmentProvider } from '../environment/context.js';
import { projectHappierUiEnvironment } from '../environment/projectEnvironment.js';
import * as publicUi from '../index.public.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createSurfaceContext } from '../surfaceFixture.testSupport.js';

const finding: ReviewFinding = {
  id: 'finding', title: 'Retain the draft', severity: 'high', category: 'correctness',
  summary: 'The original explanation', whyItMatters: 'An edit is lost',
  filePath: 'src/editor.ts', startLine: 12, evidence: 'Reopen the editor',
  patch: '--- a/src/editor.ts\n+++ b/src/editor.ts\n@@ -1 +1 @@\n-old\n+new',
};
function inSurface(children: ReactNode) {
  return <HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContext())}>{children}</HappierUiEnvironmentProvider>;
}
function byId(root: Element, id: string) {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('public Review finding presentation', () => {
  it('keeps a persisted read-only decision visible while disclosure controls the shared body', async () => {
    const toggle = vi.fn();
    const draw = (expanded: boolean) => inSurface(
      <publicUi.HappierReviewFinding rowId="f1" finding={finding} severityLabel="High"
        decision={{ value: 'reject', label: 'Ignored' }} decisionEditable={false}
        decisionControl={<button data-testid="edit-decision">Decide</button>}
        expanded={expanded} onToggleExpanded={toggle}>
        <publicUi.HappierReviewFindingBody rowId="f1" finding={finding}
          currentBodyMarkdown="The updated explanation"
          labels={{ where: 'Where', verification: 'How it was verified', conversation: 'Conversation' }}
          reviewers={<span>Claude found it</span>} seenBefore={<span>Earlier review</span>}
          conversation={<span>The retained discussion</span>} />
      </publicUi.HappierReviewFinding>,
    );
    const mounted = mountThroughReactNativeWeb(draw(false));
    try {
      expect(byId(mounted.container, 'review-finding-decision:f1')?.textContent).toBe('Ignored');
      expect(byId(mounted.container, 'review-finding-body:f1')).toBeNull();
      byId(mounted.container, 'review-finding-toggle:f1')!.click();
      expect(toggle).toHaveBeenCalledWith('f1');
      await mounted.render(draw(true));
      expect(byId(mounted.container, 'review-finding-toggle:f1')?.getAttribute('aria-expanded')).toBe('true');
      expect(byId(mounted.container, 'review-finding-decision:f1')?.textContent).toBe('Ignored');
      expect(byId(mounted.container, 'edit-decision')).toBeNull();
      const body = byId(mounted.container, 'review-finding-body:f1')!;
      expect(body.textContent).toContain('An edit is lost');
      expect(body.textContent).toContain('The updated explanation');
      expect(body.textContent).not.toContain('The original explanation');
      expect(body.textContent).toContain('Reopen the editor');
      expect(body.textContent).toContain('Earlier review');
      expect(body.textContent).toContain('The retained discussion');
      expect(body.textContent).toContain('+new');
    } finally { mounted.unmount(); }
  });

  it('uses the host content renderers without losing history or exposing an editor in the body', () => {
    const mounted = mountThroughReactNativeWeb(inSurface(
      <publicUi.HappierReviewFindingBody rowId="f2" finding={finding}
        labels={{ where: 'Where', verification: 'Verified', conversation: 'Discussion' }}
        renderMarkdown={(markdown) => <span data-testid="host-markdown">{markdown}</span>}
        renderWhere={(value) => <span data-testid="host-diff">{value.patch}</span>}
        extensions={<span>Provider evidence</span>} seenBefore={<span>Existing history</span>}
        conversation={<span>Read-only replies</span>} />,
    ));
    try {
      expect(byId(mounted.container, 'host-diff')?.textContent).toContain('+new');
      expect(byId(mounted.container, 'host-markdown')?.textContent).toBe('Reopen the editor');
      expect(mounted.container.textContent).toContain('Provider evidence');
      expect(mounted.container.textContent).toContain('Existing history');
      expect(mounted.container.querySelector('textarea,input')).toBeNull();
    } finally { mounted.unmount(); }
  });
});
