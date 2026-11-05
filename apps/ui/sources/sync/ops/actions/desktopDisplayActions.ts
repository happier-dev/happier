import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { listDesktopDisplays } from '@/activity/adapters/desktop/runtime/desktopDisplays';
import { DesktopHostUnavailableError } from '@/utils/platform/desktopHost';

export function createDesktopDisplayActionDeps(): Required<Pick<ActionExecutorDeps, 'desktopDisplaysList'>> {
    return { desktopDisplaysList: async ({ context }) => {
        context.signal?.throwIfAborted();
        try {
            return await listDesktopDisplays();
        } catch (error) {
            if (error instanceof DesktopHostUnavailableError) {
                return { ok: false, errorCode: 'unavailable', error: error.reason };
            }
            throw error;
        }
    } };
}
