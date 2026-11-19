import { t } from '@/text';

export function readDesktopActivityOverlayActionFailureReason(errorCode: string | undefined, fallback: string): string {
    switch (errorCode) {
        case 'ack_timeout': return t('errors.connectionTimeout');
        case 'desktop_window_action_source_refused':
        case 'unsafe_server_scope': return t('errors.permissionDenied');
        default: return fallback;
    }
}
