import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';

// System boundaries: the platform, the optional native module registry and the Tauri bridge.
const nativeModules = vi.hoisted(() => ({ current: null as unknown }));
const tauri = vi.hoisted(() => ({ desktop: false, invoke: vi.fn() }));
const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' | 'web' }));

vi.mock('react-native', async () => createReactNativeNativeMock({ platformOS: 'ios' }, {
    Platform: {
        get OS() {
            return platform.os;
        },
    },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => nativeModules.current }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauri.desktop,
    invokeTauri: (command: string, args?: unknown) => tauri.invoke(command, args),
}));

async function load(os: 'ios' | 'android' | 'web') {
    platform.os = os;
    return import('./appIconChoice');
}

function nativeModule(current: string | null = null) {
    let name = current;
    return {
        supportsAlternateIcons: true,
        getAppIconName: vi.fn(() => name),
        setAlternateAppIcon: vi.fn(async (next: string | null) => {
            name = next;
            return next;
        }),
    };
}

const SUPPORTER = { supporterActive: true, supporterIconsOffered: true };
const FREE = { supporterActive: false, supporterIconsOffered: true };

afterEach(() => {
    nativeModules.current = null;
    tauri.desktop = false;
    tauri.invoke.mockReset();
});

describe('app icon choice', () => {
    it('refuses a pick on a binary without the native module instead of throwing', async () => {
        const { listAppIcons, setAppIcon } = await load('ios');
        expect(await setAppIcon('night', SUPPORTER)).toEqual({ ok: false, errorCode: 'host_unsupported' });
        expect(await listAppIcons(SUPPORTER)).toMatchObject({ supported: false, currentIconId: null });
    });

    it('has no icon host on the web outside the desktop shell', async () => {
        const { setAppIcon } = await load('web');
        expect(await setAppIcon('default', SUPPORTER)).toEqual({ ok: false, errorCode: 'host_unsupported' });
    });

    it('keeps the six supporter icons for supporters and refuses them otherwise, without touching the OS', async () => {
        const module = nativeModule();
        nativeModules.current = module;
        const { listAppIcons, setAppIcon } = await load('ios');

        expect(await setAppIcon('aurora', FREE)).toEqual({ ok: false, errorCode: 'supporter_required' });
        expect(module.setAlternateAppIcon).not.toHaveBeenCalled();

        expect(await setAppIcon('night', FREE)).toEqual({ iconId: 'night' });
        expect(await setAppIcon('aurora', SUPPORTER)).toEqual({ iconId: 'aurora' });
        expect(await setAppIcon('default', FREE)).toEqual({ iconId: 'default' });
        expect(module.setAlternateAppIcon.mock.calls).toEqual([['Night'], ['Aurora'], [null]]);

        const listed = await listAppIcons(FREE);
        expect(listed.supported).toBe(true);
        expect(listed.currentIconId).toBe('default');
        expect(listed.icons).toHaveLength(8);
        expect(listed.icons.filter((icon) => icon.locked).map((icon) => icon.id))
            .toEqual(['paper', 'gold', 'aurora', 'sunrise', 'blueprint', 'pixel']);
        expect((await listAppIcons(SUPPORTER)).icons.some((icon) => icon.locked)).toBe(false);
    });

    it('shows only the two free icons where the server offers no Supporter pack', async () => {
        nativeModules.current = nativeModule('Gold');
        const { listAppIcons, setAppIcon } = await load('android');
        const listed = await listAppIcons({ supporterActive: false, supporterIconsOffered: false });
        expect(listed.icons.map((icon) => icon.id)).toEqual(['default', 'night']);
        // The icon already on the device stays as it is (accepted imperfection 2).
        expect(listed.currentIconId).toBe('gold');
        expect(await setAppIcon('gold', { supporterActive: false, supporterIconsOffered: false }))
            .toEqual({ ok: false, errorCode: 'supporter_required' });
    });

    it('refuses an icon the catalog does not have', async () => {
        nativeModules.current = nativeModule();
        const { setAppIcon } = await load('ios');
        expect(await setAppIcon('neon', SUPPORTER)).toEqual({ ok: false, errorCode: 'invalid_parameters' });
    });

    it('sets the desktop icon through the shell, which keeps the choice on this device', async () => {
        tauri.desktop = true;
        tauri.invoke.mockImplementation(async (command: string) => command === 'desktop_get_app_icon' ? 'paper' : undefined);
        const { listAppIcons, setAppIcon } = await load('web');
        expect((await listAppIcons(SUPPORTER)).currentIconId).toBe('paper');
        expect(await setAppIcon('pixel', SUPPORTER)).toEqual({ iconId: 'pixel' });
        expect(tauri.invoke).toHaveBeenCalledWith('desktop_set_app_icon', { iconId: 'pixel' });
    });
});
