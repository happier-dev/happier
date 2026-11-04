import { router } from 'expo-router';
import { ScreenCaptureDeliveryInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { showDesktopMainWindow } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { admitInternalRouteHref } from '@/utils/path/routeUtils';
import type { DesktopWindowActionResult } from '@/utils/platform/desktopWindowActionBridge';

type Outcome = Pick<DesktopWindowActionResult, 'ok' | 'result' | 'errorCode' | 'error'>;

/** Main-only consumer of the ⋯ menu's Capture settings intent. */
export async function openCaptureSettings(): Promise<Outcome> {
    await showDesktopMainWindow();
    router.push(admitInternalRouteHref('/settings/desktop'));
    return { ok: true, result: { status: 'opened' } };
}

/** Main-only consumer of the Capture window's admitted pill Open intent. */
export async function openCaptureSession(input: unknown): Promise<Outcome> {
    const parsed = ScreenCaptureDeliveryInputSchema.shape.session.safeParse(input);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    const binding = await resolveServerCredentialAccountScope(parsed.data.serverId);
    if (binding.kind !== 'bound') return { ok: false, errorCode: 'operation_unavailable', error: 'operation_unavailable' };
    if (binding.scope.accountId !== parsed.data.accountId) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    }
    const session = { ...parsed.data, serverId: binding.scope.serverId };
    const route = admitInternalRouteHref(createActivitySurfaceSessionRoute(session.sessionId, session.serverId));
    await showDesktopMainWindow();
    router.push(route);
    return { ok: true, result: { status: 'opened', session } };
}
