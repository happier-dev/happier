import { act, type ReactNode } from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { HappierModalCardFooterActions } from '../presentation/interaction/ModalCardFooterActions.js';
import { HappierHorizontalScrollEdgeMaskShape } from '../presentation/layout/HorizontalScrollEdgeMask.js';
import { AvatarStack, HorizontalScrollEdgeMask, ModalCardFooterActions, PageLoadingRows } from './index.public.js';
import { Button } from './Button.js';
import { PluginUiProvider } from './PluginUiProvider.js';

function surface(children: ReactNode) {
  const context = createSurfaceContext();
  return <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>{children}</PluginUiProvider>;
}

describe('shared host/plugin compositions', () => {
  it('keeps the first identity in front in a single slot and announces the stack once', async () => {
    const entries = [
      { key: 'person', content: <View testID="person" /> },
      { key: 'team', content: <View testID="team" />, avatar: false },
    ];
    const mount = mountThroughReactNativeWeb(surface(<AvatarStack entries={entries} size={20} slot
      testID="stack" accessibilityLabel="Ada and the team" />));
    try {
      const stack = mount.container.querySelector('[data-testid="stack"]')!;
      expect(stack.getAttribute('aria-label')).toBe('Ada and the team');
      expect([...stack.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))).toEqual(['team', 'person']);
      await mount.render(surface(<AvatarStack entries={entries} size={20} testID="stack" />));
      const unlabelled = mount.container.querySelector('[data-testid="stack"]')!;
      expect(unlabelled.getAttribute('aria-label')).toBeNull();
      expect(unlabelled.getAttribute('role')).toBeNull();
      expect([...unlabelled.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))).toEqual(['person', 'team']);
    } finally { mount.unmount(); }
  });

  it('reserves four page rows and the optional header under one loading announcement', async () => {
    const mount = mountThroughReactNativeWeb(surface(<PageLoadingRows testID="loading" header loadingLabel="Loading the page" />));
    try {
      expect(mount.container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading the page');
      expect(mount.container.querySelector('[data-testid="loading-header"]')).not.toBeNull();
      expect(mount.container.querySelectorAll('[data-testid="loading-skeleton:skeleton-row"]')).toHaveLength(4);
      await mount.render(surface(<PageLoadingRows testID="loading" />));
      expect(mount.container.querySelector('[data-testid="loading-header"]')).toBeNull();
      expect(mount.container.querySelectorAll('[data-testid="loading-skeleton:skeleton-row"]')).toHaveLength(4);
    } finally { mount.unmount(); }
  });

  it('keeps cancel, consequence and actions in reading order with working dismissal', async () => {
    let cancelled = false;
    const mount = mountThroughReactNativeWeb(surface(<ModalCardFooterActions
      cancel={{ onPress: () => { cancelled = true; }, testID: 'cancel' }} cancelLabel="Dismiss"
      note="Nothing starts yet" noteTestID="note"><Button title="Continue" /></ModalCardFooterActions>));
    try {
      expect(mount.container.textContent).toBe('DismissNothing starts yetContinue');
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="cancel"]')!.click(); });
      expect(cancelled).toBe(true);
    } finally { mount.unmount(); }
  });

  it('leaves only the available action children in a phone-sheet footer', () => {
    const mount = mountThroughReactNativeWeb(<HappierModalCardFooterActions phoneSheet gap={8}
      cancel={<View testID="cancel" />} note={<View testID="note" />}>
      {null}{false}<View testID="first" /><View testID="primary" />
    </HappierModalCardFooterActions>);
    try {
      expect([...mount.container.querySelectorAll('[data-testid]')].map(node => node.getAttribute('data-testid'))).toEqual(['first', 'primary']);
    } finally { mount.unmount(); }
  });

  it('uses content alpha masks with the same clipped ramp stops as the native shape', () => {
    const ramps = { start: { clear: 8, solid: 20 }, end: { solid: { fromEnd: 20 }, clear: { fromEnd: 4 } } } as const;
    const mount = mountThroughReactNativeWeb(<HorizontalScrollEdgeMask ramps={ramps} width={100}>
      <View testID="rail" />
    </HorizontalScrollEdgeMask>);
    try {
      const mask = mount.container.querySelector<HTMLElement>('[data-testid="rail"]')!.parentElement!;
      expect(mask.style.maskImage).toBe('linear-gradient(to right, transparent 8px, black 20px, black calc(100% - 20px), transparent calc(100% - 4px))');
    } finally { mount.unmount(); }
    const shape = mountThroughReactNativeWeb(<HappierHorizontalScrollEdgeMaskShape ramps={ramps} width={100}
      renderGradient={({ testID, style }) => <View testID={testID} style={style} />} />);
    try {
      const start = shape.container.querySelector<HTMLElement>('[data-testid="scroll-edge-mask-start"]')!;
      const end = shape.container.querySelector<HTMLElement>('[data-testid="scroll-edge-mask-end"]')!;
      expect([start.style.left, start.style.width, end.style.left, end.style.width]).toEqual(['8px', '12px', '80px', '16px']);
    } finally { shape.unmount(); }
  });
});
