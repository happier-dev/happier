import {
    readCommonPrefixLength,
    type StreamingRevealRange,
} from 'react-native-enriched-markdown/lib/module/web/streamingReveal.js';

/**
 * Single owner of "which characters of a plain streaming text run are new".
 *
 * The enriched surface owns the same decision in the vendored package
 * (`updateStreamingRevealRanges`), where retention TTLs and the appended-source
 * window are needed because its comparison text is rewritten as inline markdown
 * syntax completes. The plain surface receives already-parsed span text and reveals
 * one appended suffix per render, so it needs neither — but it needs the same mount
 * rule, and that rule belongs here rather than in a component ref seed: a second
 * decision site in component lifecycle would leave this function wrong for anyone
 * else who asks it which words are new.
 *
 * A mount — a remount above all — has no baseline: `previousText` is empty while the
 * instance already renders text that is on screen. Diffing against '' makes the whole
 * run look appended, so every word re-enters the reveal and replays its opacity
 * keyframe. Text already present when this owner first compared is not new. Genuine
 * appends after that first comparison still animate word by word.
 */
export function resolveAppendedSuffixRevealRanges(params: Readonly<{
    previousText: string;
    currentText: string;
}>): StreamingRevealRange[] {
    if (params.currentText.length === 0) return [];
    if (params.previousText.length === 0) return [];

    const commonPrefixLength = readCommonPrefixLength(params.previousText, params.currentText);
    if (commonPrefixLength >= params.currentText.length) return [];

    return [{
        start: commonPrefixLength,
        end: params.currentText.length,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
    }];
}
