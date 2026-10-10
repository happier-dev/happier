import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { HappierMaterialSurface } from '../layout/Surface.js';
import {
  HappierSelectionActionBar,
  resolveHappierSelectionActionBarLayout,
  type HappierSelectionActionBarAction,
  type HappierSelectionActionBarHost,
} from './SelectionActionBar.js';

const host: HappierSelectionActionBarHost = {
  Text: (props) => <span data-testid={props.testID} aria-label={props.accessibilityLabel}>{props.children}</span>,
  renderGlyph: (glyph) => <span>{glyph === 'dismiss' ? '✕' : '⋯'}</span>,
  OverflowMenu: (props) => (
    <div data-testid="overflow-menu">
      {props.renderTrigger(() => undefined)}
      {props.items.map((item) => (
        <button key={item.id} type="button" onClick={() => props.onSelect(item.id)}>{item.label}</button>
      ))}
    </div>
  ),
};

const COLORS = { background: 'black', foreground: 'white' } as const;

function actions(onPress: (id: string) => void): readonly HappierSelectionActionBarAction[] {
  return [
    { id: 'copy', label: 'Copy', onPress: () => onPress('copy') },
    { id: 'send', label: 'Send to session', onPress: () => onPress('send') },
    { id: 'ask', label: 'Ask Agent', emphasis: 'primary', onPress: () => onPress('ask') },
  ];
}

const buttonNamed = (container: HTMLElement, name: string) => Array.from(container.querySelectorAll<HTMLElement>('[role="button"]'))
  .find((button) => button.textContent?.includes(name) || button.getAttribute('aria-label') === name);

async function click(element: HTMLElement | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('HappierSelectionActionBar', () => {
  it('finishes its floating rail once without replacing its inverted fill, selection identity or actions when Flat changes', async () => {
    const context = createSurfaceContext();
    const gradient = { colors: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.024)'] as const };
    const pressed: string[] = [];
    const scene = (soft: boolean) => {
      const projected = { ...context, theme: { ...context.theme, surfaceFinish: { floating: soft ? gradient : null } } };
      return <PluginUiProvider context={projected} hostApi={createHostApiStub(projected)}>
        <HappierMaterialSurface materialRole="floating" gradient={gradient}>
        <HappierSelectionActionBar visible label="2 selected" actions={actions(id => pressed.push(id))} dismiss={{ label: 'Clear selection', onPress: () => {} }} colors={COLORS} host={host} reducedMotion testID="bar" />
        </HappierMaterialSurface>
      </PluginUiProvider>;
    };
    const mounted = mountThroughReactNativeWeb(scene(true));
    const paints = () => [...mounted.container.querySelectorAll<HTMLElement>('[data-testid="bar"], [data-testid="bar"] *')]
      .filter(node => getComputedStyle(node).backgroundImage.includes('linear-gradient'));
    expect(paints()).toHaveLength(1);
    expect(getComputedStyle(paints()[0]!).backgroundColor).toContain('black var(--happier-glass-floating-opacity');
    const action = buttonNamed(mounted.container, 'Ask Agent');
    await mounted.render(scene(false));
    expect(paints()).toHaveLength(0);
    expect(buttonNamed(mounted.container, 'Ask Agent')).toBe(action);
    await click(action);
    expect(pressed).toEqual(['ask']);
    expect(mounted.container.textContent).toContain('2 selected');
    mounted.unmount();
  });
  it('says how many are selected, offers the actions in order, and clears with one ✕ named by its label', async () => {
    const pressed: string[] = [];
    let dismissed = 0;
    const mounted = mountThroughReactNativeWeb(
      <HappierSelectionActionBar
        visible
        label="2 selected"
        actions={actions((id) => pressed.push(id))}
        dismiss={{ label: 'Clear selection', onPress: () => { dismissed += 1; } }}
        colors={COLORS}
        host={host}
        reducedMotion
        testID="bar"
      />,
    );

    const bar = mounted.container.querySelector('[role="toolbar"]');
    expect(bar?.textContent).toContain('2 selected');
    const text = bar?.textContent ?? '';
    expect(text.indexOf('Copy')).toBeLessThan(text.indexOf('Send to session'));
    expect(text.indexOf('Send to session')).toBeLessThan(text.indexOf('Ask Agent'));

    await click(buttonNamed(mounted.container, 'Ask Agent'));
    expect(pressed).toEqual(['ask']);

    const dismiss = buttonNamed(mounted.container, 'Clear selection');
    // The default dismiss is the ✕ glyph; its name is spoken, never printed beside it.
    expect(dismiss?.textContent).toBe('✕');
    await click(dismiss);
    expect(dismissed).toBe(1);
    mounted.unmount();
  });

  it('prints a dismiss that stops live work, so the one control says what it does', async () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierSelectionActionBar
        visible
        label="Archiving 2 of 5"
        actions={[]}
        dismiss={{ label: 'Stop', presentation: 'label', onPress: vi.fn() }}
        colors={COLORS}
        host={host}
        reducedMotion
      />,
    );
    const buttons = Array.from(mounted.container.querySelectorAll<HTMLElement>('[role="button"]'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Stop');
    mounted.unmount();
  });

  it('keeps nothing on screen when never shown, and leaves at once under reduced motion', async () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierSelectionActionBar visible={false} label="1 selected" actions={[]} dismiss={{ label: 'Clear selection', onPress: vi.fn() }} colors={COLORS} host={host} reducedMotion />,
    );
    expect(mounted.container.querySelector('[role="toolbar"]')).toBeNull();
    await mounted.render(
      <HappierSelectionActionBar visible label="1 selected" actions={[]} dismiss={{ label: 'Clear selection', onPress: vi.fn() }} colors={COLORS} host={host} reducedMotion />,
    );
    expect(mounted.container.querySelector('[role="toolbar"]')).not.toBeNull();
    await mounted.render(
      <HappierSelectionActionBar visible={false} label="1 selected" actions={[]} dismiss={{ label: 'Clear selection', onPress: vi.fn() }} colors={COLORS} host={host} reducedMotion />,
    );
    expect(mounted.container.querySelector('[role="toolbar"]')).toBeNull();
    mounted.unmount();
  });

  it('keeps the last content through the exit, so a cleared bar never flashes empty while it leaves', async () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierSelectionActionBar visible label="3 selected" actions={[]} dismiss={{ label: 'Clear selection', onPress: vi.fn() }} colors={COLORS} host={host} reducedMotion={false} />,
    );
    await mounted.render(
      <HappierSelectionActionBar visible={false} label="0 selected" actions={[]} dismiss={{ label: 'Clear selection', onPress: vi.fn() }} colors={COLORS} host={host} reducedMotion={false} />,
    );
    const toolbar = mounted.container.querySelector('[role="toolbar"]');
    expect(toolbar?.textContent).toContain('3 selected');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(mounted.container.querySelector('[role="toolbar"]')).toBeNull();
    mounted.unmount();
  });
});

describe('resolveHappierSelectionActionBarLayout', () => {
  const list = actions(() => undefined);

  it('shows every action when the bar fits its column', () => {
    const layout = resolveHappierSelectionActionBarLayout({ actions: list, containerWidth: 900, naturalWidth: 520 });
    expect(layout.folded).toBe(false);
    expect(layout.inline.map((action) => action.id)).toEqual(['copy', 'send', 'ask']);
    expect(layout.overflow).toEqual([]);
  });

  it('keeps the primary action in view and folds the quiet ones into ⋯ when the column is narrower than the bar', () => {
    const layout = resolveHappierSelectionActionBarLayout({ actions: list, containerWidth: 360, naturalWidth: 520 });
    expect(layout.folded).toBe(true);
    expect(layout.inline.map((action) => action.id)).toEqual(['ask']);
    expect(layout.overflow.map((action) => action.id)).toEqual(['copy', 'send']);
  });

  it('has nothing to fold before either width is known', () => {
    expect(resolveHappierSelectionActionBarLayout({ actions: list, containerWidth: 0, naturalWidth: 0 }).folded).toBe(false);
  });
});
