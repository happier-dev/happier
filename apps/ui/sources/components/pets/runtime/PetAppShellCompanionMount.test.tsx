import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionFixture,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { Settings } from '@/sync/domains/settings/settings';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

type PetAppShellCompanionTestState = {
    account: {
        petsEnabled: boolean;
        petsSelectedPetRef: Settings['petsSelectedPetRef'];
        petsDesktopOverlayDefaultEnabled: Settings['petsDesktopOverlayDefaultEnabled'];
        petsDesktopOverlayDefaultVisibilityMode: Settings['petsDesktopOverlayDefaultVisibilityMode'];
    };
    local: {
        petsEnabledOverride: LocalSettings['petsEnabledOverride'];
        petsSelectedPetOverride: LocalSettings['petsSelectedPetOverride'];
        petsCompanionSizeScale: number;
        desktopPetOverlayEnabledOverride: LocalSettings['desktopPetOverlayEnabledOverride'];
        desktopPetOverlayVisibilityModeOverride: LocalSettings['desktopPetOverlayVisibilityModeOverride'];
        desktopPetOverlayAnchor: LocalSettings['desktopPetOverlayAnchor'];
        desktopPetOverlayLocked: LocalSettings['desktopPetOverlayLocked'];
    };
};

const platformState = vi.hoisted(() => ({
    os: 'web',
    tauri: false,
}));
const featureState = vi.hoisted(() => ({
    companion: { state: 'enabled' },
    sync: { state: 'disabled' },
}));
const settingsState = vi.hoisted((): PetAppShellCompanionTestState => ({
    account: {
        petsEnabled: true,
        petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
        petsDesktopOverlayDefaultEnabled: true,
        petsDesktopOverlayDefaultVisibilityMode: 'alwaysWhenEnabled',
    },
    local: {
        petsEnabledOverride: 'inherit',
        petsSelectedPetOverride: { kind: 'inherit' },
        petsCompanionSizeScale: 1,
        desktopPetOverlayEnabledOverride: 'inherit',
        desktopPetOverlayVisibilityModeOverride: 'inherit',
        desktopPetOverlayAnchor: 'bottomRight',
        desktopPetOverlayLocked: false,
    },
}));
const sessionsState = vi.hoisted(() => ({
    current: [] as ReturnType<typeof createSessionFixture>[],
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function spriteTransform(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.root.findAllByType('Image')[0]?.props.style.transform;
}

function closestMascot(selector: string): object | null {
    return selector.includes('data-pet-mascot') ? {} : null;
}

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        I18nManager: {
            ...actual.I18nManager,
            isRTL: false,
        },
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => platformState.tauri,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        if (featureId === 'pets.companion') return featureState.companion;
        if (featureId === 'pets.sync') return featureState.sync;
        return { state: 'disabled' };
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const storage = createStorageStoreMock({
        accountPetsById: {},
        localPetSourcesBySourceKey: {},
    });
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            ...actual,
            useSettings: () => ({
                ...settingsDefaults,
                ...settingsState.account,
            }),
            useLocalSettings: () => ({
                ...localSettingsDefaults,
                ...settingsState.local,
            }),
            useAllSessions: () => sessionsState.current,
            storage,
        },
    });
});

describe('PetAppShellCompanionMount', () => {
    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
        platformState.os = 'web';
        platformState.tauri = false;
        featureState.companion = { state: 'enabled' };
        featureState.sync = { state: 'disabled' };
        settingsState.account = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
            petsDesktopOverlayDefaultEnabled: true,
            petsDesktopOverlayDefaultVisibilityMode: 'alwaysWhenEnabled',
        };
        settingsState.local = {
            petsEnabledOverride: 'inherit',
            petsSelectedPetOverride: { kind: 'inherit' },
            petsCompanionSizeScale: 1,
            desktopPetOverlayEnabledOverride: 'inherit',
            desktopPetOverlayVisibilityModeOverride: 'inherit',
            desktopPetOverlayAnchor: 'bottomRight',
            desktopPetOverlayLocked: false,
        };
        sessionsState.current = [];
        vi.unstubAllGlobals();
    });

    it('renders the selected built-in pet in the ordinary web app shell', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
        const sprite = screen.findByTestId('pet-app-shell-companion-sprite');
        expect(sprite?.props['data-pet-state']).toBe('idle');
    });

    it('renders the shared activity bubbles in the ordinary web app shell', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(12_000);
        sessionsState.current = [
            createSessionFixture({ id: 'web-pet-session', active: true, pendingCount: 1, updatedAt: 11_000 }),
        ];
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-web-pet-session')).not.toBeNull();
    });

    it('does not render the companion when the user has not enabled pets', async () => {
        settingsState.account = {
            ...settingsState.account,
            petsEnabled: false,
        };
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).toBeNull();
    });

    it('updates the rendered built-in pet when the selected pet changes', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe(
            resolveBuiltInPetPackage('milo').spritesheetSource,
        );

        settingsState.account = {
            ...settingsState.account,
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'fury' },
        };

        await act(async () => {
            screen.tree.update(<PetAppShellCompanionMount />);
        });

        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe(
            resolveBuiltInPetPackage('fury').spritesheetSource,
        );
    });

    it('keeps idle pets still between ambient actions', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(spriteTransform(screen)).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);

        await act(async () => {
            vi.advanceTimersByTime(300);
        });

        expect(spriteTransform(screen)).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);
    });

    it('plays a short ambient action after an idle delay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const randomSpy = vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await act(async () => {
            vi.advanceTimersByTime(8_000);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('waving');

        await act(async () => {
            vi.advanceTimersByTime(2_100);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
        randomSpy.mockRestore();
    });

    it('reacts to a tap with a bounded jumping animation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await screen.pressByTestIdAsync('pet-app-shell-companion-hitbox');

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('jumping');
        expect(screen.findByTestId('pet-app-shell-companion-sprite')?.props['data-pet-state']).toBe('jumping');

        await act(async () => {
            vi.advanceTimersByTime(980);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
    });

    it('keeps web drag movement bounded to the app shell viewport', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(type: string, init: { clientX: number; clientY: number; screenX?: number; screenY?: number }) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX ?? init.clientX;
                this.screenY = init.screenY ?? init.clientY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');
        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('pet-app-shell-companion-hitbox'), 'onPointerDown', {
                button: 0,
                clientX: 220,
                clientY: 180,
                screenX: 220,
                screenY: 180,
                target: { closest: closestMascot },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: -200,
                clientY: -200,
                screenX: -200,
                screenY: -200,
            }));
        });

        const rootStyle = flattenStyle(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        expect(rootStyle.transform).toEqual([
            { translateX: -180 },
            { translateY: -112.33333333333333 },
        ]);
        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('running-left');
    });

    it('applies the local companion size scale to web app-shell dimensions and drag bounds', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(type: string, init: { clientX: number; clientY: number; screenX?: number; screenY?: number }) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX ?? init.clientX;
                this.screenY = init.screenY ?? init.clientY;
            }
        }
        settingsState.local = {
            ...settingsState.local,
            petsCompanionSizeScale: 1.5,
        };
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');
        const screen = await renderScreen(<PetAppShellCompanionMount />);

        const rootStyleBeforeDrag = flattenStyle(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        const spriteStyle = flattenStyle(screen.findByTestId('pet-app-shell-companion-sprite')?.props.style);

        expect(rootStyleBeforeDrag.width).toBeCloseTo(138, 4);
        expect(rootStyleBeforeDrag.height).toBeCloseTo(149.5, 4);
        expect(spriteStyle.width).toBeCloseTo(138, 4);
        expect(spriteStyle.height).toBeCloseTo(149.5, 4);

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('pet-app-shell-companion-hitbox'), 'onPointerDown', {
                button: 0,
                clientX: 220,
                clientY: 180,
                screenX: 220,
                screenY: 180,
                target: { closest: closestMascot },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: -200,
                clientY: -200,
                screenX: -200,
                screenY: -200,
            }));
        });

        const rootStyleAfterDrag = flattenStyle(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        expect(rootStyleAfterDrag.transform).toEqual([
            { translateX: -134 },
            { translateY: -62.5 },
        ]);
    });

    it('does not trigger the tap reaction after a web drag movement', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(type: string, init: { clientX: number; clientY: number; screenX?: number; screenY?: number }) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX ?? init.clientX;
                this.screenY = init.screenY ?? init.clientY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');
        const screen = await renderScreen(<PetAppShellCompanionMount />);
        const hitbox = screen.findByTestId('pet-app-shell-companion-hitbox');

        await act(async () => {
            invokeTestInstanceHandler(hitbox, 'onPointerDown', {
                button: 0,
                clientX: 220,
                clientY: 180,
                screenX: 220,
                screenY: 180,
                target: { closest: closestMascot },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 180,
                clientY: 180,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                clientX: 180,
                clientY: 180,
            }));
        });

        await act(async () => {
            invokeTestInstanceHandler(hitbox, 'onPress', {
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).not.toBe('jumping');
    });

    it('does not duplicate the Tauri desktop overlay when that overlay owns the pet', async () => {
        platformState.tauri = true;
        settingsState.account = {
            ...settingsState.account,
            petsDesktopOverlayDefaultEnabled: true,
        };
        settingsState.local = {
            ...settingsState.local,
            desktopPetOverlayEnabledOverride: 'inherit',
        };
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).toBeNull();
    });

    it('renders the app-shell companion in Tauri when the desktop overlay does not own the pet', async () => {
        platformState.tauri = true;
        settingsState.account = {
            ...settingsState.account,
            petsDesktopOverlayDefaultEnabled: false,
        };
        settingsState.local = {
            ...settingsState.local,
            desktopPetOverlayEnabledOverride: 'disabled',
        };
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
    });
});
