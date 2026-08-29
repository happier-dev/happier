import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// React Native is the host boundary; the shared text presentation remains real.
vi.mock('react-native', () => ({
  Text: 'Text',
}));

import { HappierText } from './Text.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('HappierText font scaling', () => {
  it('honors an explicit native font-scaling override', async () => {
    await act(async () => {
      renderer = create(<HappierText allowFontScaling={false}>toolbar label</HappierText>);
    });

    const nativeText = renderer!.root.findAll((node) => node.type === 'Text');
    expect(nativeText).toHaveLength(1);
    expect(nativeText[0]!.props.allowFontScaling).toBe(false);
  });
});
