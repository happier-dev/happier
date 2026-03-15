import { parseBooleanEnv } from '@happier-dev/protocol';

export function supportsPierreRuntime(): boolean {
    if (typeof window === 'undefined') return false;
    if (typeof document === 'undefined') return false;
    if (typeof Worker === 'undefined') return false;
    try {
        const el: any = document.createElement('div');
        return typeof el.attachShadow === 'function';
    } catch {
        return false;
    }
}

export function isPierreDiffKillSwitchEnabled(): boolean {
    return parseBooleanEnv(process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED, true) === true;
}
