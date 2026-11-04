import { z } from 'zod/mini';
import { openOrdinaryNewSessionSeed } from '@/components/sessions/new/newSessionSeedNavigation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { NativeCaptureError, settleNativeCapture } from '@/desktop/capture/nativeCapture';
import { prepareCaptureDelivery, readNativeCaptureDelivery, resolveCaptureDelivery } from '@/sync/ops/actions/screenCaptureActions';
import type { DesktopWindowActionResult } from '@/utils/platform/desktopWindowActionBridge';
import { showDesktopMainWindow } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';

const requestSchema = z.strictObject({ captureRef: z.string().check(z.trim(), z.minLength(1)), note: z.optional(z.string()) });
type Outcome = Pick<DesktopWindowActionResult, 'ok' | 'result' | 'details' | 'errorCode' | 'error'>;

/** Called only after the existing bridge admits an actual Capture-window UI press. */
export async function openCaptureNewSession(input: unknown): Promise<Outcome> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) return { ok: false, errorCode: 'operation_unavailable', error: 'operation_unavailable' };
    try {
        const record = await readNativeCaptureDelivery(parsed.data.captureRef);
        if ('ok' in record) return record;
        const delivery = resolveCaptureDelivery(record, { surface: 'ui' }, { captureWindowPress: true });
        if ('ok' in delivery) return delivery;
        const prepared = await prepareCaptureDelivery(delivery, { captureWindowPress: true });
        if ('ok' in prepared) return prepared;
        const result = await openOrdinaryNewSessionSeed({ seed: {}, scope: lifetime.scope, isCurrent: lifetime.isCurrent,
            media: { items: prepared.items,
                ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
                ...(prepared.windowText ? { windowText: prepared.windowText } : {}) } });
        if (result.kind !== 'opened') return { ok: false, result, errorCode: result.reason, error: result.reason };
        try {
            await showDesktopMainWindow();
            await settleNativeCapture(parsed.data.captureRef);
        }
        catch (error) {
            const errorCode = error instanceof NativeCaptureError ? error.code : 'operation_unavailable';
            return { ok: false, errorCode, error: errorCode, details: { captureStaged: true, delivered: result } };
        }
        return { ok: true, result };
    } catch (error) {
        if (error instanceof NativeCaptureError) return { ok: false, errorCode: error.code, error: error.code };
        throw error;
    }
}
