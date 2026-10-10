import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { HappierUiEnvironmentProvider } from '../../environment/context.js';
import { projectHappierUiEnvironment } from '../../environment/projectEnvironment.js';
import * as authorBarrel from '../../index.public.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';

/**
 * The Work update card as a plugin author reaches it: from the public author barrel, inside a
 * mounted surface's environment, with no Happier core host.
 */
const { HappierWorkUpdateCard } = authorBarrel;

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

describe('HappierWorkUpdateCard for plugin authors', () => {
  it('heads the card with mark, title, state word and kind, then the body, facts and actions in order', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkUpdateCard
          testID="deploy-update"
          tone="attention"
          mark={<span data-testid="mark" />}
          title="Release 4.2"
          state="needs you"
          meta="Deploy · 3m"
          facts={[{ id: 'steps', label: '2 of 6 steps' }, { id: 'env', icon: <span data-testid="env-icon" />, label: 'staging' }]}
          leadingAction={<button data-testid="peek" />}
          actions={<button data-testid="approve" />}
        >
          <span data-testid="body" />
        </HappierWorkUpdateCard>,
      ),
    );
    try {
      const card = byTestId(mounted.container, 'deploy-update')!;
      expect(byTestId(card, 'mark')).not.toBeNull();
      expect(byTestId(card, 'deploy-update-title')?.textContent).toBe('Release 4.2');
      expect(byTestId(card, 'deploy-update-state')?.textContent).toBe('needs you');
      expect(byTestId(card, 'deploy-update-kind')?.textContent).toBe('Deploy · 3m');
      expect(byTestId(card, 'body')).not.toBeNull();
      const footer = byTestId(card, 'deploy-update-footer')!;
      expect(byTestId(footer, 'deploy-update-fact:steps')?.textContent).toBe('2 of 6 steps');
      expect(byTestId(footer, 'env-icon')).not.toBeNull();
      // The quiet leading action opens the footer; the answers close it.
      const order = [...footer.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid'));
      expect(order.indexOf('peek')).toBeLessThan(order.indexOf('deploy-update-fact:steps'));
      expect(order.indexOf('deploy-update-fact:env')).toBeLessThan(order.indexOf('approve'));
    } finally {
      mounted.unmount();
    }
  });

  it('draws no footer when there is nothing to state or do, and names slots from the given prefix', () => {
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <HappierWorkUpdateCard testID="update:42" slotTestIDPrefix="update" tone="neutral" mark={null} title="Smoke checks" state="finished" />,
      ),
    );
    try {
      const card = byTestId(mounted.container, 'update:42')!;
      expect(byTestId(card, 'update-title')?.textContent).toBe('Smoke checks');
      expect(byTestId(card, 'update-footer')).toBeNull();
      expect(byTestId(card, 'update-kind')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it('hands the tone ring to the host\'s card and gives healthy work none', () => {
    const seen: Array<unknown> = [];
    const renderSurface = (surface: { testID: string; toneStyle: unknown; children: ReactNode }) => {
      seen.push(surface.toneStyle);
      return <div data-testid={surface.testID}>{surface.children}</div>;
    };
    const mounted = mountThroughReactNativeWeb(
      inSurface(
        <>
          <HappierWorkUpdateCard testID="a" tone="danger" mark={null} title="Scout" state="failed" renderSurface={renderSurface} />
          <HappierWorkUpdateCard testID="b" tone="neutral" mark={null} title="Scout" state="finished" renderSurface={renderSurface} />
        </>,
      ),
    );
    try {
      expect(seen[0]).toEqual(expect.objectContaining({ borderWidth: 1, borderColor: expect.any(String) }));
      expect(seen[1]).toBeNull();
      expect(byTestId(mounted.container, 'a-title')?.textContent).toBe('Scout');
    } finally {
      mounted.unmount();
    }
  });
});
