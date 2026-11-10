import { Text } from 'react-native';
import { describe, expect, it, onTestFinished } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierFreshnessLine } from './InfoState.js';

describe('HappierFreshnessLine inline', () => {
  it('keeps a page header\'s facts line one row: glyph, words and recovery never wrap beneath each other (R139, D23)', () => {
    // On iOS the inline line wrapped: its words measured at full width dropped under the glyph and Retry under
    // them, so the Usage header grew from one line to three while reads landed (NATIVE-SWEEP n-322).
    const view = mountThroughReactNativeWeb(
      <HappierFreshnessLine testID="line" presentation="inline" colors={{ background: 'transparent', border: 'transparent' }}
        icon={<Text>◷</Text>} action={<Text testID="line-action">Retry</Text>}>
        <Text numberOfLines={1}>As of 4:42 PM · Couldn't read pull requests and branches or sources right now</Text>
      </HappierFreshnessLine>,
    );
    onTestFinished(() => view.unmount());
    const line = view.container.querySelector<HTMLElement>('[data-testid="line"]')!;
    expect(line.style.flexWrap === 'wrap').toBe(false);
    // The recovery keeps its own width beside the shrinking words.
    const action = view.container.querySelector<HTMLElement>('[data-testid="line-action"]')!.parentElement!;
    expect(action.style.flexShrink).toBe('0');
  });
});
