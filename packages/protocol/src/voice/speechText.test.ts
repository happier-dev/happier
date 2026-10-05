import { describe, expect, it } from 'vitest';
import { batchSpeechTextForSynthesis, segmentSentencesForSynthesis, resolveVoiceSpeechSegmentLength } from './speechText.js';
import { isVoiceSpeechSynthesisInputWithinLimits, resolveVoiceSpeechSynthesisInputLimits } from './speech.js';

describe('shared speech text policy', () => {
  it('keeps token punctuation, abbreviations and closing quotes while recognizing multilingual sentence ends', () => {
    expect(segmentSentencesForSynthesis('Open index.ts at https://example.com/a?b=yes at 10:30, e.g. with Dr. Smith. "Done!" 你好。继续。'))
      .toEqual(['Open index.ts at https://example.com/a?b=yes at 10:30, e.g. with Dr. Smith.', '"Done!"', '你好。', '继续。']);
  });

  it('waits for dot lookahead and flushes the first useful sentence without de-coalescing the rest', () => {
    expect(resolveVoiceSpeechSegmentLength('Open index.', { force: false, firstSegment: true })).toBe(0);
    expect(resolveVoiceSpeechSegmentLength('Open index.ts. More', { force: false, firstSegment: true })).toBe(14);
    expect(resolveVoiceSpeechSegmentLength('One. Two. ', { force: false, firstSegment: false })).toBe(0);
    expect(resolveVoiceSpeechSegmentLength(`${'x'.repeat(318)} https:`, { force: false, firstSegment: false })).toBe(0);
  });

  it('batches by UTF-8 bytes or characters without losing content or splitting surrogate pairs', () => {
    for (const limits of [{ maxInputUtf8Bytes: 9 }, { maxInputCharacters: 5 }]) {
      const text = '😀界你好。 Then continue. 😀😀😀';
      const batches = batchSpeechTextForSynthesis(text, limits);
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.every((batch) => isVoiceSpeechSynthesisInputWithinLimits(batch, limits))).toBe(true);
      expect(batches.join('').replace(/\s/gu, '')).toBe(text.replace(/\s/gu, ''));
      expect(batches.every((batch) => !/[\ud800-\udbff]$|^[\udc00-\udfff]/u.test(batch))).toBe(true);
    }
    expect(() => batchSpeechTextForSynthesis('😀', { maxInputUtf8Bytes: 3 }))
      .toThrowError(expect.objectContaining({ code: 'provider_settings_invalid' }));
  });

  it('uses the admitted latency target after the first sentence while retaining the output segment maximum', () => {
    const text = 'word '.repeat(30);
    expect(resolveVoiceSpeechSegmentLength(text, { force: false, firstSegment: false, targetChars: 120 })).toBe(150);
    expect(resolveVoiceSpeechSegmentLength(text, { force: false, firstSegment: false })).toBe(0);
    expect(resolveVoiceSpeechSegmentLength('Sure. More', { force: false, firstSegment: true, targetChars: 2000 })).toBe(5);
    expect(resolveVoiceSpeechSegmentLength('x'.repeat(2000), { force: false, firstSegment: false, targetChars: 2000 })).toBe(1024);
  });

  it('resolves the selected endpoint cap and its default through the declaration, rejecting invalid caps', () => {
    const contribution = {
      settings: { schemaVersion: 2 as const, fields: [{
        id: 'inputCap', title: 'Input cap', schema: { type: 'integer' as const, minimum: 1, maximum: 100 },
        default: 7, presentation: { control: 'number' as const, step: 1 },
      }] },
      limits: { synthesize: { maxInputCharacters: 100, maxInputCharactersSettingId: 'inputCap' } },
    };
    expect(resolveVoiceSpeechSynthesisInputLimits({ contribution, settings: {} }).maxInputCharacters).toBe(7);
    const limits = resolveVoiceSpeechSynthesisInputLimits({ contribution, settings: { inputCap: 5 } });
    expect(batchSpeechTextForSynthesis('First. Next.', limits)).toEqual(['First', '.', 'Next.']);
    for (const inputCap of [0, 101, 1.5, '5', null]) {
      expect(() => resolveVoiceSpeechSynthesisInputLimits({ contribution, settings: { inputCap } }))
        .toThrowError(expect.objectContaining({ code: 'provider_settings_invalid' }));
    }
  });
});
