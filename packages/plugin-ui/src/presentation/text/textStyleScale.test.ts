import { describe, expect, it } from 'vitest';

import {
  cloneStyleEntryPreservingOwnProps,
  scaleTextStyleMetrics,
  type TextStyleEntryTransform,
} from './textStyleScale.js';

type UnistylesSecret = Readonly<{
  uni__getStyles: () => Readonly<{
    color: string;
    fontSize: number;
    lineHeight: number;
  }>;
  uni__dependencies: readonly symbol[];
}>;

type NestedUnistylesStyle = [
  Readonly<{ hostToken: string; fontSize: number }>,
  [Readonly<{ hostToken: string; unistyles_native_text: UnistylesSecret }>],
];

const scaleUnistylesSecretEntry: TextStyleEntryTransform = <T extends object>(entry, textScale): T => {
  const secret = Reflect.get(entry, 'unistyles_native_text');
  if (!secret || typeof secret !== 'object') return entry;

  const getStyles = Reflect.get(secret, 'uni__getStyles');
  if (typeof getStyles !== 'function') return entry;

  const nextEntry = cloneStyleEntryPreservingOwnProps(entry);
  const nextSecret = cloneStyleEntryPreservingOwnProps(secret);
  Reflect.set(nextSecret, 'uni__getStyles', () => (
    scaleTextStyleMetrics(Reflect.apply(getStyles, secret, []), textScale)
  ));
  Reflect.set(nextEntry, 'unistyles_native_text', nextSecret);
  return nextEntry;
};

describe('scaleTextStyleMetrics', () => {
  it('preserves host fields while scaling nested Unistyles-style entries', () => {
    const dependency = Symbol('dependency');
    const secret: UnistylesSecret = {
      uni__getStyles: () => ({ color: 'blue', fontSize: 12, lineHeight: 16 }),
      uni__dependencies: [dependency],
    };
    const style: NestedUnistylesStyle = [
      { hostToken: 'outer', fontSize: 10 },
      [{ hostToken: 'nested', unistyles_native_text: secret }],
    ];

    const scaled = scaleTextStyleMetrics(style, 1.5, {
      transformEntry: scaleUnistylesSecretEntry,
    });

    expect(scaled[0]).toEqual({ hostToken: 'outer', fontSize: 15 });
    expect(scaled[1][0].hostToken).toBe('nested');
    expect(scaled[1][0].unistyles_native_text).not.toBe(secret);
    expect(scaled[1][0].unistyles_native_text.uni__dependencies).toBe(secret.uni__dependencies);
    expect(scaled[1][0].unistyles_native_text.uni__getStyles()).toEqual({
      color: 'blue',
      fontSize: 18,
      lineHeight: 24,
    });
  });
});
