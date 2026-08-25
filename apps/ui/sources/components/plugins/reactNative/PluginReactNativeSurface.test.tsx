import * as React from 'react';
import {
    PLUGIN_UI_HOST_METHODS_V1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { act } from 'react-test-renderer';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import type { PluginUiPrivatePresentationHost } from '../surfaces/pluginUiPrivatePresentationHost';
import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';
import { createCanonicalPluginReactNativeHostApiAdapter } from './hostApi';
import {
    createPluginReactNativeWatchdog,
    type PluginReactNativeWatchdogSnapshot,
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

const crashStateToken = {
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview-destination' },
    },
    renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    crashStateEpoch: 4,
} as const;

const crashReportScopeKey = 'server-a\u0000machine-a\u0000account-a';

const targetedCrashStateToken = {
    mount: {
        kind: 'targetedSurface',
        target: {
            pluginId: 'acme.target',
            immutableGenerationId: 'target-generation',
        },
        point: {
            pointId: 'providers',
            protocol: { id: 'packed-provider', version: 1 },
        },
        contributor: {
            pluginId: 'acme.contributor',
            contributionId: 'provider-a',
            immutableGenerationId: 'contributor-generation',
        },
        role: 'detail',
        presentation: 'content',
    },
    renderer: { pluginId: 'acme.contributor', localId: 'targeted-native-preview' },
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    crashStateEpoch: 6,
} as const;

const composerCrashStateToken = {
    mount: {
        kind: 'composer',
        contribution: { pluginId: 'acme.composer', localId: 'review' },
        immutableGenerationId: 'composer-generation',
        role: 'attachmentPreview',
    },
    renderer: { pluginId: 'acme.composer', localId: 'review-native-preview' },
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    crashStateEpoch: 7,
} as const;

describe('PluginReactNativeSurface', () => {
    it('replays one persisted exact failure before cached bytes can execute', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });
        const pending = watchdog.recordFailure({
            token: crashStateToken,
            scopeKey: crashReportScopeKey,
            failure: 'render_error',
        });
        const reportFailure = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{ renderSurface }}
            watchdog={watchdog}
            crashStateToken={crashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            reportFailure={reportFailure}
                    />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(reportFailure).toHaveBeenCalledWith(pending);
        expect(renderSurface).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(watchdog.readPending({ token: crashStateToken, scopeKey: crashReportScopeKey })).toEqual([pending]);
    });

    it('mounts a surface whose durable store cannot be read and that never recorded a failure', async () => {
        // A store that cannot answer is not evidence of a crash. Containment
        // belongs to a real recorded failure and to the daemon's disabled fact;
        // an unreadable local store must never blank a working plugin, least of
        // all while the daemon projection is a retained offline snapshot.
        const watchdog = createPluginReactNativeWatchdog({
            persistence: {
                readSnapshot: () => { throw new Error('platform storage unavailable'); },
                writeSnapshot: () => { throw new Error('platform storage unavailable'); },
            },
        });
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{ renderSurface }}
            watchdog={watchdog}
            crashStateToken={crashStateToken}
            crashReportScopeKey={crashReportScopeKey}
        />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(renderSurface).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
    });

    it('does not forward a persisted occurrence from a retired server, machine, and Account scope to an equal token', async () => {
        let persisted: PluginReactNativeWatchdogSnapshot | null = null;
        const persistence = {
            readSnapshot: () => persisted === null ? null : { snapshot: persisted },
            writeSnapshot: (snapshot: PluginReactNativeWatchdogSnapshot) => {
                persisted = snapshot;
            },
        };
        const sourceScopeKey = 'server-a\u0000machine-a\u0000account-a';
        const successorScopeKey = 'server-b\u0000machine-b\u0000account-b';
        const sourceWatchdog = createPluginReactNativeWatchdog({
            persistence,
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });
        const persistedFailure = {
            token: crashStateToken,
            failure: 'render_error' as const,
            scopeKey: sourceScopeKey,
        };
        sourceWatchdog.recordFailure(persistedFailure);
        const watchdog = createPluginReactNativeWatchdog({
            persistence,
        });
        const reportFailure = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{ renderSurface }}
            watchdog={watchdog}
            crashStateToken={crashStateToken}
            reportFailure={reportFailure}
            crashReportScopeKey={successorScopeKey}
        />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(reportFailure).not.toHaveBeenCalled();
        expect(renderSurface).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
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
        }>) {
            return React.createElement('PluginNativeSurface', {
                testID: `plugin-native-private-generation:${props.resourceStoreGeneration ?? 'none'}`,
            });
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
        }>) => (
            <PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={module}
                renderContext={input.renderContext}
                interactionEnabled={input.interactionEnabled}
                privateHostBindings={Object.freeze({
                    resourceStoreGeneration: input.generation,
                })}
            />
        );

        try {
            const screen = await renderScreen(element({
                renderContext: renderContext('interactive-view'),
                generation: 'generation-a',
                interactionEnabled: true,
            }));
            expect(screen.findByTestId('plugin-native-private-generation:generation-a')).toBeTruthy();

            await screen.update(element({
                renderContext: renderContext('offline-successor-view'),
                generation: 'generation-b',
                interactionEnabled: false,
            }));

            // The visual tree deliberately retains the last interactive public
            // context. Its private provider bindings must be retained with it:
            // a successor generation may not be paired with that old context.
            expect(screen.findByTestId('plugin-native-private-generation:generation-a')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-private-generation:generation-b')).toBeNull();
            expect(module.renderSurface).toHaveBeenCalledTimes(1);
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

    it('accepts a structurally valid render context without treating freezing as provenance', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-unfrozen-context' }));
        const unfrozenRenderContext = {
            ...defaultRenderContext,
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

    it('routes invalid loader modules through the daemon crash custody path', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac15',
        });
        const reportFailure = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={vi.fn(async () => ({ renderSurface: null } as unknown as never))}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_1"
            watchdog={watchdog}
            crashStateToken={crashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            reportFailure={reportFailure}
                    />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('invalid_surface_module')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('invalid_surface_module');
        expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
            token: crashStateToken,
            failure: 'invalid_surface_module',
            failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac15',
        }));
    });

    it('routes loader backend failures through the daemon crash custody path', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac16',
        });
        const reportFailure = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
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
            crashStateToken={crashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            reportFailure={reportFailure}
                    />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('loader_backend_unavailable')).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain('loader_backend_unavailable');
        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();
        expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
            token: crashStateToken,
            failure: 'load_error',
            failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac16',
        }));
        expect(watchdog.readPending({ token: crashStateToken, scopeKey: crashReportScopeKey }))
            .toHaveLength(1);
    });

    it('contains a startup timeout until the user retries the current mount', async () => {
        vi.useFakeTimers();
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac17',
        });
        const reportFailure = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
        const load = vi.fn(() => new Promise<never>(() => undefined));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_1"
                loadTimeoutMs={100}
                watchdog={watchdog}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
                reportFailure={reportFailure}
                            />);

            await flushHookEffects({ cycles: 1, turns: 2 });
            expect(load).toHaveBeenCalledTimes(1);

            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-surface')).toBeNull();
            expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
                token: crashStateToken,
                failure: 'load_timeout',
                failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac17',
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries a startup failure with a fresh mount and fences an old loader settlement', async () => {
        vi.useFakeTimers();
        let rejectFirstLoad!: (error: Error) => void;
        const watchdog = createPluginReactNativeWatchdog({});
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
                loadTimeoutMs={100}
                watchdog={watchdog}
                            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledTimes(1);
            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

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

            rejectFirstLoad(new Error('stale loader failure'));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-native-retry-healthy')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
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

    it('keeps failed daemon reset retries available without exposing the raw failure', async () => {
        const load = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-after-reset' }),
        }));
        const resetCrashState = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={crashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
            load={load}
            loadPolicy={{ source: 'installedArtifact' }}
                    />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
        expect(load).not.toHaveBeenCalled();
        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(resetCrashState).toHaveBeenCalledTimes(1);
        expect(screen.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('reset_failed')
        )).length).toBeGreaterThan(0);
        const resetDiagnostics = screen.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('crash_reset_context:status=reset_failed')
        ));
        expect(resetDiagnostics.length).toBeGreaterThan(0);
        const resetDiagnostic = String(resetDiagnostics[0]?.props.testID);
        expect(resetDiagnostic).toContain('plugin=acme.preview');
        expect(resetDiagnostic).toContain('renderer=native-preview');
        expect(resetDiagnostic).toContain('mount=destination;');
        expect(resetDiagnostic).toContain('contributor=none');
        expect(resetDiagnostic).toContain('failure=request_failed');
        expect(resetDiagnostic).toContain('disabled=true');
        expect(resetDiagnostic).toContain('epoch=4');
        expect(resetDiagnostic).toContain('result=failed');
        expect(screen.getTextContent()).toContain('pluginReactNative.reset.failed.title');
        expect(screen.getTextContent()).toContain('pluginReactNative.reset.failed.reason');
        expect(screen.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.getTextContent()).not.toContain('request_failed');

        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(resetCrashState).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(resetCrashState).toHaveBeenCalledTimes(3);
        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
    });

    it('projects target reset context without serializing a raw binding token', async () => {
        const resetCrashState = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={targetedCrashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
                    />);

        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        const resetDiagnostic = String(screen.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('crash_reset_context:status=reset_failed')
        ))[0]?.props.testID);
        expect(resetDiagnostic).toContain('plugin=acme.contributor');
        expect(resetDiagnostic).toContain('renderer=targeted-native-preview');
        expect(resetDiagnostic).toContain('mount=targeted_surface;');
        expect(resetDiagnostic).toContain('contributor=provider-a');
        expect(resetDiagnostic).toContain('failure=request_failed');
        expect(resetDiagnostic).toContain('disabled=true');
        expect(resetDiagnostic).toContain('epoch=6');
        expect(resetDiagnostic).toContain('result=failed');
        expect(resetDiagnostic).not.toContain('target-generation');
        expect(resetDiagnostic).not.toContain('contributor-generation');
        expect(resetDiagnostic).not.toContain('sha256');
        expect(screen.getTextContent()).not.toContain('request_failed');
    });

    it('projects Composer reset context without serializing its mount identity', async () => {
        const resetCrashState = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={composerCrashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
        />);

        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        const resetDiagnostic = String(screen.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('crash_reset_context:status=reset_failed')
        ))[0]?.props.testID);
        expect(resetDiagnostic).toContain('plugin=acme.composer');
        expect(resetDiagnostic).toContain('renderer=review-native-preview');
        expect(resetDiagnostic).toContain('mount=composer;');
        expect(resetDiagnostic).toContain('contributor=none');
        expect(resetDiagnostic).toContain('failure=request_failed');
        expect(resetDiagnostic).toContain('disabled=true');
        expect(resetDiagnostic).toContain('epoch=7');
        expect(resetDiagnostic).toContain('result=failed');
        expect(resetDiagnostic).not.toContain('composer-generation');
        expect(resetDiagnostic).not.toContain('attachmentPreview');
        expect(resetDiagnostic).not.toContain('sha256');
        expect(screen.getTextContent()).not.toContain('request_failed');
    });

    it('waits for the daemon-issued reset projection before resuming a disabled surface', async () => {
        vi.useFakeTimers();
        const resetToken = {
            ...crashStateToken,
            crashStateEpoch: crashStateToken.crashStateEpoch + 1,
        } as const;
        let resolveReset!: (result: {
            ok: true;
            token: typeof resetToken;
            disabled: false;
        }) => void;
        const resetCrashState = vi.fn(() => new Promise<{
            ok: true;
            token: typeof resetToken;
            disabled: false;
        }>((resolveResetPromise) => {
            resolveReset = resolveResetPromise;
        }));
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-after-reset' }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
                crashStateDisabled
                resetCrashState={resetCrashState}
                module={{ renderSurface }}
                        />);

            await act(async () => {
                screen.pressByTestId('plugin-rn-ui-unavailable-action');
                await Promise.resolve();
            });
            expect(screen.findByTestId('plugin-rn-ui-unavailable-loading-spinner')).toBeTruthy();
            expect(screen.getTextContent()).toContain('pluginReactNative.reset.requested.title');
            expect(screen.findByTestId('plugin-rn-ui-unavailable')?.props.accessibilityLiveRegion).toBe('polite');
            expect(screen.findAll((node) => (
                typeof node.props.testID === 'string'
                && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
                && node.props.testID.includes('reset_requested')
            )).length).toBeGreaterThan(0);

            await act(async () => {
                resolveReset({ ok: true, token: resetToken, disabled: false });
                await Promise.resolve();
            });
            expect(screen.getTextContent()).toContain('pluginReactNative.reset.awaitingProjection.title');
            expect(screen.findAll((node) => (
                typeof node.props.testID === 'string'
                && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
                && node.props.testID.includes('awaiting_new_projection')
            )).length).toBeGreaterThan(0);
            expect(renderSurface).not.toHaveBeenCalled();

            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                crashStateToken={resetToken}
                crashReportScopeKey={crashReportScopeKey}
                crashStateDisabled={false}
                resetCrashState={resetCrashState}
                module={{ renderSurface }}
                        />);
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByTestId('plugin-native-after-reset')).toBeTruthy();
            expect(renderSurface).toHaveBeenCalledTimes(1);
            const resetCompleteToast = screen.findByTestId('plugin-rn-ui-reset-complete');
            expect(resetCompleteToast).toBeTruthy();
            expect(resetCompleteToast?.props.accessibilityLiveRegion).toBe('polite');
            expect(resetCompleteToast?.props['aria-live']).toBe('polite');
            expect(screen.getTextContent()).toContain('pluginReactNative.reset.complete.title');

            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 4000 });
            expect(screen.findByTestId('plugin-rn-ui-reset-complete')).toBeNull();

            // A later daemon disable on the settled reset epoch is a new incident,
            // not a reason to retain the prior completion feedback indefinitely.
            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                crashStateToken={resetToken}
                crashReportScopeKey={crashReportScopeKey}
                crashStateDisabled
                resetCrashState={resetCrashState}
                module={{ renderSurface }}
                        />);
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds an accepted reset when its new daemon projection does not arrive', async () => {
        vi.useFakeTimers();
        const resetToken = {
            ...crashStateToken,
            crashStateEpoch: crashStateToken.crashStateEpoch + 1,
        } as const;
        const resetCrashState = vi.fn(async () => ({ ok: true as const, token: resetToken, disabled: false as const }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
                crashStateDisabled
                resetCrashState={resetCrashState}
                loadTimeoutMs={100}
                        />);

            await act(async () => {
                screen.pressByTestId('plugin-rn-ui-unavailable-action');
            });
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(screen.getTextContent()).toContain('pluginReactNative.reset.awaitingProjection.title');
            expect(screen.findByTestId('plugin-rn-ui-unavailable-action')).toBeNull();

            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            const resetDiagnostic = String(screen.findAll((node) => (
                typeof node.props.testID === 'string'
                && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
                && node.props.testID.includes('crash_reset_context:status=reset_failed')
            ))[0]?.props.testID);
            expect(resetDiagnostic).toContain('failure=projection_timeout');
            expect(resetDiagnostic).toContain('result=failed');
            expect(screen.getTextContent()).toContain('pluginReactNative.reset.failed.title');
            expect(screen.getTextContent()).not.toContain('projection_timeout');
            expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
        } finally {
            vi.useRealTimers();
        }
    });

    it('discards a reset result once a different daemon crash projection is current', async () => {
        const resetToken = {
            ...crashStateToken,
            crashStateEpoch: crashStateToken.crashStateEpoch + 1,
        } as const;
        const replacementToken = {
            ...crashStateToken,
            artifactDigest: `sha256:${'b'.repeat(64)}`,
        } as const;
        let resolveReset!: (result: {
            ok: true;
            token: typeof resetToken;
            disabled: false;
        }) => void;
        const resetCrashState = vi.fn(() => new Promise<{
            ok: true;
            token: typeof resetToken;
            disabled: false;
        }>((resolveResetPromise) => {
            resolveReset = resolveResetPromise;
        }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={crashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
                    />);

        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
            await Promise.resolve();
        });
        await screen.update(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={replacementToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
                    />);
        await act(async () => {
            resolveReset({ ok: true, token: resetToken, disabled: false });
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
        expect(screen.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('awaiting_new_projection')
        ))).toHaveLength(0);
    });

    it('discards a Composer reset result after its immutable mount generation changes', async () => {
        const resetToken = {
            ...composerCrashStateToken,
            crashStateEpoch: composerCrashStateToken.crashStateEpoch + 1,
        } as const;
        const replacementToken = {
            ...composerCrashStateToken,
            mount: {
                ...composerCrashStateToken.mount,
                immutableGenerationId: 'composer-generation-replacement',
            },
        } as const;
        let resolveReset!: (result: {
            ok: true;
            token: typeof resetToken;
            disabled: false;
        }) => void;
        const resetCrashState = vi.fn(() => new Promise<{
            ok: true;
            token: typeof resetToken;
            disabled: false;
        }>((resolveResetPromise) => {
            resolveReset = resolveResetPromise;
        }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={composerCrashStateToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
        />);

        await act(async () => {
            screen.pressByTestId('plugin-rn-ui-unavailable-action');
            await Promise.resolve();
        });
        await screen.update(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            crashStateToken={replacementToken}
            crashReportScopeKey={crashReportScopeKey}
            crashStateDisabled
            resetCrashState={resetCrashState}
        />);
        await act(async () => {
            resolveReset({ ok: true, token: resetToken, disabled: false });
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findByTestId('plugin-rn-ui-unavailable-action')?.props.accessibilityLabel).toBe('common.reset');
        expect(screen.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.includes('plugin-rn-ui-unavailable-diagnostic-')
            && node.props.testID.includes('awaiting_new_projection')
        ))).toHaveLength(0);
    });

    it('keeps a renderSurface-only module healthy after the former acknowledgment deadline', async () => {
        vi.useFakeTimers();
        const watchdog = createPluginReactNativeWatchdog({});
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
                loadTimeoutMs={100}
                watchdog={watchdog}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
            />);
            await flushHookEffects({ cycles: 1, turns: 2 });

            expect(load).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();

            await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 100 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
            expect(watchdog.readPending({ token: crashStateToken, scopeKey: crashReportScopeKey })).toEqual([]);
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
                loadTimeoutMs={1000}
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
                loadTimeoutMs={1000}
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
                loadTimeoutMs={1000}
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
                loadTimeoutMs={1000}
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

    it('does not let an installed module cache suppress a dev-hot-reload fetch', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('./moduleRegistry');
        const cacheKey = 'cache_dev_hot_reload_always_refetches';
        const registry = getInstalledPluginReactNativeModuleRegistry();
        const load = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-dev-loader-module',
            }),
        }));
        registry.reconcileActiveCacheKeys([cacheKey]);
        const writeFence = registry.captureWriteFence(cacheKey);
        expect(writeFence).not.toBeNull();
        expect(registry.write(cacheKey, {
            renderSurface: () => React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-stale-installed-module',
            }),
        }, writeFence!)).toBe(true);

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={load}
                loadPolicy={{
                    source: 'devHotReload',
                    devUrl: 'http://127.0.0.1:8082/index.bundle',
                }}
                cacheKey={cacheKey}
                loadTimeoutMs={1000}
                            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(load).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-dev-loader-module')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-stale-installed-module')).toBeNull();
        } finally {
            registry.reconcileActiveCacheKeys([]);
        }
    });

    it('does not carry a dev-hot-reload module into an installed-artifact source with the same key', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('./moduleRegistry');
        const cacheKey = 'cache_same_key_source_transition';
        const registry = getInstalledPluginReactNativeModuleRegistry();
        const loadDevModule = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-dev-module',
            }),
        }));
        const loadInstalledModule = vi.fn(async () => ({
            renderSurface: () => React.createElement('PluginNativeSurface', {
                testID: 'plugin-native-installed-module',
            }),
        }));
        const element = (input: Readonly<{
            load: () => Promise<PluginReactNativeSurfaceModule>;
            loadPolicy: NonNullable<React.ComponentProps<typeof PluginReactNativeSurface>['loadPolicy']>;
        }>) => (
            <PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                load={input.load}
                loadPolicy={input.loadPolicy}
                cacheKey={cacheKey}
                loadTimeoutMs={1000}
                            />
        );

        try {
            const screen = await renderScreen(element({
                load: loadDevModule,
                loadPolicy: {
                    source: 'devHotReload',
                    devUrl: 'http://127.0.0.1:8082/index.bundle',
                },
            }));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(loadDevModule).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-dev-module')).toBeTruthy();

            await screen.update(element({
                load: loadInstalledModule,
                loadPolicy: { source: 'installedArtifact' },
            }));
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(loadInstalledModule).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-installed-module')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-dev-module')).toBeNull();
        } finally {
            registry.reconcileActiveCacheKeys([]);
        }
    });

    it('persists a direct render error and contains it until daemon reconciliation', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac13',
        });
        const reportFailure = vi.fn(async () => ({ ok: false as const, reason: 'request_failed' as const }));
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
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
                reportFailure={reportFailure}
                            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
                token: crashStateToken,
                failure: 'render_error',
                failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac13',
            }));
            expect(watchdog.readPending({ token: crashStateToken, scopeKey: crashReportScopeKey })).toHaveLength(1);
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

    it('keeps the targeted caller fallback after a contributor render crash while preserving crash reporting', async () => {
        const watchdog = createPluginReactNativeWatchdog({
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac14',
        });
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
                crashStateToken={targetedCrashStateToken}
                crashReportScopeKey={crashReportScopeKey}
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
            expect(watchdog.readPending({
                token: targetedCrashStateToken,
                scopeKey: crashReportScopeKey,
            })).toHaveLength(1);
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

    it('recovers a quarantined mount when a replacement artifact advances its exact token', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const watchdog = createPluginReactNativeWatchdog({});
        const replacementToken = {
            ...crashStateToken,
            artifactDigest: `sha256:${'b'.repeat(64)}`,
        } as const;
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
                cacheKey="cache_stable"
                watchdog={watchdog}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(watchdog.readPending({ token: crashStateToken, scopeKey: crashReportScopeKey })).toHaveLength(1);

            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{
                    renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-recovered' }),
                }}
                cacheKey="cache_stable"
                watchdog={watchdog}
                crashStateToken={replacementToken}
                crashReportScopeKey={crashReportScopeKey}
            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-native-recovered')).toBeTruthy();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps a failed same-digest mount contained until reset advances its exact token epoch', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const watchdog = createPluginReactNativeWatchdog({});
        const resetToken = {
            ...crashStateToken,
            crashStateEpoch: crashStateToken.crashStateEpoch + 1,
        } as const;
        const brokenModule = {
            renderSurface: () => {
                throw new Error('plugin render failure');
            },
        };
        const recoveredModule = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-reset-recovered' }),
        };
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={brokenModule}
                cacheKey="cache_stable"
                watchdog={watchdog}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={recoveredModule}
                cacheKey="cache_stable"
                watchdog={watchdog}
                crashStateToken={crashStateToken}
                crashReportScopeKey={crashReportScopeKey}
            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-native-reset-recovered')).toBeNull();

            await screen.update(<PluginReactNativeSurface
                surfaceId="surface_1"
                renderContext={defaultRenderContext}
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={recoveredModule}
                cacheKey="cache_stable"
                watchdog={watchdog}
                crashStateToken={resetToken}
                crashReportScopeKey={crashReportScopeKey}
            />);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-native-reset-recovered')).toBeTruthy();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('does not quarantine a replacement artifact for an old pending failure', async () => {
        const watchdog = createPluginReactNativeWatchdog({});
        watchdog.recordFailure({
            token: crashStateToken,
            scopeKey: crashReportScopeKey,
            failure: 'render_error',
        });
        const replacementToken = {
            ...crashStateToken,
            artifactDigest: `sha256:${'b'.repeat(64)}`,
        } as const;
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            renderContext={defaultRenderContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{ renderSurface }}
            watchdog={watchdog}
            crashStateToken={replacementToken}
            crashReportScopeKey={crashReportScopeKey}
                    />);
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(renderSurface).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
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
            renderContext={defaultRenderContext}
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
                renderContext={defaultRenderContext}
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
