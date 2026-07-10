import { describe, expect, it } from 'vitest';

import {
  mapAntigravityModelIdToSdkModel,
} from './models.js';

describe('Antigravity model mapping', () => {
  it('maps Gemini CLI display labels to SDK raw model ids and thinking levels', () => {
    expect(mapAntigravityModelIdToSdkModel('Gemini 3.5 Flash (Medium)')).toEqual({
      rawModelId: 'gemini-3.5-flash',
      thinkingLevel: 'medium',
    });
    expect(mapAntigravityModelIdToSdkModel('Gemini 3.1 Pro (High)')).toEqual({
      rawModelId: 'gemini-3.1-pro',
      thinkingLevel: 'high',
    });
  });

  it('accepts raw Gemini model ids without adding model options', () => {
    expect(mapAntigravityModelIdToSdkModel('gemini-3.5-flash')).toEqual({
      rawModelId: 'gemini-3.5-flash',
    });
  });

  it('rejects CLI-only labels that the SDK cannot represent', () => {
    expect(() => mapAntigravityModelIdToSdkModel('Claude Sonnet 4.6 (Thinking)')).toThrow(/sdk.*gemini/i);
    expect(() => mapAntigravityModelIdToSdkModel('GPT-OSS 120B (Medium)')).toThrow(/sdk.*gemini/i);
  });
});
