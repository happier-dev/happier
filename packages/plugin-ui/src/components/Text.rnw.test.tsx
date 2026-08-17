import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Text } from './Text.js';

/**
 * EU-7b, family `Text`.
 *
 * RED at 2026-08-06: the predecessor rendered
 * `createElement('happier-plugin-text', …)` — an intrinsic marker nothing in the
 * host consumes. React DOM renders an unknown tag happily, so the old
 * `react-test-renderer` serialization suite stayed 11/11 green while an author's
 * surface shipped an inert custom element with no typography, no theme colour
 * and no accessibility semantics. That is the "test-renderer illusion" §1.4
 * names, and it is why these assertions are written against a real mount.
 *
 * This mount is supporting evidence only (§7 excludes jsdom from layer 6); the
 * packed browser and device lanes own the gate.
 */
function mountSurface(children: React.ReactNode, context?: SurfaceContext) {
  const resolved = context ?? createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(resolved)} context={resolved}>
      {children}
    </PluginUiProvider>,
  );
}

describe('plugin-ui Text renders real React Native semantics', () => {
  it('never emits a happier-plugin-* marker element', () => {
    const mount = mountSurface(<Text value="Ready" />);

    expect(mount.container.querySelector('happier-plugin-text')).toBeNull();
    expect(mount.container.innerHTML).not.toContain('happier-plugin-');
    expect(mount.container.textContent).toBe('Ready');

    mount.unmount();
  });

  it('mounts as a React Native text host element', () => {
    const mount = mountSurface(<Text value="Ready" />);

    const rendered = mount.container.firstElementChild;
    expect(rendered).not.toBeNull();
    // React Native Web renders `Text` as a `div` carrying its own generated
    // class and the text-direction attribute. A raw intrinsic marker has
    // neither, which is what makes this discriminating.
    expect(rendered?.tagName.toLowerCase()).toBe('div');
    expect(rendered?.getAttribute('dir')).toBe('auto');
    expect(rendered?.className).toContain('css-text');

    mount.unmount();
  });

  it('paints the projected theme, not a package-local palette', () => {
    const context = createSurfaceContext();
    const mount = mountSurface(<Text value="Broken" variant="title" tone="danger" />, context);

    const rendered = mount.container.firstElementChild as HTMLElement;
    expect(rendered.style.fontSize).toBe(`${context.theme.typography.title.fontSize}px`);
    expect(rendered.style.lineHeight).toBe(`${context.theme.typography.title.lineHeight}px`);
    // rgb(255, 59, 48) is the fixture's `colors.danger`; jsdom normalizes hex.
    expect(rendered.style.color.replace(/\s/gu, '')).toBe('rgb(255,59,48)');

    mount.unmount();
  });

  it('applies the user text scale the host projected', () => {
    const unscaled = createSurfaceContext();
    const scaled = createSurfaceContext({ textScale: 1.5 });

    const plain = mountSurface(<Text value="Ready" variant="body" />, unscaled);
    const plainSize = (plain.container.firstElementChild as HTMLElement).style.fontSize;
    plain.unmount();

    const large = mountSurface(<Text value="Ready" variant="body" />, scaled);
    const largeSize = (large.container.firstElementChild as HTMLElement).style.fontSize;
    large.unmount();

    expect(plainSize).toBe(`${unscaled.theme.typography.body.fontSize}px`);
    expect(largeSize).toBe(`${unscaled.theme.typography.body.fontSize * 1.5}px`);
  });

  it('resolves a declared translation key and falls back to author text, never the raw key', () => {
    const context = createSurfaceContext({
      translations: { 'acme.review.ready': 'Prêt' },
      locale: 'fr',
    });

    const declared = mountSurface(
      <Text valueKey="acme.review.ready" fallback="Ready" />,
      context,
    );
    expect(declared.container.textContent).toBe('Prêt');
    declared.unmount();

    const undeclared = mountSurface(
      <Text valueKey="acme.review.missing" fallback="Ready" />,
      context,
    );
    expect(undeclared.container.textContent).toBe('Ready');
    expect(undeclared.container.textContent).not.toContain('acme.review.missing');
    undeclared.unmount();
  });

  it('forwards accessibility identity to the host element', () => {
    const mount = mountSurface(
      <Text value="7 findings" accessibilityLabel="Seven findings" testID="review-count" />,
    );

    const rendered = mount.container.firstElementChild as HTMLElement;
    expect(rendered.getAttribute('aria-label')).toBe('Seven findings');
    expect(rendered.getAttribute('data-testid')).toBe('review-count');

    mount.unmount();
  });
});
