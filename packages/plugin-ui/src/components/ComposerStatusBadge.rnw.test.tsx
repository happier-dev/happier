import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { ComposerStatusBadge } from './index.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';

// The native icon renderer is the platform boundary; the item, tone and theme logic remain real.
const host: PluginUiPresentationHost = {
  renderIcon: ({ color, testID }) => <span data-testid={testID} style={{ color }} />,
  renderMarkdown: () => null,
  renderCodeBlock: () => null,
  renderPopover: () => null,
};

function cssColor(color: string): string {
  const probe = document.createElement('div');
  probe.style.color = color;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

function mount(children: React.ReactNode, theme?: Partial<ReturnType<typeof createSurfaceContext>['theme']>) {
  const base = createSurfaceContext();
  const context = theme ? { ...base, theme: { ...base.theme, ...theme } } : base;
  return { context, mount: mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={host}>
      {children}
    </PluginUiProviderInternal>,
  ) };
}

describe('ComposerStatusBadge', () => {
  it('draws a pressable status item on the host state tint that announces its popover', () => {
    const onPress = vi.fn();
    const statusTint = { success: '#e6f4ea', warning: '#fff4e0', attention: '#fff4e0', danger: '#fdecea', info: '#e8eafc', neutral: '#f2f2f7' };
    const { context, mount: view } = mount(
      <ComposerStatusBadge label="PR #482 · checks running" tone="active" icon="branch" opensPopover expanded={false} onPress={onPress} testID="pr" />,
      { statusTint },
    );
    try {
      const item = view.container.querySelector<HTMLElement>('[data-testid="pr"]')!;
      expect(item.getAttribute('role')).toBe('button');
      expect(item.getAttribute('aria-label')).toBe('PR #482 · checks running');
      expect(item.getAttribute('aria-expanded')).toBe('false');
      expect(view.container.querySelector('[data-testid="pr:caret"]')).not.toBeNull();
      const capsule = item.firstElementChild as HTMLElement;
      expect(getComputedStyle(capsule).backgroundColor).toBe(cssColor(statusTint.info));
      expect(getComputedStyle(view.container.querySelector<HTMLElement>('[data-testid="pr:label"]')!).color).toBe(cssColor(context.theme.colors.text));
      expect(getComputedStyle(view.container.querySelector<HTMLElement>('[data-testid="pr:icon"]')!).color).toBe(cssColor(context.theme.colors.info));
      act(() => { item.click(); });
      expect(onPress).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); }
  });

  it('keeps a quiet item plain words: no tint, no caret, and not a button without a press', () => {
    const { mount: view } = mount(
      <ComposerStatusBadge label="Goal: Ship the release" emphasis="quiet" opensPopover testID="goal" />,
    );
    try {
      const item = view.container.querySelector<HTMLElement>('[data-testid="goal"]')!;
      expect(item.getAttribute('role')).not.toBe('button');
      expect(view.container.querySelector('[data-testid="goal:caret"]')).toBeNull();
      const capsule = item.firstElementChild as HTMLElement;
      expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(getComputedStyle(capsule).backgroundColor);
    } finally { view.unmount(); }
  });

  it('softens the tone ink into a tint when an older host snapshot has no state tints', () => {
    const { context, mount: view } = mount(
      <ComposerStatusBadge label="Review requested" tone="warning" testID="review" />,
      { statusTint: undefined },
    );
    try {
      const capsule = view.container.querySelector<HTMLElement>('[data-testid="review"]')!.firstElementChild as HTMLElement;
      const painted = getComputedStyle(capsule).backgroundColor;
      expect(painted).not.toBe(cssColor(context.theme.colors.elevatedSurface));
      expect(painted).toMatch(/^rgba\(.*0\.1\)$/u);
    } finally { view.unmount(); }
  });
});
