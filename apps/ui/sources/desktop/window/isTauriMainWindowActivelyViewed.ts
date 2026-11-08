import { isHostActivelyViewed } from '@/utils/runtime/isRuntimeActive';
import { isTauriDesktop } from '@/utils/platform/tauri';

export function isTauriMainWindowActivelyViewed(): boolean {
    return isTauriDesktop() && isHostActivelyViewed();
}
