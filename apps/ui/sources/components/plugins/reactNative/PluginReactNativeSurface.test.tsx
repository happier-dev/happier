import * as React from 'react';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPluginReactNativeWatchdog } from './watchdog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const surfaceContext: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    surfaceId: 'surface_1',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'ios',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const cacheIdentity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    projectionGeneration: 12,
} as const;

describe('PluginReactNativeSurface', () => {
    it('uses fallback instead of loading when compatibility does not allow RN execution', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn();

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'fallback', reason: 'channel_policy_denied', diagnostics: [], fallback: { kind: 'hostedWeb', contributionId: 'web' } }}
            load={load}
        />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(load).not.toHaveBeenCalled();
    });

    it('shows typed fallback diagnostics when runtime loading is unavailable', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['repack_script_manager_unavailable', 'feature_disabled'],
                fallback: { kind: 'hostedWeb', contributionId: 'web' },
            }}
        />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('repack_script_manager_unavailable')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('repack_script_manager_unavailable');
    });

    it('renders a compatible loaded module through the boundary', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{
                renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
            }}
        />);

        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
    });

    it('keeps a loaded visual snapshot mounted but host-blocks pointer, keyboard, and accessibility interaction offline', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const localAction = vi.fn();
        const module = {
            renderSurface: vi.fn(() => React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-interactive-snapshot',
                onClick: localAction,
                onKeyDown: localAction,
                onAccessibilityAction: localAction,
            })),
        };
        const element = (interactionEnabled: boolean) => (
            <PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                interactionEnabled={interactionEnabled}
            />
        );
        const screen = await renderScreen(element(true));

        expect(screen.findByTestId('plugin-native-interactive-snapshot')).toBeTruthy();
        expect(module.renderSurface).toHaveBeenCalledTimes(1);
        await screen.update(element(false));

        const offlineBoundary = screen.findByTestId('plugin-surface-snapshot:surface_1');
        expect(screen.findByTestId('plugin-native-interactive-snapshot')).toBeTruthy();
        expect(module.renderSurface).toHaveBeenCalledTimes(1);
        expect(offlineBoundary?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(offlineBoundary?.props.style).toMatchObject({ pointerEvents: 'none' });
        expect(
            screen.findByTestId('plugin-surface-offline-summary:surface_1')?.props.role,
        ).toBe('status');

        const pointerEvent = {
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        const keyboardEvent = {
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        offlineBoundary?.props.onClickCapture(pointerEvent);
        offlineBoundary?.props.onKeyDownCapture(keyboardEvent);
        expect(pointerEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(pointerEvent.stopPropagation).toHaveBeenCalledTimes(1);
        expect(keyboardEvent.preventDefault).toHaveBeenCalledTimes(1);
        expect(keyboardEvent.stopPropagation).toHaveBeenCalledTimes(1);
        expect(localAction).not.toHaveBeenCalled();

        await screen.update(element(true));
        const reconnectedBoundary = screen.findByTestId('plugin-surface-snapshot:surface_1');
        expect(reconnectedBoundary?.props.inert).toBe(false);
        expect(reconnectedBoundary?.props['aria-hidden']).toBe(false);
        expect(reconnectedBoundary?.props.style).toMatchObject({ pointerEvents: 'auto' });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface_1')).toBeNull();
        expect(screen.findByTestId('plugin-native-interactive-snapshot')).toBeTruthy();
        expect(module.renderSurface).toHaveBeenCalledTimes(1);
    });

    it('passes surface and host API context to compatible modules', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createPluginReactNativeHostApiAdapter } = await import('./hostApi');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const hostApiAdapter = createPluginReactNativeHostApiAdapter({
            surface: surfaceContext,
            requestIdPrefix: 'rn:test',
            handleRequest: vi.fn(async () => ({ accepted: true })),
        });

        await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            surface={surfaceContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            hostApi={hostApiAdapter.api}
            module={{ renderSurface }}
        />);

        expect(renderSurface).toHaveBeenCalledWith({
            surface: surfaceContext,
            hostApi: expect.objectContaining({
                dispatchAction: expect.any(Function),
                requestSessionResource: expect.any(Function),
            }),
        });
    });

    it('passes the canonical SDK render context through unchanged for generated modules', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createCanonicalPluginReactNativeHostApiAdapter } = await import('./hostApi');
        const canonicalSurface = Object.freeze({
            placement: 'session.preview' as const,
            platform: 'web' as const,
            locale: 'en',
            direction: 'ltr' as const,
            colorScheme: 'light' as const,
            contrast: 'normal' as const,
            textScale: 1,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
            session: Object.freeze({ id: 'session-1' }),
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            legacySurface: surfaceContext,
            requestIdPrefix: 'rn-v2:test',
            handleRequest: vi.fn(async () => ({ accepted: true })),
        });
        const controller = new AbortController();
        const renderContext = Object.freeze({
            plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
            view: Object.freeze({ id: 'native-preview', placement: 'session.preview' as const }),
            surface: canonicalSurface,
            hostApi: adapter.api,
            signal: controller.signal,
        });
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));

        await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            renderContext={renderContext}
            module={{ renderSurface }}
        />);

        expect(renderSurface).toHaveBeenCalledWith(renderContext);
        adapter.dispose();
    });

    it('does not adapt raw Host API request handlers at the surface boundary', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const rawHostApi = { handleRequest: vi.fn(async () => ({ accepted: true })) };

        await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            surface={surfaceContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            hostApi={rawHostApi as never}
            module={{ renderSurface }}
        />);

        expect(renderSurface).toHaveBeenCalledWith({
            surface: surfaceContext,
        });
        expect(rawHostApi.handleRequest).not.toHaveBeenCalled();
    });

    it('does not pass unfrozen Host API lookalikes into plugin render context', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const unfrozenHostApi = {
            version: '1.0.0',
            surface: surfaceContext,
            getSurfaceContext: () => surfaceContext,
            request: vi.fn(async () => undefined),
            requestSessionResource: vi.fn(async () => undefined),
            subscribeResource: vi.fn(async () => ({
                subscriptionId: 'sub-1',
                unsubscribe: async () => undefined,
            })),
            dispatchAction: vi.fn(async () => undefined),
            openSurface: vi.fn(async () => undefined),
            logDiagnostic: vi.fn(async () => undefined),
            copy: vi.fn(async () => undefined),
            openExternal: vi.fn(async () => undefined),
        };

        await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            surface={surfaceContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            hostApi={unfrozenHostApi as never}
            module={{ renderSurface }}
        />);

        expect(renderSurface).toHaveBeenCalledWith({
            surface: surfaceContext,
        });
    });

    it('does not let retired UI-local trust flags authorize an external dynamic loader', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn(() => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={load}
            loadPolicy={{
                source: 'externalDynamicBundle',
                dynamicLoadingEnabled: true,
                signatureVerified: true,
                channelAllowed: true,
            } as unknown as React.ComponentProps<typeof PluginReactNativeSurface>['loadPolicy']}
        />);

        expect(load).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('does not let a retired inline-module policy authorize an injected loader', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn(() => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={load}
            loadPolicy={{
                source: 'inlineModule',
            } as unknown as React.ComponentProps<typeof PluginReactNativeSurface>['loadPolicy']}
        />);

        expect(load).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('falls back when the loader returns an invalid surface module', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            // Boundary fixture: the external loader can return an unknown module shape.
            module={{ renderSurface: null } as unknown as never}
        />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-surface')).toBeNull();
    });

    it('keeps invalid loader modules out of the persisted render-crash budget', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={vi.fn(async () => ({ renderSurface: null } as unknown as never))}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_1"
            watchdog={watchdog}
        />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('invalid_surface_module')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('invalid_surface_module');
        expect(watchdog.readState('surface_1')).toMatchObject({
            cacheKey: 'cache_1',
            crashCount: 0,
            startupFailureCount: 0,
            disabled: false,
        });
    });

    it('keeps loader backend failures out of the persisted render-crash budget while surfacing diagnostics', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        const onCrashDisable = vi.fn();
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={vi.fn(async () => {
                throw Object.freeze({
                    code: 'loader_backend_unavailable',
                    diagnostics: ['loader_backend_unavailable', 'bundle_open_failed'],
                });
            })}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_1"
            watchdog={watchdog}
            onCrashDisable={onCrashDisable}
        />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('loader_backend_unavailable')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('loader_backend_unavailable');
        expect(watchdog.readState('surface_1')).toMatchObject({
            cacheKey: 'cache_1',
            crashCount: 0,
            startupFailureCount: 0,
            disabled: false,
        });
        expect(onCrashDisable).not.toHaveBeenCalled();
    });

    it('disables the surface when startup is not acknowledged before the watchdog threshold', async () => {
        vi.useFakeTimers();
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 100,
            crashThreshold: 1,
            nowMs: () => now,
        });
        const load = vi.fn(() => new Promise<never>(() => undefined));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_1"
                loadTimeoutMs={100}
                watchdog={watchdog}
            />);

            await flushHookEffects({ cycles: 1, turns: 2 });
            expect(load).toHaveBeenCalledTimes(1);

            now = 1_101;
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(watchdog.readState('surface_1')).toMatchObject({
                startupFailureCount: 1,
                disabled: true,
            });
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-surface')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports startup acknowledgment threshold disablement with cache identity', async () => {
        vi.useFakeTimers();
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 100,
            crashThreshold: 1,
            nowMs: () => now,
        });
        const load = vi.fn(() => new Promise<never>(() => undefined));
        const onCrashDisable = vi.fn();
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_1"
                cacheIdentity={cacheIdentity}
                loadTimeoutMs={100}
                watchdog={watchdog}
                onCrashDisable={onCrashDisable}
            />);

            await flushHookEffects({ cycles: 1, turns: 2 });
            now = 1_101;
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(onCrashDisable).toHaveBeenCalledWith({
                surfaceId: 'surface_1',
                cacheKey: 'cache_1',
                cacheIdentity,
                disabledReason: 'startup_ack_timeout_threshold',
                crashCount: 0,
                startupFailureCount: 1,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('acknowledges successful module render through the watchdog', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        const acknowledgeHostRuntime = vi.fn();
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{
                renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
                acknowledgeHostRuntime,
            }}
            cacheKey="cache_1"
            watchdog={watchdog}
        />);
        await flushHookEffects();

        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
        expect(acknowledgeHostRuntime).toHaveBeenCalledWith({
            surfaceId: 'surface_1',
            cacheKey: 'cache_1',
        });
        expect(watchdog.readState('surface_1')).toMatchObject({
            startupFailureCount: 0,
            disabled: false,
        });
    });

    it('disables the surface when async runtime acknowledgment never completes', async () => {
        vi.useFakeTimers();
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 100,
            crashThreshold: 1,
            nowMs: () => now,
        });
        const acknowledgeHostRuntime = vi.fn(() => new Promise<never>(() => undefined));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
                    acknowledgeHostRuntime,
                }}
                cacheKey="cache_1"
                loadTimeoutMs={100}
                watchdog={watchdog}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
            expect(acknowledgeHostRuntime).toHaveBeenCalledWith({
                surfaceId: 'surface_1',
                cacheKey: 'cache_1',
            });

            now = 1_101;
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(watchdog.readState('surface_1')).toMatchObject({
                startupFailureCount: 1,
                disabled: true,
            });
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-surface')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('treats a missing startup acknowledgment hook as a no-ack timeout', async () => {
        vi.useFakeTimers();
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 100,
            crashThreshold: 1,
            nowMs: () => now,
        });
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
                }}
                cacheKey="cache_1"
                loadTimeoutMs={100}
                watchdog={watchdog}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();

            now = 1_101;
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(watchdog.readState('surface_1')).toMatchObject({
                startupFailureCount: 1,
                disabled: true,
            });
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-surface')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not let a stale acknowledgment timeout fail the current cache generation', async () => {
        vi.useFakeTimers();
        let now = 1_000;
        let resolveFirstAck!: () => void;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 100,
            crashThreshold: 1,
            nowMs: () => now,
        });
        const firstModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-first' }),
            acknowledgeHostRuntime: vi.fn(() => new Promise<void>((resolve) => {
                resolveFirstAck = resolve;
            })),
        };
        const secondModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-second' }),
            acknowledgeHostRuntime: vi.fn(),
        };
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={firstModule}
                cacheKey="cache_1"
                loadTimeoutMs={100}
                watchdog={watchdog}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.findByTestId('plugin-native-first')).toBeTruthy();

            await act(async () => {
                screen.tree.update(<PluginReactNativeSurface
                    surfaceId="surface_1"
                    decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                    module={secondModule}
                    cacheKey="cache_2"
                    loadTimeoutMs={100}
                    watchdog={watchdog}
                />);
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.findByTestId('plugin-native-second')).toBeTruthy();
            expect(secondModule.acknowledgeHostRuntime).toHaveBeenCalledWith({
                surfaceId: 'surface_1',
                cacheKey: 'cache_2',
            });

            now = 1_101;
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(screen.findByTestId('plugin-native-second')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(watchdog.readState('surface_1')).toMatchObject({
                cacheKey: 'cache_2',
                crashCount: 0,
                startupFailureCount: 0,
                disabled: false,
            });

            resolveFirstAck();
            await flushHookEffects({ cycles: 1, turns: 2 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('acknowledges each dev module instance and fences the replaced instance timeout', async () => {
        vi.useFakeTimers();
        let now = 1_000;
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 100,
            crashThreshold: 1,
            nowMs: () => now,
        });
        const firstModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-dev-first' }),
            acknowledgeHostRuntime: vi.fn(() => new Promise<never>(() => undefined)),
        };
        const secondModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-dev-second' }),
            acknowledgeHostRuntime: vi.fn(),
        };
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={firstModule}
                loadTimeoutMs={100}
                watchdog={watchdog}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(firstModule.acknowledgeHostRuntime).toHaveBeenCalledTimes(1);

            await act(async () => {
                screen.tree.update(<PluginReactNativeSurface
                    surfaceId="surface_1"
                    decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                    module={secondModule}
                    loadTimeoutMs={100}
                    watchdog={watchdog}
                />);
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(secondModule.acknowledgeHostRuntime).toHaveBeenCalledTimes(1);
            expect(secondModule.acknowledgeHostRuntime).toHaveBeenCalledWith({
                surfaceId: 'surface_1',
            });
            expect(screen.findByTestId('plugin-native-dev-second')).toBeTruthy();

            now = 1_101;
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(screen.findByTestId('plugin-native-dev-second')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(watchdog.readState('surface_1')).toMatchObject({
                cacheKey: 'surface_1',
                startupFailureCount: 0,
                disabled: false,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not let a late runtime acknowledgment clear a crash-disabled surface', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        let resolveAcknowledgment!: () => void;
        const acknowledgeHostRuntime = vi.fn(() => new Promise<void>((resolve) => {
            resolveAcknowledgment = resolve;
        }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{
                renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
                acknowledgeHostRuntime,
            }}
            cacheKey="cache_1"
            watchdog={watchdog}
        />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        watchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        expect(watchdog.readState('surface_1')).toMatchObject({ disabled: true });

        resolveAcknowledgment();
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(watchdog.readState('surface_1')).toMatchObject({ disabled: true });
    });

    it('records direct render errors through the watchdog and contains them in the surface boundary', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => {
                        throw new Error('plugin render failure');
                    },
                }}
                cacheKey="cache_1"
                watchdog={watchdog}
            />);

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(watchdog.readState('surface_1')).toMatchObject({
                crashCount: 1,
                disabled: true,
            });
        } finally {
            consoleError.mockRestore();
        }
    });

    it('recovers a mounted surface after a failed artifact is replaced', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 2,
            nowMs: () => 1_000,
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => {
                        throw new Error('plugin render failure');
                    },
                }}
                cacheKey="cache_1"
                watchdog={watchdog}
            />);

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-recovered' }),
                }}
                cacheKey="cache_2"
                watchdog={watchdog}
            />);

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-native-recovered')).toBeTruthy();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('reports render-error threshold disablement with cache identity', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        const onCrashDisable = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => {
                        throw new Error('plugin render failure');
                    },
                }}
                cacheKey="cache_1"
                cacheIdentity={cacheIdentity}
                watchdog={watchdog}
                onCrashDisable={onCrashDisable}
            />);

            expect(onCrashDisable).toHaveBeenCalledWith({
                surfaceId: 'surface_1',
                cacheKey: 'cache_1',
                cacheIdentity,
                disabledReason: 'render_error_threshold',
                crashCount: 1,
                startupFailureCount: 0,
            });
        } finally {
            consoleError.mockRestore();
        }
    });

    it('does not invoke plugin render when the watchdog already disabled the surface', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        watchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{ renderSurface }}
            cacheKey="cache_1"
            watchdog={watchdog}
        />);

        expect(renderSurface).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('does not let an old disabled cache key block a new fixed artifact load', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            ackTimeoutMs: 500,
            crashThreshold: 1,
            nowMs: () => 1_000,
        });
        watchdog.recordRenderError({ surfaceId: 'surface_1', cacheKey: 'cache_1' });
        expect(watchdog.readState('surface_1')).toMatchObject({
            cacheKey: 'cache_1',
            disabled: true,
        });

        const load = vi.fn(() => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={load}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_2"
            watchdog={watchdog}
        />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(load).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
        expect(watchdog.readState('surface_1')).toMatchObject({
            cacheKey: 'cache_2',
            crashCount: 0,
            startupFailureCount: 0,
            disabled: false,
        });
    });

    it('does not render a previously loaded module after the cache key changes', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const firstRender = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-first' }));
        const secondRender = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-second' }));
        let resolveSecondLoad!: (module: { renderSurface: typeof secondRender }) => void;
        const firstLoad = vi.fn(() => ({ renderSurface: firstRender }));
        const secondLoad = vi.fn(() => new Promise<{ renderSurface: typeof secondRender }>((resolve) => {
            resolveSecondLoad = resolve;
        }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={firstLoad}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_1"
            loadTimeoutMs={1000}
        />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-native-first')).toBeTruthy();
        const firstRenderCountBeforeCacheKeyChange = firstRender.mock.calls.length;

        await act(async () => {
            screen.tree.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={secondLoad}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_2"
                loadTimeoutMs={1000}
            />);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(secondLoad).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-first')).toBeNull();
        expect(screen.findByTestId('plugin-native-second')).toBeNull();

        resolveSecondLoad({ renderSurface: secondRender });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-native-second')).toBeTruthy();
        expect(firstRender).toHaveBeenCalledTimes(firstRenderCountBeforeCacheKeyChange);
    });
});
