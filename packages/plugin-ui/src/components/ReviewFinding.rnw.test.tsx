import { act, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewFinding } from '@happier-dev/plugin-sdk/reviews';

import { HappierUiEnvironmentProvider } from '../environment/context.js';
import { projectHappierUiEnvironment } from '../environment/projectEnvironment.js';
import * as publicUi from '../index.public.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiPresentationHostProviderInternal } from '../presentationHost/context.js';
import type { HappierDisclosureMotionDriver } from '../presentation/collection/Disclosure.js';
import { HappierDisclosure } from '../presentation/collection/Disclosure.js';
import type { HappierCountedDisclosureFrameProps } from '../presentation/collection/CountedDisclosure.js';
import { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../presentation/collection/collectionMotion.js';
import { resolveHappierWorkTheme, type HappierWorkHost } from '../presentation/work/workTheme.js';

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
  it('renders a core finding with its explicit theme, text host and disclosure without a plugin environment', async () => {
    const environment = projectHappierUiEnvironment(createSurfaceContext());
    const theme = resolveHappierWorkTheme(environment.theme);
    const host: HappierWorkHost = { Text: ({ children, testID }) => <span data-testid={testID}>{children}</span> };
    const Disclosure = (props: HappierCountedDisclosureFrameProps) => (
      <HappierDisclosure {...props} motion={HAPPIER_INSTANT_DISCLOSURE_MOTION} reducedMotion />
    );
    const draw = (expanded: boolean) => (
      <publicUi.HappierReviewFinding rowId="core" finding={finding} severityLabel="High"
        theme={theme} host={host} Disclosure={Disclosure} decisionGlyph={<span>Finding</span>}
        decision={{ value: 'accept', label: 'Accepted' }} expanded={expanded} onToggleExpanded={() => {}}>
        <span data-testid="core-discussion">The retained discussion</span>
      </publicUi.HappierReviewFinding>
    );
    const mounted = mountThroughReactNativeWeb(draw(false));
    try {
      expect(mounted.container.textContent).toContain(finding.title);
      expect(byId(mounted.container, 'review-finding-decision:core')?.textContent).toBe('Accepted');
      expect(byId(mounted.container, 'core-discussion')).toBeNull();
      await mounted.render(draw(true));
      expect(byId(mounted.container, 'review-finding-toggle:core')?.getAttribute('aria-expanded')).toBe('true');
      expect(byId(mounted.container, 'core-discussion')?.textContent).toBe('The retained discussion');
      await mounted.render(draw(false));
      expect(byId(mounted.container, 'core-discussion')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it.each([false, true])('settles finding disclosure through host motion without delaying reduced motion (%s)', async reducedMotion => {
    let finishCollapse: (() => void) | undefined;
    // The platform animation driver is the boundary; the real disclosure owns mounting and accessibility.
    const motion = {
      setHeight: vi.fn(), setOpacity: vi.fn(), animateOpacity: vi.fn(), cancel: vi.fn(),
      animateHeight: vi.fn((_height: number, _durationMs: number, onFinished: () => void) => { finishCollapse = onFinished; }),
    };
    const driver: HappierDisclosureMotionDriver = {
      useMotion: () => motion,
      Body: ({ children, testID }) => <div data-testid={testID}>{children}</div>,
    };
    const draw = (expanded: boolean) => (
      <HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(createSurfaceContext({ reducedMotion }))}>
        <PluginUiPresentationHostProviderInternal host={{ disclosureMotion: driver,
          renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null, renderPopover: () => null }}>
          <publicUi.HappierReviewFinding rowId="motion" finding={finding} severityLabel="High"
            decision={{ value: 'accept', label: 'Accepted' }} decisionControl={<button>Decide</button>}
            expanded={expanded} onToggleExpanded={() => {}}>
            <div data-testid="retained-finding-discussion"><input defaultValue="Unsent question" /></div>
          </publicUi.HappierReviewFinding>
        </PluginUiPresentationHostProviderInternal>
      </HappierUiEnvironmentProvider>
    );
    const mounted = mountThroughReactNativeWeb(draw(false));
    try {
      expect(byId(mounted.container, 'retained-finding-discussion')).toBeNull();
      await mounted.render(draw(true));
      const discussion = byId(mounted.container, 'retained-finding-discussion')!;
      expect(discussion).not.toBeNull();
      expect(byId(mounted.container, 'review-finding-toggle:motion')?.getAttribute('aria-expanded')).toBe('true');
      const question = discussion.querySelector('input')!;
      question.value = 'Keep this question while the finding closes';
      await mounted.render(draw(false));
      expect(byId(mounted.container, 'review-finding-toggle:motion')?.getAttribute('aria-expanded')).toBe('false');
      if (reducedMotion) {
        expect(byId(mounted.container, 'retained-finding-discussion')).toBeNull();
        expect(motion.animateHeight).not.toHaveBeenCalled();
        expect(motion.animateOpacity).not.toHaveBeenCalled();
      } else {
        expect(byId(mounted.container, 'retained-finding-discussion')).toBe(discussion);
        expect(discussion.closest('[aria-hidden="true"]')).not.toBeNull();
        expect(question.value).toBe('Keep this question while the finding closes');
        expect(finishCollapse).toBeTypeOf('function');
        act(() => finishCollapse!());
        expect(byId(mounted.container, 'retained-finding-discussion')).toBeNull();
      }
      expect(byId(mounted.container, 'review-finding-decision:motion')?.textContent).toBe('Accepted');
    } finally { mounted.unmount(); }
  });

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
  it('says the place once: Where draws only the fix, never the facts line\'s file:line again (U8 R4 C1)', () => {
    const labels = { where: 'Where', suggestedFix: 'Suggested fix', verification: 'How it was verified', conversation: 'Conversation' };
    const { patch: _patch, ...unpatched } = finding;
    const draw = (shown: ReviewFinding) => inSurface(<publicUi.HappierReviewFindingBody rowId="f1" finding={shown} labels={labels}
      reviewers={null} conversation={null} />);
    const suggested = mountThroughReactNativeWeb(draw({ ...unpatched, suggestion: 'Keep the draft until save resolves' }));
    try {
      const where = byId(suggested.container, 'review-finding-where:f1')!;
      expect(where.textContent).toContain('Keep the draft until save resolves');
      // A fix in words alone is titled as what it is (U8 R5 C2); Where titles the patched code.
      expect(where.textContent).toContain('Suggested fix');
      expect(where.textContent).not.toContain('Where');
      expect(where.textContent).not.toContain('src/editor.ts');
    } finally { suggested.unmount(); }
    const placeOnly = mountThroughReactNativeWeb(draw(unpatched));
    try { expect(byId(placeOnly.container, 'review-finding-where:f1')).toBeNull(); } finally { placeOnly.unmount(); }
  });
});
