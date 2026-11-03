import { describe, expect, it } from 'vitest';

import { resolvePersonalHomeBootstrapHost } from '@/utils/platform/personalHomeBootstrapHost';

describe('resolvePersonalHomeBootstrapHost', () => {
    it('enables automatic Personal Home hosting only for the Tauri main window', () => {
        expect(resolvePersonalHomeBootstrapHost({ desktopHostKind: 'tauri', currentWindowLabel: 'main' })).toBe(true);
    });

    it.each([
        { name: 'Tauri overlay window', desktopHostKind: 'tauri' as const, currentWindowLabel: 'activity_overlay' },
        { name: 'Tauri callback window', desktopHostKind: 'tauri' as const, currentWindowLabel: 'oauth-callback' },
        { name: 'unknown Tauri window', desktopHostKind: 'tauri' as const, currentWindowLabel: 'future-secondary-window' },
        { name: 'missing Tauri window label', desktopHostKind: 'tauri' as const, currentWindowLabel: null },
        { name: 'Electron window', desktopHostKind: 'electron' as const, currentWindowLabel: 'main' },
        { name: 'web or mobile host', desktopHostKind: null, currentWindowLabel: null },
    ])('rejects $name before the Personal Home runtime is constructed', (input) => {
        expect(resolvePersonalHomeBootstrapHost(input)).toBe(false);
    });
});
