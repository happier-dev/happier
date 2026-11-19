import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { CollectionConditionTokens } from '@happier-dev/plugin-ui/components';

import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

describe('public condition tokens', () => {
  it('removes the named condition and offers Save only when supplied by the collection owner', async () => {
    const removed: string[] = [];
    let saves = 0;
    const environment = projectHappierUiEnvironment(createSurfaceContextFixture());
    const view = (save: boolean) => <HappierUiEnvironmentProvider environment={environment}>
      <CollectionConditionTokens testIDPrefix="conditions" tokens={[{ id: 'status', label: 'Status', valueLabel: 'Failed' }]}
        labels={{ remove: (field) => `Remove ${field}`, save: 'Save as space…' }} onRemove={(id) => removed.push(id)}
        {...(save ? { onSave: () => { saves += 1; } } : {})} />
    </HappierUiEnvironmentProvider>;
    const mounted = mountThroughReactNativeWeb(view(true));
    try {
      const remove = mounted.container.querySelector('[data-testid="conditions-token:status"]') as HTMLElement;
      expect(remove.getAttribute('aria-label')).toBe('Failed, Remove Status');
      await act(() => remove.click());
      expect(removed).toEqual(['status']);
      const save = mounted.container.querySelector('[data-testid="conditions-tokens-save"]') as HTMLElement;
      expect(save.getAttribute('aria-label')).toBe('Save as space…');
      await act(() => save.click());
      expect(saves).toBe(1);
      await mounted.render(view(false));
      expect(mounted.container.querySelector('[data-testid="conditions-tokens-save"]')).toBeNull();
      expect(mounted.container.textContent).toContain('Failed');
    } finally {
      mounted.unmount();
    }
  });

  // TRIAGE-W1-BROWSER-A r239 (UI refinements 11-18): under My work a stored condition with no words drew a chip
  // holding only its ×. A token with no label is not a chip; its neighbours and Save stay.
  it('draws no chip for a condition that has no words', async () => {
    const environment = projectHappierUiEnvironment(createSurfaceContextFixture());
    const mounted = mountThroughReactNativeWeb(<HappierUiEnvironmentProvider environment={environment}>
      <CollectionConditionTokens testIDPrefix="conditions" tokens={[
        { id: 'unavailableFields', label: 'unavailableFields', valueLabel: '' },
        { id: 'status', label: 'Status', valueLabel: 'Failed' },
        { id: 'blank', label: 'Branch', valueLabel: '  ' },
      ]} labels={{ remove: (field) => `Remove ${field}`, save: 'Save as space…' }} onRemove={() => {}} onSave={() => {}} />
    </HappierUiEnvironmentProvider>);
    try {
      const chips = [...mounted.container.querySelectorAll('[data-testid^="conditions-token:"]')].map((chip) => chip.getAttribute('data-testid'));
      expect(chips).toEqual(['conditions-token:status']);
      expect(mounted.container.querySelector('[data-testid="conditions-tokens-save"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
