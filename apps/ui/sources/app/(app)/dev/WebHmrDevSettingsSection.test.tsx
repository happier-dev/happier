import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY } from '@/dev/webHmrOptOut/webHmrOptOut';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/lists/ItemGroup', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['ItemGroup']);
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props, props.rightElement as React.ReactNode),
}));

vi.mock('@/components/ui/forms/Switch', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['Switch']);
});

type WindowStub = {
    sessionStorage: {
        getItem: (key: string) => string | null;
        setItem: (key: string, value: string) => void;
        removeItem: (key: string) => void;
    };
    location: {
        reload: () => void;
    };
};

type WebHmrSectionModule = Readonly<{
    WebHmrDevSettingsSection: React.ComponentType;
}>;

function isWebHmrSectionModule(value: unknown): value is WebHmrSectionModule {
    return (
        typeof value === 'object'
        && value !== null
        && typeof (value as { WebHmrDevSettingsSection?: unknown }).WebHmrDevSettingsSection === 'function'
    );
}

async function loadWebHmrSectionModule(): Promise<WebHmrSectionModule | null> {
    const modulePath = './WebHmrDevSettingsSection';
    const loaded: unknown = await import(modulePath).catch(() => null);
    return isWebHmrSectionModule(loaded) ? loaded : null;
}

describe('WebHmrDevSettingsSection', () => {
    let originalWindowDescriptor: PropertyDescriptor | undefined;
    let store: Map<string, string>;
    let reloadSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.stubGlobal('__DEV__', true);
        store = new Map<string, string>();
        reloadSpy = vi.fn();
        originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

        const windowStub: WindowStub = {
            sessionStorage: {
                getItem: (key) => store.get(key) ?? null,
                setItem: (key, value) => void store.set(key, value),
                removeItem: (key) => void store.delete(key),
            },
            location: {
                reload: reloadSpy,
            },
        };

        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: windowStub,
        });
        globalThis.__HAPPIER_WEB_HMR_OPT_OUT__ = undefined;
    });

    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
        globalThis.__HAPPIER_WEB_HMR_OPT_OUT__ = undefined;
        if (originalWindowDescriptor) {
            Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
        } else {
            delete (globalThis as { window?: unknown }).window;
        }
    });

    it('toggles the per-tab opt-out state used by the URL parameter path before reloading', async () => {
        const mod = await loadWebHmrSectionModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const screen = await renderScreen(<mod.WebHmrDevSettingsSection />);

        const toggle = screen.findByTestId('dev-web-hmr-toggle');
        expect(toggle?.props.value).toBe(true);

        act(() => {
            toggle?.props.onValueChange(false);
        });

        expect(store.get(WEB_HMR_OPT_OUT_SESSION_STORAGE_KEY)).toBe('disabled');
        expect(globalThis.__HAPPIER_WEB_HMR_OPT_OUT__).toBe(true);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
});
