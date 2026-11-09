import * as React from 'react';

import { desktopHostKind } from '@/utils/platform/desktopHost';
import {
    NativeCaptureError,
    readNativeCapturePreference,
    readNativeCaptureShortcuts,
    subscribeNativeCapturePermissions,
    subscribeNativeCapturePreference,
    subscribeNativeCaptureShortcuts,
    readNativeWindowShadowPreference,
    subscribeNativeWindowShadowPreference,
    type NativeCaptureErrorCode,
    type NativeCapturePermissions,
    type NativeCaptureShortcutSnapshot,
    type NativeWindowShadowPreference,
} from '@/desktop/capture/nativeCapture';

export type CaptureSettingsRead<T> = Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'ready'; value: T }>
    | Readonly<{ status: 'failed'; reason: NativeCaptureErrorCode }>;

function failedRead(error: unknown): CaptureSettingsRead<never> {
    return { status: 'failed', reason: error instanceof NativeCaptureError ? error.code : 'native_failure' };
}

/** Mounted only by the desktop Capture section. Native pushes settle and update each read. */
export function useScreenCaptureSettings() {
    const supported = desktopHostKind() === 'tauri';
    const [shortcuts, setShortcuts] = React.useState<CaptureSettingsRead<NativeCaptureShortcutSnapshot>>({ status: 'loading' });
    const [permissions, setPermissions] = React.useState<CaptureSettingsRead<NativeCapturePermissions>>({ status: 'loading' });
    const [folder, setFolder] = React.useState<CaptureSettingsRead<string | null>>({ status: 'loading' });
    const [windowShadow, setWindowShadow] = React.useState<CaptureSettingsRead<NativeWindowShadowPreference>>({ status: 'loading' });

    React.useEffect(() => {
        if (!supported) return;
        let active = true;
        const stops: (() => void)[] = [];
        const retain = (stop: () => void) => { if (active) stops.push(stop); else stop(); };

        void subscribeNativeWindowShadowPreference(value => { if (active) setWindowShadow({ status: 'ready', value }); })
            .then(async stop => {
                retain(stop);
                if (!active) return;
                const value = await readNativeWindowShadowPreference();
                if (active) setWindowShadow({ status: 'ready', value });
            }).catch(error => { if (active) setWindowShadow(failedRead(error)); });

        void subscribeNativeCaptureShortcuts(value => { if (active) setShortcuts({ status: 'ready', value }); })
            .then(async stop => {
                retain(stop);
                if (!active) return;
                const value = await readNativeCaptureShortcuts();
                if (active) setShortcuts({ status: 'ready', value });
            }).catch(error => { if (active) setShortcuts(failedRead(error)); });
        // This subscription's admission returns the initial permission state: no second read.
        void subscribeNativeCapturePermissions(value => { if (active) setPermissions({ status: 'ready', value }); })
            .then(retain).catch(error => { if (active) setPermissions(failedRead(error)); });
        void subscribeNativeCapturePreference('libraryFolder', value => { if (active) setFolder({ status: 'ready', value }); })
            .then(async stop => {
                retain(stop);
                if (!active) return;
                const value = await readNativeCapturePreference('libraryFolder');
                if (active) setFolder({ status: 'ready', value });
            }).catch(error => { if (active) setFolder(failedRead(error)); });
        return () => { active = false; stops.forEach(stop => stop()); };
    }, [supported]);

    return { supported, shortcuts, permissions, folder, windowShadow };
}
