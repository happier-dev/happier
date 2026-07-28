import { isSessionDebugInformationEnabled } from '@/components/sessions/debug/sessionDebugInformation';
import { useLocalSetting } from '@/sync/domains/state/storage';

/**
 * Whether developer diagnostics are visible: a dev build, or the `devModeEnabled` local setting.
 *
 * Subscribes to the settings store, so read it at a transcript- or screen-level owner and pass the
 * value down rather than calling it per rendered row.
 */
export function useSessionDebugInformationEnabled(): boolean {
    return isSessionDebugInformationEnabled(useLocalSetting('devModeEnabled'));
}
