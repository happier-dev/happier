import type { LocalServiceListenerFact } from '../scanner';

export type WindowsLocalServiceScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    diagnostics: readonly Readonly<{ code: string; severity: 'info' | 'warning' | 'error' }>[];
}>;

export function readWindowsLocalServiceListenersUnavailable(): WindowsLocalServiceScanResult {
    return {
        listeners: [],
        diagnostics: [{ code: 'windows_scanner_not_implemented', severity: 'warning' }],
    };
}
