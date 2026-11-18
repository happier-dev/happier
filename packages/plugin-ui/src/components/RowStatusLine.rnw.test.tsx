import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RowStatusLine, type RowStatusLineProps } from '../index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';

describe('public row status line', () => {
  it('shows work and trouble together and invokes its named recovery through the public control', async () => {
    const base = createSurfaceContext();
    const context = { ...base, theme: { ...base.theme, statusText: {
      success: '#115522', warning: '#885500', attention: '#774400', danger: '#881122', info: '#224488', neutral: '#555555',
    } } };
    const onPress = vi.fn();
    const props = { text: 'Sign in needed', tone: 'bad', busy: true, numberOfLines: 2,
      action: { label: 'Sign in', onPress, testID: 'recover' }, testID: 'status' } satisfies RowStatusLineProps;
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <RowStatusLine {...props} />
    </PluginUiProvider>);
    expect(view.container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Sign in needed');
    const statusText = [...view.container.querySelectorAll<HTMLElement>('[dir="auto"]')].find(node => node.textContent === props.text)!;
    expect(getComputedStyle(statusText).color).toBe('rgb(136, 17, 34)');
    const marker = [...view.container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(node => getComputedStyle(node).width === '6px')!;
    const markerInk = document.createElement('span');
    markerInk.style.backgroundColor = context.theme.colors.danger;
    expect(getComputedStyle(marker).backgroundColor).toBe(markerInk.style.backgroundColor);
    expect(view.container.querySelector('[data-testid="recover"]')?.getAttribute('aria-label')).toBe('Sign in');
    await act(async () => { view.container.querySelector<HTMLElement>('[data-testid="recover"]')?.click(); });
    expect(onPress).toHaveBeenCalledOnce();
  });
});
