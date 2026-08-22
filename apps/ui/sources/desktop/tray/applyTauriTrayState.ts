import { invokeDesktopHost } from '@/utils/platform/desktopHost';

import type { DesktopTrayState } from './buildDesktopTrayState';

export async function applyTauriTrayState(state: DesktopTrayState): Promise<void> {
    await invokeDesktopHost<void>('desktop_set_tray_state', { state });
}
