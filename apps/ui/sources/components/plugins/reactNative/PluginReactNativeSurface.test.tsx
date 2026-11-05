import * as React from 'react';
import {
    PLUGIN_UI_HOST_METHODS_V1,
    PluginUiMountContextV1Schema,
    PluginUiTargetedContributionsV1Schema,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { HappierSpinner } from '@happier-dev/plugin-ui/presentation';
import { act } from 'react-test-renderer';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { projectPluginUiTheme } from '../surfaces/pluginUiThemeProjection';
import { darkTheme } from '@/theme';
import type { PluginUiPrivatePresentationHost } from '../surfaces/pluginUiPrivatePresentationHost';
import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';
import { createCanonicalPluginReactNativeHostApiAdapter } from './hostApi';
import {
    createPluginReactNativeWatchdog,
} from './watchdog';

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

// Generic renderer/watchdog tests exercise the surface lifecycle, not a
// second public context construction path. They all use one real canonical
// context; context-specific tests below provide their own facts explicitly.
const defaultCanonicalSurface = createPluginSurfaceContextFixture({
    target: { kind: 'session', sessionId: 'session-1' },
});
const defaultHostApiAdapter = createCanonicalPluginReactNativeHostApiAdapter({
    surface: defaultCanonicalSurface,
    requestSurface: surfaceContext,
    requestIdPrefix: 'rn:test-default',
    handleRequest: async () => ({ accepted: true }),
    installedMethods: PLUGIN_UI_HOST_METHODS_V1,
});
const defaultRenderContext = Object.freeze({
    plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
    surface: defaultCanonicalSurface,
    hostApi: defaultHostApiAdapter.api,
    signal: new AbortController().signal,
}) satisfies RenderContext;

afterAll(() => {
    defaultHostApiAdapter.dispose();
});

describe('PluginReactNativeSurface', () => {

    it('renders host surface facts without re-admission while checking current host versions', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const surface = createPluginSurfaceContextFixture({
            targetedContributions: PluginUiTargetedContributionsV1Schema.parse({
                target: { pluginId: 'acme.preview', occurrenceId: 'native-perf', sourceCustody: {
                    kind: 'managed', immutableGenerationId: 'native-perf', installSource: 'archive',
                } },
                points: [],
            }),
        });
        const module = { renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-admitted' }) };
        const element = (context: RenderContext) => <PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={context}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={module}
        />;
        const mountParse = vi.spyOn(PluginUiMountContextV1Schema, 'safeParse');
        const targetedParse = vi.spyOn(PluginUiTargetedContributionsV1Schema, 'safeParse');
        try {
            let retired = false;
            const context = { ...defaultRenderContext, surface, hostApi: {
                ...defaultRenderContext.hostApi,
                version: () => {
                    if (retired) throw new Error('retired host');
                    return defaultRenderContext.hostApi.version();
                },
            } };
            const screen = await renderScreen(element(context));
            for (let index = 0; index < 20; index += 1) await screen.update(element({ ...context }));
            expect(screen.findByTestId('plugin-native-admitted')).toBeTruthy();
            expect(mountParse).not.toHaveBeenCalled();
            expect(targetedParse).not.toHaveBeenCalled();
            // A new host publication needs no separate admission proof.
            await screen.update(element({ ...context, surface: Object.freeze({ ...surface }) }));
            expect(mountParse).not.toHaveBeenCalled();
            expect(targetedParse).not.toHaveBeenCalled();
            retired = true;
            await screen.update(element(context));
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        } finally {
            mountParse.mockRestore();
            targetedParse.mockRestore();
        }
    });

    it('uses fallback instead of loading when compatibility does not allow RN execution', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn();

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
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
            renderContext={defaultRenderContext}
            decision={{
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
                fallback: { kind: 'hostedWeb', contributionId: 'web' },
            }}
                    />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('feature_disabled')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('feature_disabled');
    });

    it('says the machine is offline, not that the view may still be starting, when nothing loaded from an offline runtime', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            interactionEnabled={false}
                    />);

        const text = screen.getTextContent();
        expect(text).toContain('pluginSurfaces.state.offline.titleNothingLoaded');
        expect(text).not.toContain('pluginReactNative.unavailable');
        expect(text).not.toContain('pluginRuntime.unavailableGeneric');
    });

    it('renders a compatible loaded module through the boundary', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
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
                renderContext={defaultRenderContext}
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

    it('passes the canonical SDK render context directly to generated modules', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createCanonicalPluginReactNativeHostApiAdapter } = await import('./hostApi');
        const canonicalSurface = createPluginSurfaceContextFixture({
            target: { kind: 'session', sessionId: 'session-1' },
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surfaceContext,
            requestIdPrefix: 'rn-v2:test',
            handleRequest: vi.fn(async () => ({ accepted: true })),
            installedMethods: PLUGIN_UI_HOST_METHODS_V1,
        });
        const controller = new AbortController();
        const renderContext = Object.freeze({
            plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
            surface: canonicalSurface,
            hostApi: adapter.api,
            signal: controller.signal,
        });
        const renderSurface = vi.fn<PluginReactNativeSurfaceModule['renderSurface']>(
            () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        );

        await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            renderContext={renderContext}
            module={{ renderSurface }}
        />);

        const receivedContext = renderSurface.mock.calls[0]?.[0];
        expect(receivedContext).toMatchObject({
            plugin: renderContext.plugin,
            surface: renderContext.surface,
            hostApi: renderContext.hostApi,
            signal: renderContext.signal,
        });
        expect(receivedContext).not.toHaveProperty('view');
        expect(receivedContext).toBe(renderContext);
        expect(Object.isFrozen(receivedContext)).toBe(true);
        expect(Object.getOwnPropertySymbols(receivedContext ?? {})).toEqual([]);
        adapter.dispose();
    });

    it('keeps cooperative host-private carrier props off raw render contexts and unmarked elements', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createCanonicalPluginReactNativeHostApiAdapter } = await import('./hostApi');
        const canonicalSurface = createPluginSurfaceContextFixture({
            target: { kind: 'session', sessionId: 'session-1' },
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surfaceContext,
            requestIdPrefix: 'rn-v2:private-context',
            handleRequest: vi.fn(async () => ({ accepted: true })),
            installedMethods: PLUGIN_UI_HOST_METHODS_V1,
        });
        const renderPopover: PluginUiPrivatePresentationHost['renderPopover'] = vi.fn(
            (input) => input.content({ requestClose: () => input.onRequestClose(), maxHeight: 240 }),
        );
        const context = {
            plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
            surface: canonicalSurface,
            hostApi: adapter.api,
            signal: new AbortController().signal,
        };
        const renderContext = Object.freeze(context);
        const observed: {
            accountLifetime: unknown;
            resourceStoreGeneration: unknown;
            presentationHost: unknown;
            composerRef: unknown;
            injectedAccountLifetime: unknown;
            injectedResourceStoreGeneration: unknown;
            injectedPresentationHost: unknown;
            injectedComposerRef: unknown;
        } = {
            accountLifetime: undefined,
            resourceStoreGeneration: undefined,
            presentationHost: undefined,
            composerRef: undefined,
            injectedAccountLifetime: undefined,
            injectedResourceStoreGeneration: undefined,
            injectedPresentationHost: undefined,
            injectedComposerRef: undefined,
        };
        function RawPluginSurface(props: Readonly<{
            accountLifetime?: unknown;
            resourceStoreGeneration?: unknown;
            presentationHost?: unknown;
            composerRef?: unknown;
        }>) {
            observed.injectedAccountLifetime = props.accountLifetime;
            observed.injectedResourceStoreGeneration = props.resourceStoreGeneration;
            observed.injectedPresentationHost = props.presentationHost;
            observed.injectedComposerRef = props.composerRef;
            return React.createElement('PluginNativeSurface', { testID: 'plugin-native-private-context' });
        }
        const module: import('./PluginReactNativeSurface').PluginReactNativeSurfaceModule = {
            renderSurface(rawContext) {
                observed.accountLifetime = Reflect.get(rawContext, 'accountLifetime');
                observed.resourceStoreGeneration = Reflect.get(rawContext, 'resourceStoreGeneration');
                observed.presentationHost = Reflect.get(
                    rawContext,
                    Symbol.for('happier.pluginUi.privatePresentationHost.v1'),
                );
                observed.composerRef = Reflect.get(rawContext, 'composerRef');
                return React.createElement(RawPluginSurface);
            },
        };
        const composerRef = Object.freeze({
            composerId: 'composer_1',
            sessionId: 'session_1',
        });

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                renderContext={renderContext}
                module={module}
                privateHostBindings={Object.freeze({
                    accountLifetime: Object.freeze({ isCurrent: () => true }),
                    resourceStoreGeneration: 'generation-1',
                    presentationHost: Object.freeze({ renderPopover }),
                    composerRef,
                })}
            />);

            expect(screen.findByTestId('plugin-native-private-context')).toBeTruthy();
            expect(observed.accountLifetime).toBeUndefined();
            expect(observed.resourceStoreGeneration).toBeUndefined();
            expect(observed.presentationHost).toBeUndefined();
            expect(observed.composerRef).toBeUndefined();
            expect(observed.injectedAccountLifetime).toBeUndefined();
            expect(observed.injectedResourceStoreGeneration).toBeUndefined();
            expect(observed.injectedPresentationHost).toBeUndefined();
            expect(observed.injectedComposerRef).toBeUndefined();
            expect(renderPopover).not.toHaveBeenCalled();
        } finally {
            adapter.dispose();
        }
    });

    it('passes an opaque Composer ref through the cooperative host-private entry carrier', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const composerRef = Object.freeze({
            composerId: 'composer_1',
            sessionId: 'session_1',
        });
        function SurfaceEntryProvider(props: Readonly<{ composerRef?: unknown }>) {
            return React.createElement('PluginNativeSurface', {
                testID: props.composerRef === composerRef
                    ? 'plugin-native-composer-ref:bound'
                    : 'plugin-native-composer-ref:missing',
            });
        }
        Object.defineProperty(
            SurfaceEntryProvider,
            Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'),
            { value: true },
        );

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{ renderSurface: () => React.createElement(SurfaceEntryProvider) }}
            renderContext={defaultRenderContext}
            privateHostBindings={Object.freeze({ composerRef })}
        />);

        expect(screen.findByTestId('plugin-native-composer-ref:bound')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-composer-ref:missing')).toBeNull();
    });

    it('passes the opaque ephemeral shared scope only through the cooperative host-private entry carrier', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const ephemeralSharedScope = Object.freeze({ acquire: vi.fn(() => null) });
        let authorContextScope: unknown;
        function SurfaceEntryProvider(props: Readonly<{ ephemeralSharedScope?: unknown }>) {
            return React.createElement('PluginNativeSurface', {
                testID: props.ephemeralSharedScope === ephemeralSharedScope
                    ? 'plugin-native-ephemeral-scope:bound'
                    : 'plugin-native-ephemeral-scope:missing',
            });
        }
        Object.defineProperty(
            SurfaceEntryProvider,
            Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'),
            { value: true },
        );

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{
                renderSurface: (context) => {
                    authorContextScope = Reflect.get(context, 'ephemeralSharedScope');
                    return React.createElement(SurfaceEntryProvider);
                },
            }}
            renderContext={defaultRenderContext}
            privateHostBindings={Object.freeze({ ephemeralSharedScope })}
        />);

        expect(authorContextScope).toBeUndefined();
        expect(screen.findByTestId('plugin-native-ephemeral-scope:bound')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-ephemeral-scope:missing')).toBeNull();
    });

    it('keeps private entry bindings paired with the last interactive context while an offline snapshot is retained', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createCanonicalPluginReactNativeHostApiAdapter } = await import('./hostApi');
        const canonicalSurface = createPluginSurfaceContextFixture({
            target: { kind: 'session', sessionId: 'session-1' },
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: canonicalSurface,
            requestSurface: surfaceContext,
            requestIdPrefix: 'rn-v2:retained-private-bindings',
            handleRequest: vi.fn(async () => ({ accepted: true })),
            installedMethods: PLUGIN_UI_HOST_METHODS_V1,
        });
        const renderContext = (subPath: string) => Object.freeze({
            plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
            surface: canonicalSurface,
            hostApi: adapter.api,
            signal: new AbortController().signal,
            subPath,
        });
        function SurfaceEntryProvider(props: Readonly<{
            resourceStoreGeneration?: string;
            presentationActive?: boolean;
        }>) {
            return React.createElement('PluginNativeSurface', {
                testID: `plugin-native-private-generation:${props.resourceStoreGeneration ?? 'none'}`,
            }, <HappierSpinner color="red" animationEnabled={props.presentationActive} />);
        }
        Object.defineProperty(
            SurfaceEntryProvider,
            Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'),
            { value: true },
        );
        const module: import('./PluginReactNativeSurface').PluginReactNativeSurfaceModule = {
            renderSurface: vi.fn(() => React.createElement(SurfaceEntryProvider)),
        };
        const element = (input: Readonly<{
            renderContext: ReturnType<typeof renderContext>;
            generation: string;
            interactionEnabled: boolean;
            presentationActive: boolean;
        }>) => (
            <PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                renderContext={input.renderContext}
                interactionEnabled={input.interactionEnabled}
                privateHostBindings={Object.freeze({
                    resourceStoreGeneration: input.generation,
                    presentationActive: input.presentationActive,
                })}
            />
        );

        try {
            const screen = await renderScreen(element({
                renderContext: renderContext('interactive-view'),
                generation: 'generation-a',
                interactionEnabled: true,
                presentationActive: true,
            }));
            expect(screen.findByTestId('plugin-native-private-generation:generation-a')).toBeTruthy();

            await screen.update(element({
                renderContext: renderContext('offline-successor-view'),
                generation: 'generation-b',
                interactionEnabled: false,
                presentationActive: true,
            }));

            // The visual tree deliberately retains the last interactive public
            // context. Its private provider bindings must be retained with it:
            // a successor generation may not be paired with that old context.
            expect(screen.findByTestId('plugin-native-private-generation:generation-a')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-private-generation:generation-b')).toBeNull();
            expect(module.renderSurface).toHaveBeenCalledTimes(1);
            const spinnerStrip = () => screen.find((node) => node.type === 'span'
                && typeof node.props['data-happier-activity-spinner'] === 'string');
            expect(spinnerStrip().props.style.animationName).toBe('happierActivitySpinnerFilmstrip');

            await screen.update(element({
                renderContext: renderContext('offline-successor-view'),
                generation: 'generation-b',
                interactionEnabled: false,
                presentationActive: false,
            }));
            expect(spinnerStrip().props.style.animationName).toBeUndefined();
            expect(screen.findByTestId('plugin-native-private-generation:generation-a')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-private-generation:generation-b')).toBeNull();

            await screen.update(element({
                renderContext: renderContext('offline-successor-view'),
                generation: 'generation-b',
                interactionEnabled: false,
                presentationActive: true,
            }));
            expect(spinnerStrip().props.style.animationName).toBe('happierActivitySpinnerFilmstrip');
            expect(screen.findByTestId('plugin-native-private-generation:generation-a')).toBeTruthy();
            expect(module.renderSurface).toHaveBeenCalledTimes(1);
        } finally {
            adapter.dispose();
        }
    });

    it('follows the current theme while an offline snapshot retains the last interactive context', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const lightSurface = createPluginSurfaceContextFixture({
            target: { kind: 'session', sessionId: 'session-1' },
            colorScheme: 'light',
        });
        const darkSurface = createPluginSurfaceContextFixture({
            target: { kind: 'session', sessionId: 'session-1' },
            colorScheme: 'dark',
            theme: projectPluginUiTheme(darkTheme),
        });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: lightSurface,
            requestSurface: surfaceContext,
            requestIdPrefix: 'rn-v2:retained-theme',
            handleRequest: vi.fn(async () => ({ accepted: true })),
            installedMethods: PLUGIN_UI_HOST_METHODS_V1,
        });
        const renderContext = (surface: typeof lightSurface, subPath: string) => Object.freeze({
            plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
            surface,
            hostApi: adapter.api,
            signal: new AbortController().signal,
            subPath,
        });
        const seen: RenderContext[] = [];
        const module: PluginReactNativeSurfaceModule = {
            renderSurface: vi.fn((context: RenderContext) => {
                seen.push(context);
                return React.createElement('PluginNativeSurface', { testID: 'plugin-native-theme' });
            }),
        };
        const element = (input: Readonly<{ renderContext: ReturnType<typeof renderContext>; interactionEnabled: boolean }>) => (
            <PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                renderContext={input.renderContext}
                interactionEnabled={input.interactionEnabled}
            />
        );

        try {
            const screen = await renderScreen(element({
                renderContext: renderContext(lightSurface, 'interactive-view'),
                interactionEnabled: true,
            }));
            await screen.update(element({
                renderContext: renderContext(darkSurface, 'offline-successor-view'),
                interactionEnabled: false,
            }));

            // The mounted tree stays the last interactive generation (same
            // subPath), but how it is painted is a current host fact.
            const retained = seen[seen.length - 1]!;
            expect(retained.subPath).toBe('interactive-view');
            expect(retained.surface.colorScheme).toBe('dark');
            expect(retained.surface.theme).toBe(darkSurface.theme);
        } finally {
            adapter.dispose();
        }
    });

    it('injects the Data client through the cooperative host-private entry carrier', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const dataClient = Object.freeze({ owner: 'data' });
        function SurfaceEntryProvider(props: Readonly<{ dataClient?: unknown }>) {
            return React.createElement('PluginNativeSurface', {
                testID: props.dataClient === dataClient
                    ? 'plugin-native-data-client:bound'
                    : 'plugin-native-data-client:missing',
            });
        }
        Object.defineProperty(
            SurfaceEntryProvider,
            Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'),
            { value: true },
        );
        const module: import('./PluginReactNativeSurface').PluginReactNativeSurfaceModule = {
            renderSurface: () => React.createElement(SurfaceEntryProvider),
        };

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={module}
            privateHostBindings={Object.freeze({ dataClient })}
                    />);

        expect(screen.findByTestId('plugin-native-data-client:bound')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-data-client:missing')).toBeNull();
    });

    it('accepts a structurally valid app render context without optional targeted contributions or freezing', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-unfrozen-context' }));
        const unfrozenRenderContext = {
            ...defaultRenderContext,
            surface: createPluginSurfaceContextFixture({
                target: { kind: 'app' },
                targetedContributions: undefined,
            }),
        } satisfies RenderContext;

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            renderContext={unfrozenRenderContext}
            module={{ renderSurface }}
        />);

        expect(renderSurface).toHaveBeenCalledOnce();
        expect(screen.findByTestId('plugin-native-unfrozen-context')).toBeTruthy();
    });

    it('rejects a noncanonical render context instead of adapting it at the surface boundary', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const noncanonicalContext = Object.freeze({
            surface: surfaceContext,
            hostApi: { request: vi.fn(async () => undefined) },
        });

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            renderContext={noncanonicalContext as unknown as RenderContext}
            module={{ renderSurface }}
        />);

        expect(renderSurface).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('does not let retired UI-local trust flags authorize an external dynamic loader', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn(() => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
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
            renderContext={defaultRenderContext}
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
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            // Boundary fixture: the external loader can return an unknown module shape.
            module={{ renderSurface: null } as unknown as never}
                    />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-surface')).toBeNull();
    });


    it('adopts a successor mount after a pending load is retired without quarantining healthy bytes', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const retiredLoad = createDeferred<PluginReactNativeSurfaceModule>();
        const retired = new AbortController();
        const successor = new AbortController();
        const watchdog = createPluginReactNativeWatchdog();
        const artifactDigest = `sha256:${'8'.repeat(64)}` as const;
        const healthy = { renderSurface: () => React.createElement('View', { testID: 'successor-native-module' }) };
        const element = (signal: AbortSignal, load: () => Promise<PluginReactNativeSurfaceModule>) => (
            <PluginReactNativeSurface surfaceId="retired-load-surface" cacheKey="retired-load-artifact"
                renderContext={Object.freeze({ ...defaultRenderContext, signal })}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load} loadPolicy={{ source: 'installedArtifact' }} watchdog={watchdog}
                loadedRuntimeIdentity={{ pluginId: 'acme.preview', occurrenceId: 'occurrence-a', artifactDigest }} />
        );
        const screen = await renderScreen(element(retired.signal, () => retiredLoad.promise));
        await act(async () => {
            retired.abort();
            retiredLoad.reject(new Error('artifact_lease_revoked'));
        });
        expect(watchdog.isContained({ artifactDigest })).toBe(false);
        await screen.update(element(successor.signal, async () => healthy));
        await flushHookEffects();
        expect(screen.findByTestId('successor-native-module')).toBeTruthy();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        await screen.unmount();
    });

    it('retries a rejected cached loader with a fresh mount and pending feedback', async () => {
        vi.useFakeTimers();
        let rejectFirstLoad!: (error: Error) => void;
        const watchdog = createPluginReactNativeWatchdog();
        const firstLoad = new Promise<never>((_resolve, reject) => {
            rejectFirstLoad = reject;
        });
        const healthyModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-retry-healthy' }),
        };
        let resolveRetryLoad!: (module: typeof healthyModule) => void;
        const retryLoad = new Promise<typeof healthyModule>((resolve) => {
            resolveRetryLoad = resolve;
        });
        const load = vi.fn()
            .mockImplementationOnce(() => firstLoad)
            .mockImplementationOnce(() => retryLoad);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_retry_owner"
                watchdog={watchdog}
                            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledTimes(1);
            rejectFirstLoad(new Error('loader failed'));
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.retry');

            await act(async () => {
                screen.pressByTestId('plugin-rn-ui-unavailable-action');
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledTimes(2);
            expect(screen.findByTestId('plugin-rn-ui-unavailable-loading-spinner')).toBeTruthy();

            resolveRetryLoad(healthyModule);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-native-retry-healthy')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();

        } finally {
            vi.useRealTimers();
        }
    });

    describe('inside a Composer chip, whose caller owns the chrome', () => {
        // The chip is the one pressable. A host state card carries its own action button, so
        // every unavailable state must draw the caller's fallback (the chip's own icon and label)
        // and never a card: a <button> inside a <button> is invalid HTML and two focus stops.
        const chipFallback = React.createElement('ChipFallback', { testID: 'chip-own-content' });
        const pressableCount = (screen: Awaited<ReturnType<typeof renderScreen>>): number => (
            screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onPress === 'function').length
        );

        async function mountInChip(surface: React.ReactElement) {
            const { HappierComposerChip } = await import('@happier-dev/plugin-ui/presentation');
            return renderScreen(
                <HappierComposerChip testID="chip" accessibilityLabel="PRs & Issues" onPress={() => undefined}>
                    {surface}
                </HappierComposerChip>,
            );
        }

        it('draws the fallback, not a card with an action, when the renderer is not admitted', async () => {
            const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
            const screen = await mountInChip(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'fallback', reason: 'channel_policy_denied', diagnostics: [], fallback: { kind: 'hostedWeb', contributionId: 'web' } }}
                stateFallback={chipFallback}
                recoveryAction={{ label: 'Manage plugin', onPress: () => undefined }}
            />);

            expect(screen.findByTestId('chip-own-content')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(pressableCount(screen)).toBe(1);
        });

        it('draws the fallback, not a Retry card, when the artifact fails to load', async () => {
            const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
            const load = vi.fn(() => Promise.reject(new Error('loader failed')));
            const screen = await mountInChip(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_chip_load_failure"
                watchdog={createPluginReactNativeWatchdog()}
                stateFallback={chipFallback}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('chip-own-content')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();
            expect(pressableCount(screen)).toBe(1);
        });

        it('draws the fallback when the runtime is offline and nothing loaded', async () => {
            const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
            const screen = await mountInChip(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                interactionEnabled={false}
                stateFallback={chipFallback}
            />);

            expect(screen.findByTestId('chip-own-content')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(pressableCount(screen)).toBe(1);
        });
    });

    it('adopts a composed artifact load across context updates without imposing a competing deadline', async () => {
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
        vi.useFakeTimers();
        let renderedContext: RenderContext | undefined;
        const slowModule = {
            renderSurface: (context: RenderContext) => {
                renderedContext = context;
                return React.createElement('PluginNativeSurface', { testID: 'plugin-native-cold-load' });
            },
        };
        // External Artifact acquisition can await persistent storage before its
        // bounded byte RPC begins. Both phases complete; the renderer must not
        // invent a deadline for their composition or discard its valid result.
        const cacheRead = createDeferred<void>();
        const byteRead = createDeferred<typeof slowModule>();
        let acquisitions = 0;
        const slowLoad = async () => {
            acquisitions += 1;
            await cacheRead.promise;
            return await byteRead.promise;
        };
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const element = (renderContext: RenderContext) => <PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={renderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                // The host rebuilds acquisition closures from its current
                // projection; the unchanged cache key still names one Artifact.
                load={() => slowLoad()}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_cold_transfer"
            />;
            const slow = await renderScreen(element(defaultRenderContext));
            await flushHookEffects({ cycles: 1, turns: 2 });
            const currentContext = Object.freeze({ ...defaultRenderContext });
            await slow.update(element(currentContext));
            await flushHookEffects({ cycles: 1, turns: 2 });
            // Presentation context is not an Artifact identity. Restarting its
            // pending acquisition discards valid work and evaluates it again.
            expect(acquisitions).toBe(1);
            const phaseDuration = Math.floor(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS * 2 / 3);
            await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: phaseDuration });
            cacheRead.resolve();
            await flushHookEffects({ cycles: 1, turns: 2 });
            await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: phaseDuration });
            expect(slow.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();
            expect(slow.findByTestId('plugin-rn-ui-loading')).toBeTruthy();

            byteRead.resolve(slowModule);
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(slow.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(slow.findByTestId('plugin-native-cold-load')).toBeTruthy();
            expect(renderedContext).toBe(currentContext);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps optional content quiet but shows loading for a declared embedded fallback slot', async () => {
        // A card slot in a pane (the Git pane's PR card) must not claim the pane with a page skeleton that
        // then collapses when the plugin has nothing to show; a destination keeps its page-shaped placeholder.
        const pending = createDeferred<PluginReactNativeSurfaceModule>();
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const element = (embeddedPresentation?: 'content' | 'fill', targetedFallback?: React.ReactNode) => <PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={() => pending.promise}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey={`cache_embedded_${embeddedPresentation ?? 'destination'}_${targetedFallback != null}`}
            {...(embeddedPresentation ? { embeddedPresentation } : {})}
            {...(targetedFallback === undefined ? {} : { targetedFallback })}
        />;
        const destination = await renderScreen(element());
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(destination.findByTestId('plugin-rn-ui-loading')).toBeTruthy();

        const content = await renderScreen(element('content'));
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(content.findByTestId('plugin-rn-ui-loading')).toBeNull();
        expect(content.findByTestId('plugin-rn-ui-unavailable')).toBeNull();

        const silentContent = await renderScreen(element('content', null));
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(silentContent.findByTestId('plugin-rn-ui-loading')).toBeNull();

        // Triage already reserves its source's detail slot with a fallback. Its sibling agent step must not
        // look like the entire Overview while the source artifact supplying the first steps is loading.
        const requiredContent = await renderScreen(element('content', <React.Fragment>Source detail unavailable</React.Fragment>));
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(requiredContent.findByTestId('plugin-rn-ui-loading')).toBeTruthy();
        expect(requiredContent.findByTestId('plugin-rn-ui-unavailable')).toBeNull();

        pending.resolve({ renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-card' }) });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(content.findByTestId('plugin-native-card')).toBeTruthy();
        expect(requiredContent.findByTestId('plugin-native-card')).toBeTruthy();
        expect(requiredContent.findByTestId('plugin-rn-ui-loading')).toBeNull();
    });

    it('retries a nonpersisted loader failure with a fresh mount attempt', async () => {
        const healthyModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-loader-retry-healthy' }),
        };
        const load = vi.fn()
            .mockRejectedValueOnce(new Error('loader failed'))
            .mockResolvedValueOnce(healthyModule);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={load}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_loader_retry"
                    />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(load).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.retry');

        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(load).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('plugin-native-loader-retry-healthy')).toBeTruthy();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
    });


    it('keeps a renderSurface-only module healthy after the former acknowledgment deadline', async () => {
        const artifactDigest = `sha256:${'a'.repeat(64)}` as const;
        vi.useFakeTimers();
        const watchdog = createPluginReactNativeWatchdog();
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        }));

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_render_surface_only_host_commit"
                watchdog={watchdog}
                loadedRuntimeIdentity={{
                    pluginId: 'acme.preview',
                    occurrenceId: 'healthy-plugin-occurrence',
                    artifactDigest,
                }}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();

            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
            expect(watchdog.isContained({ artifactDigest })).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reuses a current process-global module without invoking its loader again', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('./moduleRegistry');
        const cacheKey = 'cache_current_process_module_reuse';
        const registry = getInstalledPluginReactNativeModuleRegistry();
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', {
            testID: 'plugin-native-cached-module',
        }));
        const load = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-loader-module',
            }),
        }));
        registry.reconcileActiveCacheKeys([cacheKey]);
        const writeFence = registry.captureWriteFence(cacheKey);
        expect(writeFence).not.toBeNull();
        expect(registry.write(cacheKey, { renderSurface }, writeFence!)).toBe(true);

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey={cacheKey}
                            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(load).not.toHaveBeenCalled();
            expect(screen.findByTestId('plugin-native-cached-module')).toBeTruthy();
            expect(renderSurface).toHaveBeenCalledTimes(1);
        } finally {
            registry.reconcileActiveCacheKeys([]);
        }
    });

    it('does not restore a retired process-global module when an earlier loader settles', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('./moduleRegistry');
        const cacheKey = 'cache_retired_while_loader_settles';
        const registry = getInstalledPluginReactNativeModuleRegistry();
        const deferredModule = createDeferred<PluginReactNativeSurfaceModule>();
        const load = vi.fn(() => deferredModule.promise);

        registry.reconcileActiveCacheKeys([cacheKey]);
        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey={cacheKey}
                            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledOnce();
            registry.reconcileActiveCacheKeys([]);

            await act(async () => {
                deferredModule.resolve({
                    renderSurface: () => React.createElement('PluginNativeSurface', {
                        testID: 'plugin-native-retired-loader-module',
                    }),
                });
                await deferredModule.promise;
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(registry.read(cacheKey)).toBeNull();
            expect(screen.findByTestId('plugin-native-retired-loader-module')).toBeTruthy();
        } finally {
            registry.reconcileActiveCacheKeys([]);
        }
    });

    it('retains an in-flight module whose own process-global cache key remains current', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('./moduleRegistry');
        const currentCacheKey = 'cache_current_while_sibling_retires';
        const retiredSiblingCacheKey = 'cache_sibling_retires';
        const registry = getInstalledPluginReactNativeModuleRegistry();
        const deferredModule = createDeferred<PluginReactNativeSurfaceModule>();
        const load = vi.fn(() => deferredModule.promise);

        registry.reconcileActiveCacheKeys([currentCacheKey, retiredSiblingCacheKey]);
        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey={currentCacheKey}
                            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledOnce();
            registry.reconcileActiveCacheKeys([currentCacheKey]);

            await act(async () => {
                deferredModule.resolve({
                    renderSurface: () => React.createElement('PluginNativeSurface', {
                        testID: 'plugin-native-current-loader-module',
                    }),
                });
                await deferredModule.promise;
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(registry.read(currentCacheKey)).not.toBeNull();
            expect(registry.read(retiredSiblingCacheKey)).toBeNull();
            expect(screen.findByTestId('plugin-native-current-loader-module')).toBeTruthy();
        } finally {
            registry.reconcileActiveCacheKeys([]);
        }
    });

    it('does not admit an old module after its cache key retires and re-enters', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('./moduleRegistry');
        const cacheKey = 'cache_retires_then_reenters_during_load';
        const registry = getInstalledPluginReactNativeModuleRegistry();
        const deferredModule = createDeferred<PluginReactNativeSurfaceModule>();
        const load = vi.fn(() => deferredModule.promise);

        registry.reconcileActiveCacheKeys([cacheKey]);
        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey={cacheKey}
                            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledOnce();
            registry.reconcileActiveCacheKeys([]);
            registry.reconcileActiveCacheKeys([cacheKey]);

            await act(async () => {
                deferredModule.resolve({
                    renderSurface: () => React.createElement('PluginNativeSurface', {
                        testID: 'plugin-native-reentered-loader-module',
                    }),
                });
                await deferredModule.promise;
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(registry.read(cacheKey)).toBeNull();
            expect(screen.findByTestId('plugin-native-reentered-loader-module')).toBeTruthy();
        } finally {
            registry.reconcileActiveCacheKeys([]);
        }
    });

    it('contains a direct render error by artifact digest for local Retry', async () => {
        const artifactDigest = `sha256:${'a'.repeat(64)}` as const;
        const watchdog = createPluginReactNativeWatchdog();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => {
                        throw new Error('plugin render failure');
                    },
                }}
                cacheKey="cache_1"
                watchdog={watchdog}
                loadedRuntimeIdentity={{
                    pluginId: 'acme.preview',
                    occurrenceId: 'plugin-occurrence-a',
                    artifactDigest,
                }}
                            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(watchdog.isContained({ artifactDigest })).toBe(true);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('recovers a render failure for a new host mount identity without remounting an equal replacement', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let nextRecoveredInstance = 0;
        const CrashingSurface = () => {
            throw new Error('composer generation A render failure');
        };
        const RecoveredSurface = () => {
            const [instance] = React.useState(() => {
                nextRecoveredInstance += 1;
                return `recovered-${nextRecoveredInstance}`;
            });
            return React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-recovered-surface',
                accessibilityLabel: instance,
            });
        };
        const crashingModule = Object.freeze({
            renderSurface: () => React.createElement(CrashingSurface),
        });
        const recoveredModule = Object.freeze({
            renderSurface: () => React.createElement(RecoveredSurface),
        });
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const render = (boundaryResetKey: string, module: typeof crashingModule | typeof recoveredModule) => (
            <PluginReactNativeSurface
                surfaceId="composer:logical-instance"
                mountInstanceKey="composer-region:session-a:summary"
                boundaryResetKey={boundaryResetKey}
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                cacheKey="composer-cache"
            />
        );

        try {
            const screen = await renderScreen(render('composer-generation-a', crashingModule));
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

            await screen.update(render('composer-generation-b', recoveredModule));
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByTestId('plugin-native-recovered-surface')?.props.accessibilityLabel)
                .toBe('recovered-1');

            await screen.update(render('composer-generation-b', recoveredModule));
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByTestId('plugin-native-recovered-surface')?.props.accessibilityLabel)
                .toBe('recovered-1');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps the targeted caller fallback after a contributor render crash while containing its digest', async () => {
        const artifactDigest = `sha256:${'b'.repeat(64)}` as const;
        const watchdog = createPluginReactNativeWatchdog();
        const onCrash = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => {
                        throw new Error('targeted_contributor_render_failure');
                    },
                }}
                watchdog={watchdog}
                loadedRuntimeIdentity={{
                    pluginId: 'acme.contributor',
                    occurrenceId: 'targeted-plugin-occurrence-a',
                    artifactDigest,
                }}
                onCrash={onCrash}
                targetedFallback={React.createElement('TargetedFallback', {
                    testID: 'targeted-contributor-crash-fallback',
                })}
            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('targeted-contributor-crash-fallback')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(onCrash).toHaveBeenCalledWith('surface_1', expect.objectContaining({
                message: 'targeted_contributor_render_failure',
            }));
            expect(watchdog.isContained({ artifactDigest })).toBe(true);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('retries a targeted child for replacement launch input without remounting a healthy same-entry child', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const onCrash = vi.fn();
        const renderContext = (reviewId: string) => Object.freeze({
            ...defaultRenderContext,
            launchInput: Object.freeze({ reviewId }),
        }) satisfies RenderContext;
        const readReviewId = (context: RenderContext): string => {
            const input = context.launchInput;
            if (!input || typeof input !== 'object') return 'none';
            const reviewId = Reflect.get(input, 'reviewId');
            return typeof reviewId === 'string' ? reviewId : 'none';
        };
        let healthyMounts = 0;
        function HealthyTargetedSurface(props: Readonly<{ reviewId: string }>) {
            const [count, setCount] = React.useState(0);
            React.useEffect(() => {
                healthyMounts += 1;
            }, []);
            return React.createElement('PluginNativeSurface', {
                testID: `targeted-healthy:${props.reviewId}:${count}`,
                onClick: () => setCount((previous) => previous + 1),
            });
        }
        const module: PluginReactNativeSurfaceModule = {
            renderSurface: (context) => {
                const reviewId = readReviewId(context);
                if (reviewId === 'crashes') {
                    throw new Error('targeted_launch_input_render_failure');
                }
                return React.createElement(HealthyTargetedSurface, { reviewId });
            },
        };
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const element = (reviewId: string) => (
            <PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={renderContext(reviewId)}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                cacheKey="targeted-launch-input"
                targetedFallback={React.createElement('TargetedFallback', {
                    testID: 'targeted-launch-input-fallback',
                })}
                onCrash={onCrash}
            />
        );

        try {
            const crashed = await renderScreen(element('crashes'));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(crashed.findByTestId('targeted-launch-input-fallback')).toBeTruthy();
            expect(onCrash).toHaveBeenCalledWith('surface_1', expect.objectContaining({
                message: 'targeted_launch_input_render_failure',
            }));

            await crashed.update(element('recovered'));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(crashed.findByTestId('targeted-launch-input-fallback')).toBeNull();
            expect(crashed.findByTestId('targeted-healthy:recovered:0')).toBeTruthy();

            await act(async () => {
                crashed.pressByTestId('targeted-healthy:recovered:0');
            });
            expect(crashed.findByTestId('targeted-healthy:recovered:1')).toBeTruthy();
            expect(healthyMounts).toBe(1);

            await crashed.update(element('replacement'));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(crashed.findByTestId('targeted-healthy:replacement:1')).toBeTruthy();
            expect(healthyMounts).toBe(1);
        } finally {
            consoleError.mockRestore();
        }
    });

    it('retries a render failure with a fresh boundary', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let renderShouldFail = true;
        let renderAttempts = 0;
        const module: PluginReactNativeSurfaceModule = {
            renderSurface: () => {
                renderAttempts += 1;
                if (renderShouldFail) {
                    throw new Error('plugin render failure');
                }
                return React.createElement('PluginNativeSurface', { testID: 'plugin-native-render-retry-healthy' });
            },
        };
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                cacheKey="cache_render_retry"
                            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.retry');

            const renderAttemptsBeforeRetry = renderAttempts;
            renderShouldFail = false;
            await act(async () => {
                screen.pressByTestId('plugin-rn-ui-unavailable-action');
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(renderAttempts).toBeGreaterThan(renderAttemptsBeforeRetry);
            expect(screen.findByTestId('plugin-native-render-retry-healthy')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        } finally {
            consoleError.mockRestore();
        }
    });


    it('retains the previously loaded module while a replacement is pending and after it fails', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const firstRender = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-first' }));
        const secondRender = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-second' }));
        const managePlugin = vi.fn();
        let rejectSecondLoad!: (error: Error) => void;
        const firstLoad = vi.fn(() => ({ renderSurface: firstRender }));
        const secondLoad = vi.fn(() => new Promise<{ renderSurface: typeof secondRender }>((_resolve, reject) => {
            rejectSecondLoad = reject;
        }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={firstLoad}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_1"
                    />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-native-first')).toBeTruthy();
        const firstRenderCountBeforeCacheKeyChange = firstRender.mock.calls.length;

        await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={secondLoad}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_2"
                recoveryAction={{ label: 'route fallback', onPress: managePlugin }}
            />);
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(secondLoad).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-first')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-second')).toBeNull();

        rejectSecondLoad(Object.assign(new Error('candidate failed'), {
            code: 'module_instantiation_failed',
            diagnostics: ['module_instantiation_failed'],
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-native-first')).toBeTruthy();
        expect(screen.findByTestId('plugin-native-second')).toBeNull();
        expect(screen.findByTestId('plugin-rn-ui-retained-status')).toBeTruthy();
        expect(screen.findByTestId('plugin-rn-ui-retained-status-action')?.props.accessibilityLabel)
            .toBe('settingsPlugins.managePlugin');
        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-retained-status-action');
        });
        expect(managePlugin).toHaveBeenCalledOnce();
        expect(firstRender.mock.calls.length).toBeGreaterThan(firstRenderCountBeforeCacheKeyChange);
    });

    it('retains the incumbent when a loaded replacement throws during candidate render', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const firstLoad = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-render-incumbent' }),
        }));
        const candidateLoad = vi.fn(async () => ({
            renderSurface: () => {
                throw new Error('candidate_render_failed');
            },
        }));
        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={firstLoad}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="render-incumbent"
            />);
            await flushHookEffects({ cycles: 3, turns: 2 });
            expect(screen.findByTestId('plugin-native-render-incumbent')).toBeTruthy();

            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={candidateLoad}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="render-candidate"
            />);
            await flushHookEffects({ cycles: 3, turns: 2 });

            expect(screen.findByTestId('plugin-native-render-incumbent')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-retained-status')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        } finally {
            consoleError.mockRestore();
        }
    });
});
