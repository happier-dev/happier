import { t } from '@/text';
import type { DesktopWindowActionResult } from '@/utils/platform/desktopWindowActionBridge';
import type { CapturePillState } from './CaptureDeliveryPill';
import type { CaptureDelivery, CaptureDeliveryOutcome } from './CaptureWindowScreen';

/** The two editors project the main owner's settled delivery through the same receipt. */
export function resolveCaptureDeliveryOutcome(input: Readonly<{
    delivery: CaptureDelivery;
    newSession?: boolean;
    session: string;
    detail: string;
    result: DesktopWindowActionResult | null;
}>): CaptureDeliveryOutcome {
    const { delivery, session, detail, result } = input;
    const details = result?.details;
    const delivered = details && typeof details === 'object' && 'delivered' in details ? details.delivered : null;
    const applied = delivered !== null && typeof delivered === 'object';
    if (!result?.ok && !applied) return { ok: false, phase: 'delivery',
        cause: result?.error ?? result?.errorCode ?? t('common.error') };
    const receipt = result?.ok ? result.result : delivered;
    const imageNumber = receipt && typeof receipt === 'object' && 'imageNumber' in receipt && typeof receipt.imageNumber === 'number'
        ? receipt.imageNumber : 1;
    const pill: CapturePillState = input.newSession ? { kind: 'started' }
        : delivery === 'send' ? { kind: 'sent', session, detail }
        : { kind: 'added', session, imageNumber, waiting: imageNumber };
    return { ok: true, pill: result?.ok ? pill : { ...pill, cleanupWarning: result?.error ?? result?.errorCode ?? t('common.error') } };
}
