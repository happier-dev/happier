import { act, useCallback, useState } from 'react';
import { describe, expect, it } from 'vitest';

import type { ReviewCommentProposalWithBodyV1 } from '../hostApi/reviewCommentProposals.public.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { ReviewPublicationSheet, useReviewPublicationSelection } from './ReviewPublicationSheet.js';

function proposal(index: number): ReviewCommentProposalWithBodyV1 {
  const id = `proposal-${index}`;
  return {
    v: 1, id, accountId: 'account', workspace: { machineId: 'machine', path: '/repo' },
    body: `Finding ${index}`, bodyVersion: 1, snapshot: { kind: 'none', capturedAt: 1 },
    anchor: { kind: 'file', filePath: `src/file-${index}.ts` },
    finding: { id, title: `Finding ${index}`, severity: 'high', category: 'correctness', summary: `Finding ${index}` },
    author: { kind: 'plugin', pluginId: 'test.reviewer' }, state: 'proposed', flags: {}, dispositions: {},
    threadId: id, edits: [], transitions: [], serverRevision: 1, createdAt: 1, updatedAt: 1,
  };
}

describe('ReviewPublicationSheet rendering cost', () => {
  it('leaves sibling findings untouched while editing the summary or toggling one of 204 proposals', async () => {
    const proposals = Array.from({ length: 204 }, (_, index) => proposal(index));
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    let markRenders = 0;
    const presentationHost = {
      renderMarkdown: () => null,
      renderCodeBlock: () => null,
      renderPopover: () => null,
      renderIcon: () => null,
      renderCheckboxMark: () => { markRenders += 1; return null; },
    };
    const observedSelections: string[][] = [];
    const callbackCalls: string[] = [];
    function Draft({ proposals, callbackVersion }: Readonly<{
      proposals: readonly ReviewCommentProposalWithBodyV1[];
      callbackVersion: string;
    }>) {
      const [summary, setSummary] = useState('Summary');
      const [selectedIds, setSelectedIds] = useReviewPublicationSelection(proposals);
      const updateSelection = useCallback((ids: readonly string[]) => {
        callbackCalls.push(callbackVersion);
        setSelectedIds(ids);
      }, [callbackVersion, setSelectedIds]);
      observedSelections.push([...selectedIds]);
      return <ReviewPublicationSheet
        forgeName="GitHub" verdict={{ options: [{ value: 'comment', label: 'Comment' }], value: 'comment', onChange: () => {} }}
        summary={<button onClick={() => setSummary(current => `${current}!`)}>{summary}</button>}
        proposals={proposals} selectedIds={selectedIds} onSelectedIdsChange={updateSelection}
        preview={null} inlineCommentCount={selectedIds.length} actions={null} blocked={null} onCancel={() => {}}
      />;
    }
    const surface = (proposals: readonly ReviewCommentProposalWithBodyV1[], callbackVersion = 'initial') => (
      <PluginUiProviderInternal context={context} hostApi={hostApi} presentationHost={presentationHost}>
        <Draft proposals={proposals} callbackVersion={callbackVersion} />
      </PluginUiProviderInternal>
    );
    const view = mountThroughReactNativeWeb(surface(proposals));
    try {
      expect(view.container.querySelectorAll('[role="checkbox"]')).toHaveLength(204);
      expect(markRenders).toBe(204);
      markRenders = 0;
      act(() => view.container.querySelector<HTMLButtonElement>('button')!.click());
      expect(view.container.textContent).toContain('Summary!');
      expect.soft(markRenders, 'summary editing does not render unchanged finding rows').toBe(0);
      markRenders = 0;

      const checkbox = (index: number) => view.container.querySelector<HTMLElement>(
        `[data-testid="review-publication-finding-proposal-${index}"] [role="checkbox"]`,
      )!;
      act(() => checkbox(0).click());
      expect(checkbox(0).getAttribute('aria-checked')).toBe('false');
      expect(observedSelections.at(-1)).toHaveLength(203);
      expect.soft(markRenders, 'only the changed finding renders').toBe(1);
      markRenders = 0;
      act(() => checkbox(1).click());
      expect(checkbox(1).getAttribute('aria-checked')).toBe('false');
      expect(checkbox(0).getAttribute('aria-checked')).toBe('false');
      expect(observedSelections.at(-1)).toHaveLength(202);
      expect.soft(markRenders).toBe(1);
      markRenders = 0;
      act(() => checkbox(0).click());
      expect(observedSelections.at(-1)).toEqual(proposals.filter(item => item.id !== 'proposal-1').map(item => item.id));
      expect.soft(markRenders).toBe(1);
      markRenders = 0;
      await view.render(surface(proposals.map(item => item.id === 'proposal-50' && item.finding
        ? { ...item, body: 'Updated finding body', bodyVersion: 2, serverRevision: 2, finding: { ...item.finding, title: 'Updated finding' } }
        : item), 'replacement'));
      expect(view.container.querySelector('[data-testid="review-publication-finding-proposal-50"]')?.textContent).toContain('Updated finding');
      expect(checkbox(1).getAttribute('aria-checked')).toBe('false');
      expect.soft(markRenders, 'a changed proposal reaches the mounted row without rendering its siblings').toBe(1);
      markRenders = 0;
      act(() => checkbox(2).click());
      expect(callbackCalls).toEqual(['initial', 'initial', 'initial', 'replacement']);
      expect(checkbox(1).getAttribute('aria-checked')).toBe('false');
      expect(checkbox(2).getAttribute('aria-checked')).toBe('false');
      expect.soft(markRenders).toBe(1);
    } finally {
      view.unmount();
    }
  });
});
