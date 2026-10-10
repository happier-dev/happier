import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ApprovalPrompt, Button, Text } from '@happier-dev/plugin-ui/components';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function AuthorFacts() {
  const [expanded, setExpanded] = useState(false);
  return <>
    <Text testID="facts" value={expanded ? 'Exact reviewed facts' : 'Review facts'} />
    <Button testID="show-facts" title="Show facts" onPress={() => setExpanded(true)} />
  </>;
}

/** Public-author composition: the caller owns the facts and the decision. */
function AuthorReview() {
  const [settled, setSettled] = useState(false);
  return (
    <ApprovalPrompt
      testID="review"
      title="Apply the reviewed change"
      subtitle="Requested by the project integration"
      icon={<Text testID="review-icon" value="!" />}
      chrome={settled ? 'inline' : 'card'}
      footer={settled ? <Text testID="outcome" value="Applied" /> : <Button testID="decide" title="Apply" onPress={() => setSettled(true)} />}
    >
      <AuthorFacts />
    </ApprovalPrompt>
  );
}

describe('public ApprovalPrompt', () => {
  it('keeps the caller facts mounted as its decision settles and its chrome changes', async () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <AuthorReview />
      </PluginUiProvider>
    );
    try {
      expect(mounted.container.querySelector('[data-testid="review"]')?.textContent).toContain('Requested by the project integration');
      expect(mounted.container.querySelector('[data-testid="review-icon"]')).not.toBeNull();
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="show-facts"]')!.click());
      const facts = mounted.container.querySelector('[data-testid="facts"]');
      expect(facts?.textContent).toBe('Exact reviewed facts');
      act(() => mounted.container.querySelector<HTMLElement>('[data-testid="decide"]')!.click());
      expect(mounted.container.querySelector('[data-testid="facts"]')).toBe(facts);
      expect(mounted.container.querySelector('[data-testid="facts"]')?.textContent).toBe('Exact reviewed facts');
      expect(mounted.container.querySelector('[data-testid="decide"]')).toBeNull();
      expect(mounted.container.querySelector('[data-testid="outcome"]')?.textContent).toBe('Applied');
    } finally {
      mounted.unmount();
    }
  });
});
