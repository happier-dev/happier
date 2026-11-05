import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { setDesktopNotch } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { DesktopHostUnavailableError } from '@/utils/platform/desktopHost';

export function createDesktopNotchActionDeps(): Required<Pick<ActionExecutorDeps, 'desktopNotchSet'>> {
    return { desktopNotchSet: async ({ input, context }) => {
        context.signal?.throwIfAborted();
        try {
            await setDesktopNotch(input);
            return { applied: true };
        } catch (error) {
            if (error instanceof DesktopHostUnavailableError) {
                return { ok: false, errorCode: 'unavailable', error: error.reason };
            }
            throw error;
        }
    } };
}
