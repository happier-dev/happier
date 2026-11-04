import type { NativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import { t } from '@/text';

import { captureDisclosureIsAmber, type CaptureDisclosureState } from '../disclosure/captureDisclosureRule';
import type { CaptureWindowTextRead } from './useCaptureWindowText';

export type CaptureWindowTextPreview = Readonly<{
    text: string;
    appName: string;
    windowTitle: string | null;
    wordCount: string;
}>;
export type CaptureWindowTextView = Readonly<{
    /** What the chip draws: its glyph and whether it stands filled. */
    chip: 'off' | 'locked' | 'reading' | 'on' | 'amber' | 'empty' | 'unavailable';
    label: string;
    /** Sanitized text the person can read before it goes; null means View has nothing to show. */
    preview: CaptureWindowTextPreview | null;
    /** One ask at a time, rising from the chip. */
    ask: 'none' | 'blurred' | 'includeBlurred' | 'permission';
}>;

const readText = (result: NativeCaptureWindowText): string | null =>
    result.status === 'ready' || result.status === 'partial' ? result.text : null;
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Projects the disclosure rule and P1's read into the chip; it decides nothing about either. */
export function resolveCaptureWindowTextView(input: Readonly<{
    disclosure: CaptureDisclosureState;
    read: CaptureWindowTextRead;
    /** The captured app, for the label when the read has not named one. */
    appName: string | null;
}>): CaptureWindowTextView {
    const { disclosure, read } = input;
    const whole = t('screenCapture.window.wholeWindowText');
    const ask = disclosure.warning === 'pending' ? 'includeBlurred' as const
        : disclosure.showBlurCallout ? 'blurred' as const : 'none' as const;
    const off = (chip: 'off' | 'locked', askNow: CaptureWindowTextView['ask'] = ask): CaptureWindowTextView =>
        ({ chip, label: whole, preview: null, ask: askNow });
    if (!disclosure.included) return off(disclosure.blurCount > 0 && ask !== 'includeBlurred' ? 'locked' : 'off');
    if (read.status === 'failed') return { chip: 'unavailable', label: t('screenCapture.windowText.unavailable'), preview: null, ask: 'none' };
    if (read.status !== 'settled') return { chip: 'reading', label: t('screenCapture.windowText.reading'), preview: null, ask: 'none' };
    const { result } = read;
    if (result.status === 'unavailable' && result.reason === 'permission_required') return off('off', 'permission');
    if (result.status === 'unavailable') return { chip: 'unavailable', label: t('screenCapture.windowText.unavailable'), preview: null, ask: 'none' };
    if (result.status === 'empty') return { chip: 'empty', label: t('screenCapture.windowText.empty'), preview: null, ask: 'none' };
    const text = readText(result) ?? '';
    const appName = result.source?.appName ?? input.appName ?? t('screenCapture.window.title');
    const wordCount = countWords(text).toLocaleString();
    return {
        chip: captureDisclosureIsAmber(disclosure) ? 'amber' : 'on',
        // Wayland reads the frontmost window before the system picker, so the label says that window, not the captured one.
        label: t(result.status === 'partial' ? 'screenCapture.windowText.partialLabel'
            : result.scope === 'whole_frontmost_window' ? 'screenCapture.windowText.frontmostLabel' : 'screenCapture.windowText.label', { app: appName, count: wordCount }),
        preview: { text, appName, windowTitle: result.source?.windowTitle ?? null, wordCount },
        ask: 'none',
    };
}
