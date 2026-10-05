import * as React from 'react';
import { Pressable } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierDragGrip } from './DragGrip.js';
import {
  HappierReleaseOutcomePill,
  HappierReleasePreviewCard,
  HappierStagedMoveDock,
  type HappierReleasePreviewColors,
  type HappierReleasePreviewHost,
} from './ReleasePreview.js';

const host: HappierReleasePreviewHost = {
  Text: (props) => <span data-testid={props.testID} data-weight={String(props.style.fontWeight ?? '')}>{props.children}</span>,
  renderGlyph: (glyph) => <i data-glyph={glyph} />,
};

const colors: HappierReleasePreviewColors = {
  surface: 'white',
  border: 'rgba(0,0,0,0.1)',
  divider: 'rgba(0,0,0,0.06)',
  text: 'black',
  textSecondary: 'gray',
  accent: 'blue',
  allowedFill: 'aliceblue',
  refusedFill: 'whitesmoke',
  keycapFill: 'gainsboro',
  shadow: 'black',
};

const gripColors = { glyph: 'gray', activeGlyph: 'black', activeFill: 'white' };

describe('HappierDragGrip', () => {
  it('keeps a quiet pointer drag grip target focusable and reveals its chrome on focus', () => {
    function FocusableGrip() {
      const [revealed, setRevealed] = React.useState(false);
      return <Pressable accessibilityRole="button" accessibilityLabel="Organize Review" onPress={() => undefined}
        onFocus={() => setRevealed(true)} onBlur={() => setRevealed(false)}>
        <HappierDragGrip {...{ revealed }} accessibilityLabel="Move Review" colors={gripColors}
          renderGlyph={() => <i data-glyph="grip" />} testID="grip" />
      </Pressable>;
    }
    const mounted = mountThroughReactNativeWeb(<FocusableGrip />);
    const target = mounted.container.querySelector<HTMLElement>('[role="button"]')!;
    const grip = mounted.container.querySelector<HTMLElement>('[data-testid="grip"]')!;
    expect(getComputedStyle(grip).opacity).toBe('0');
    expect(target.tabIndex).toBe(0);
    React.act(() => target.focus());
    expect(document.activeElement).toBe(target);
    expect(getComputedStyle(grip).opacity).toBe('1');
    React.act(() => target.blur());
    expect(getComputedStyle(grip).opacity).toBe('0');
    mounted.unmount();
  });

  it('shows a revealed, active or touch drag grip without changing the target geometry', async () => {
    const renderGrip = (options: { revealed: boolean; active?: boolean; density?: 'pointer' | 'touch' }) =>
      <HappierDragGrip {...options} accessibilityLabel="Move Review" colors={gripColors}
        renderGlyph={() => <i data-glyph="grip" />} testID="grip" />;
    const mounted = mountThroughReactNativeWeb(renderGrip({ revealed: false }));
    const grip = mounted.container.querySelector<HTMLElement>('[data-testid="grip"]')!;
    expect(getComputedStyle(grip).opacity).toBe('0');
    const pointerWidth = getComputedStyle(grip).width;
    for (const options of [{ revealed: true }, { revealed: false, active: true }, { revealed: false, density: 'touch' as const }]) {
      await mounted.render(renderGrip(options));
      expect(getComputedStyle(grip).opacity).toBe('1');
      expect(grip.getAttribute('aria-label')).toBe('Move Review');
      if (!('density' in options)) expect(getComputedStyle(grip).width).toBe(pointerWidth);
    }
    mounted.unmount();
  });
});

describe('HappierReleasePreviewCard', () => {
  it('names the carried item, then what releasing here does and its consequence', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierReleasePreviewCard
        identity={{ title: 'Review #2481', subtitle: 'Needs you · happier · Studio' }}
        outcome={{ tone: 'allowed', glyph: 'nest', title: 'Put under Fix settings modal remount', detail: 'Reports to it · both keep running' }}
        colors={colors}
        host={host}
        reducedMotion
        testID="preview"
      />,
    );
    const text = mounted.container.textContent ?? '';
    expect(text.indexOf('Review #2481')).toBeLessThan(text.indexOf('Put under Fix settings modal remount'));
    expect(text).toContain('Reports to it · both keep running');
    expect(mounted.container.querySelector('[data-glyph="nest"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="preview"]')?.getAttribute('data-outcome')).toBe('allowed');
    mounted.unmount();
  });

  it('says why a refused target does not take the item, with the refusal mark rather than the effect mark', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierReleasePreviewCard
        identity={{ title: 'Review #2481' }}
        outcome={{ tone: 'refused', glyph: 'nest', title: "Can't put under Docs search index", detail: "It's shared with you read-only, so it can't take reports" }}
        colors={colors}
        host={host}
        reducedMotion
        testID="preview"
      />,
    );
    expect(mounted.container.textContent).toContain("It's shared with you read-only");
    expect(mounted.container.querySelector('[data-glyph="refused"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-glyph="nest"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="preview"]')?.getAttribute('data-outcome')).toBe('refused');
    mounted.unmount();
  });

  it('shows only the identity while nothing under the pointer would take the item', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierReleasePreviewCard identity={{ title: 'Review #2481' }} outcome={null} colors={colors} host={host} reducedMotion />,
    );
    expect(mounted.container.textContent).toBe('Review #2481');
    mounted.unmount();
  });
});

describe('HappierReleaseOutcomePill', () => {
  it('draws only the outcome for an OS drag, whose image the app cannot draw on', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierReleaseOutcomePill
        outcome={{ tone: 'allowed', glyph: 'upload', title: 'Upload here', detail: 'To happier/docs' }}
        colors={colors}
        host={host}
        reducedMotion
      />,
    );
    expect(mounted.container.textContent).toBe('Upload hereTo happier/docs');
    mounted.unmount();
  });
});

describe('HappierStagedMoveDock', () => {
  it('docks the same outcome above the key hints for the staged keyboard move', () => {
    const mounted = mountThroughReactNativeWeb(
      <HappierStagedMoveDock
        outcome={{ tone: 'allowed', glyph: 'nest', title: 'Put under Fix settings modal remount', detail: 'Reports to it · both keep running' }}
        hints={[{ keys: ['↑', '↓'], label: 'Choose a place' }, { keys: ['esc'], label: 'Cancel' }]}
        colors={colors}
        host={host}
        reducedMotion
      />,
    );
    const text = mounted.container.textContent ?? '';
    expect(text.indexOf('Put under')).toBeLessThan(text.indexOf('Choose a place'));
    expect(text).toContain('esc');
    mounted.unmount();
  });
});
