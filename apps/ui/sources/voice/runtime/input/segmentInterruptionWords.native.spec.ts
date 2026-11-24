import { describe, expect, it, vi } from 'vitest';

// The native tokenizer is an OS boundary; normalization and policy remain real.
const boundary = vi.hoisted(() => ({ module: null as null | { segmentWords: (text: string) => string[] } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => boundary.module }));
// Vitest lacks Metro platform resolution. Route to the real native adapter,
// not a substitute for any deterministic transcript or gate logic.
vi.mock('./segmentInterruptionWords', () => import('./segmentInterruptionWords.native'));

import { ensureInterruptionWordSegmentationAvailable, segmentInterruptionWords } from './segmentInterruptionWords.native';
import { DEFAULT_BACKCHANNEL_GATE, resolveBackchannelDecision } from './resolveBackchannelDecision';

describe('native interruption word segmentation capability', () => {
    it('refuses an installed binary without word segmentation explicitly instead of weakening the word gate', () => {
        boundary.module = null;
        expect(() => ensureInterruptionWordSegmentationAvailable()).toThrow('voice_text_segmentation_unavailable');
        expect(() => segmentInterruptionWords('สวัสดีครับ')).toThrow('voice_text_segmentation_unavailable');
    });

    it('keeps the real word gate meaningful when the installed OS segments unspaced text', () => {
        boundary.module = { segmentWords: (text) => text === 'สวัสดีครับ' ? ['สวัสดี', 'ครับ'] : ['กรุณา', 'เปิด', 'ไฟล์', 'ล่าสุด'] };
        const speaking = { speakingElapsedMs: DEFAULT_BACKCHANNEL_GATE.protectedHeadMs };
        expect(resolveBackchannelDecision({ config: { ignoredPhrases: [] }, transcript: 'สวัสดีครับ', durationMs: 400, speaking }))
            .toEqual({ isBackchannel: true, reason: 'min_words' });
        expect(resolveBackchannelDecision({ config: { ignoredPhrases: [] }, transcript: 'กรุณาเปิดไฟล์ล่าสุด', durationMs: 400, speaking }))
            .toEqual({ isBackchannel: false });
    });
});
