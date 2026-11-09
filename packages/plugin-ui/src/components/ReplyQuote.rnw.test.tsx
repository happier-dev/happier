import { act } from 'react';
import { describe, expect, it } from 'vitest';
import * as publicComponents from '@happier-dev/plugin-ui/components';

import { ReplyQuoteExample } from '../../fixtures/external-authoring/src/replyQuoteSurface.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('external author reply quotes', () => {
  it('opens each admitted source and removes both private text and navigation when it becomes unavailable', () => {
    expect(typeof publicComponents.ReplyQuote).toBe('function');
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <ReplyQuoteExample />
    </PluginUiProvider>);
    for (const [id, destination] of [['message', 'message'], ['doc', 'document'], ['task', 'task']]) {
      const quote = mounted.container.querySelector(`[data-testid="author-${id}-quote"]`);
      expect(quote?.getAttribute('role')).toBe('link');
      act(() => (quote as HTMLElement).click());
      expect(mounted.container.textContent).toContain(`Opened ${destination}`);
    }
    expect(mounted.container.textContent).toContain('Private selected passage.');
    const withdraw = [...mounted.container.querySelectorAll('[role="button"]')].find(node => node.textContent?.includes('Withdraw'));
    act(() => (withdraw as HTMLElement).click());
    const unavailable = mounted.container.querySelector('[data-testid="author-doc-quote"]');
    expect(unavailable?.textContent).toContain('Source unavailable');
    expect(mounted.container.textContent).not.toContain('Private selected passage.');
    expect(unavailable?.getAttribute('role')).not.toBe('link');
    act(() => (unavailable as HTMLElement).click());
    expect(mounted.container.textContent).toContain('Opened task');
    mounted.unmount();
  });

  it('sets a passage as its own filled box of words alone, without the reply rule or a second source label', () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <ReplyQuoteExample />
    </PluginUiProvider>);
    const passage = mounted.container.querySelector('[data-testid="author-passage-quote"]') as HTMLElement;
    const reply = mounted.container.querySelector('[data-testid="author-message-quote"]') as HTMLElement;
    // An excerpt reads as running words; its paragraph break doesn't spend a line.
    expect(passage.textContent).toContain('behind the flag first. Then widen it');
    expect(passage.textContent).not.toContain('Mara');
    // The same anatomy core's passages use: a fill and a corner instead of the reply's left rule.
    const box = getComputedStyle(passage);
    expect(box.backgroundColor).not.toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/);
    expect(parseFloat(box.borderTopLeftRadius)).toBeGreaterThan(0);
    expect(parseFloat(box.borderLeftWidth || '0')).toBe(0);
    expect(parseFloat(getComputedStyle(reply).borderLeftWidth)).toBeGreaterThan(0);
    mounted.unmount();
  });
});
