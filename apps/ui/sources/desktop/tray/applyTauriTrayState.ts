import { invokeTauri } from '@/utils/platform/tauri';

import type { DesktopTrayState } from './buildDesktopTrayState';

export async function applyTauriTrayState(state: DesktopTrayState): Promise<void> {
    await invokeTauri<void>('desktop_set_tray_state', { state });
}
