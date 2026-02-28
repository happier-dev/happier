import type { FileDiffOptions } from '@pierre/diffs';

import { HAPPIER_PIERRE_THEME_IDS } from './pierreThemeRegistry.web';
import { countTextLinesUpTo } from '@/utils/strings/countTextLinesUpTo';

export type PierreDiffOptionsBaseParams = Readonly<{
    isDark: boolean;
    diffStyle: 'unified' | 'split';
    patchText: string;
    wrapLines: boolean;
    showLineNumbers: boolean;
    showPrefix: boolean;
    tokenizeMaxLineLength: number;
    intraLineDiff: Readonly<{
        enabled: boolean;
        maxPatchLines: number;
        maxLineLength: number;
    }>;
}>;

export function buildPierreDiffOptionsBase<TAnnotation = unknown>(params: PierreDiffOptionsBaseParams): FileDiffOptions<TAnnotation> {
    const patchLineCount = countTextLinesUpTo(params.patchText, params.intraLineDiff.maxPatchLines + 1);
    const disableIntraLineDiff = params.intraLineDiff.enabled !== true || patchLineCount > params.intraLineDiff.maxPatchLines;

    return {
        theme: {
            light: HAPPIER_PIERRE_THEME_IDS.light,
            dark: HAPPIER_PIERRE_THEME_IDS.dark,
        },
        themeType: params.isDark ? 'dark' : 'light',
        diffStyle: params.diffStyle,
        diffIndicators: params.showPrefix === true ? 'classic' : 'none',
        hunkSeparators: 'line-info-basic',
        overflow: params.wrapLines === false ? 'scroll' : 'wrap',
        disableLineNumbers: params.showLineNumbers === false,
        disableFileHeader: true,
        tokenizeMaxLineLength: params.tokenizeMaxLineLength,
        maxLineDiffLength: params.intraLineDiff.maxLineLength,
        lineDiffType: disableIntraLineDiff ? 'none' : 'word-alt',
    };
}
