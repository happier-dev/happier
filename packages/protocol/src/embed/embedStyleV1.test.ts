import { describe, expect, it } from 'vitest';

import { EmbedStyleV1Schema } from './embedStyleV1.js';

describe('EmbedStyleV1', () => {
  it('admits shared finish selection and per-part finishes while refusing unknown finish choices', () => {
    const style = { v: 1, finish: 'flat', parts: { card: { finish: 'soft' }, floating: { finish: 'flat' }, composer: { radius: 'xl', finish: 'soft' }, primaryButton: { finish: 'flat' }, secondaryButton: { finish: 'soft' } } };
    expect(EmbedStyleV1Schema.parse(style)).toEqual(style);
    expect(EmbedStyleV1Schema.safeParse({ v: 1, finish: 'glossy' }).success).toBe(false);
    expect(EmbedStyleV1Schema.safeParse({ v: 1, parts: { card: { finish: 'glossy' } } }).success).toBe(false);
  });
  it('admits unresolved presentation token ids and any preset while keeping structural objects closed', () => {
    const style = { v: 1, preset: 'host-defined-preset', colors: { light: { 'future.token': '#123456' } }, parts: { composer: { radius: 'modalCard' } } };
    expect(EmbedStyleV1Schema.parse(style)).toEqual(style);
    for (const invalid of [
      { ...style, css: 'body{}' },
      { ...style, colors: { light: {}, unexpected: {} } },
      { ...style, typography: { css: 'font-face{}' } },
      { ...style, parts: { composer: { radius: 'modalCard', css: '' } } },
      { ...style, parts: { unknownPart: {} } },
      { ...style, colors: { dark: { 'text.primary': 3 } } },
    ]) expect(EmbedStyleV1Schema.safeParse(invalid).success).toBe(false);
  });
});
