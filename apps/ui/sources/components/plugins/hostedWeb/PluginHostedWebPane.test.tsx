import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { PluginUiLaunchInputV1, PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginSurfaceTarget, SurfaceContext } from '@happier-dev/plugin-sdk/ui';

import { renderScreen } from '@/dev/testkit';
import { createPluginSurfaceMountLifetimeFixture } from '@/dev/testkit/fixtures/pluginSurfaceMountLifetimeFixture';
import { createTestMessageChannel } from '@/dev/testkit/mocks/messageChannel';

let mountLifetime: ReturnType<typeof createPluginSurfaceMountLifetimeFixture>;
beforeEach(() => { mountLifetime = createPluginSurfaceMountLifetimeFixture(); });
afterEach(() => { mountLifetime.dispose(); });
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Remote source mirrors deliberately omit the generated app-package byte
// inventory. This Pane suite exercises the admitted frame/bridge after that
// source boundary; exact Artifact selection has its own owner tests.
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: vi.fn(async () => null),
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(() => null),
    createPluginAccountAvailabilityReaderStore: vi.fn(() => ({
        get: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
    })),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(() => null),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
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

/**
 * The mount's surface identity, exactly as the bound controller produces it
 * (§3.1). The pane takes ONE identity now — it no longer rebuilds a second one
 * from the renderer contribution beside the controller's.
 */
const surfaceContext: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const sessionSurfaceContext: PluginUiSurfaceContextV1 = {
    ...surfaceContext,
    sessionId: 'session-1',
};

const browserSurfaceContext: PluginUiSurfaceContextV1 = {
    ...sessionSurfaceContext,
    placement: 'browserSurface',
};

// These fixtures carry the exact public context that a destination host gives
// a hosted-web surface. Keep the host-api tests on the real mount/snapshot
// contract rather than preserving the retired placement field behind casts.
const canonicalMount = {
    kind: 'destination',
    destination: { pluginId: 'acme.preview', localId: 'preview-web' },
    container: 'rightPane',
} satisfies SurfaceContext['mount'];

const canonicalTargetedContributions = {
    target: {
        pluginId: 'acme.target',
        occurrenceId: 'target-occurrence-1',
        sourceCustody: {
            kind: 'managed',
            immutableGenerationId: 'target-generation-1',
            installSource: 'archive',
        },
    },
    points: [],
} satisfies SurfaceContext['targetedContributions'];

const projection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    translationsByPluginId: {
        'acme.preview': {
            id: 'translations:acme.preview',
            pluginId: 'acme.preview',
            contributionKind: 'translations',
            locales: ['en'],
            bundles: {
                en: {
                    'preview.frame.title': 'Preview panel',
                },
            },
        },
    },
    hostedWebById: {
        'hostedWeb:acme.preview:preview-web': {
            id: 'hostedWeb:acme.preview:preview-web',
            pluginId: 'acme.preview',
            occurrenceId: 'preview-occurrence-1',
            contributionKind: 'hostedWeb',
            contributionId: 'preview-web',
            display: {
                titleKey: 'preview.frame.title',
                developerFallback: 'Preview',
            },
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        },
    },
};

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function findHostedWebIframe(screen: RenderedScreen) {
    const frames = screen.root.findAllByType('iframe');
    expect(frames).toHaveLength(1);
    return frames[0];
}

function readFrameWireIdentity(screen: RenderedScreen) {
    const url = new URL(String(findHostedWebIframe(screen).props.src));
    return {
        instanceId: url.searchParams.get('happierInstanceId')!,
        mountNonce: url.searchParams.get('happierBridgeNonce')!,
    };
}

describe('PluginHostedWebPane', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders unavailable when the preview endpoint has not been projected yet', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            platform="web"
        />);

        const unavailable = screen.findByTestId('plugin-hosted-web-unavailable');
        expect(unavailable).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_preview_unavailable')).toBeTruthy();
        expect(unavailable?.props.role).toBe('status');
        expect(unavailable?.props['aria-live']).toBe('polite');
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebUnavailableTitle');
        expect(screen.getTextContent()).not.toContain('hosted_web_preview_unavailable');
    });

    it('forwards valid intrinsic height only while the exact framed mount remains current', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSources = [
            { postMessage: vi.fn() },
            { postMessage: vi.fn() },
        ] as unknown as WindowProxy[];
        let iframeMounts = 0;
        const previousWindow = (globalThis as { window?: unknown }).window;
        const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
        const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
        let scheduledFrame: FrameRequestCallback | null = null;
        let current = true;
        const onIntrinsicHeightChange = vi.fn();
        globalThis.requestAnimationFrame = (callback) => {
            scheduledFrame = callback;
            return 1;
        };
        globalThis.cancelAnimationFrame = () => {
            scheduledFrame = null;
        };
        (globalThis as { window?: unknown }).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        const heightProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['heightChanged'] },
                },
            },
        };

        try {
            const element = (mountInstanceKey: string) => (
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={heightProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    mountInstanceKey={mountInstanceKey}
                    isCurrent={() => current}
                    onIntrinsicHeightChange={onIntrinsicHeightChange}
                />
            );
            const screen = await renderScreen(
                element('mount-one'),
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSources[iframeMounts++] }
                            : null
                    ),
                },
            );
            const firstSource = iframeSources[0]!;
            const firstIdentity = readFrameWireIdentity(screen);
            const dispatchHeight = async (
                source: WindowProxy,
                identity: ReturnType<typeof readFrameWireIdentity>,
                height: number,
            ) => {
                await act(async () => {
                    (globalThis as { window: { dispatchEvent: (event: MessageEvent) => void } }).window.dispatchEvent({
                        origin: 'https://preview.happier.test',
                        data: {
                            version: 1,
                            identity,
                            sequence: height,
                            kind: 'heightChanged',
                            payload: { height },
                        },
                        source,
                    } as MessageEvent);
                });
            };
            const flushHeight = async () => {
                await act(async () => {
                    const frame = scheduledFrame;
                    scheduledFrame = null;
                    frame?.(0);
                });
            };

            await dispatchHeight(firstSource, firstIdentity, 320);
            await flushHeight();
            expect(onIntrinsicHeightChange).toHaveBeenCalledExactlyOnceWith(320);

            // A report accepted by the old bridge but not yet painted belongs
            // to that exact physical mount. Replacing the mount retires the
            // shared reporter and cancels its pending publication.
            await dispatchHeight(firstSource, firstIdentity, 410);
            await screen.update(element('mount-two'));
            await flushHeight();
            expect(iframeMounts).toBe(2);
            const secondSource = iframeSources[1]!;
            const secondIdentity = readFrameWireIdentity(screen);
            expect(onIntrinsicHeightChange).toHaveBeenCalledTimes(1);

            await dispatchHeight(firstSource, firstIdentity, 440);
            await flushHeight();
            expect(onIntrinsicHeightChange).toHaveBeenCalledTimes(1);

            await dispatchHeight(secondSource, secondIdentity, 480);
            await flushHeight();
            expect(onIntrinsicHeightChange).toHaveBeenLastCalledWith(480);

            current = false;
            await dispatchHeight(secondSource, secondIdentity, 500);
            await flushHeight();
            expect(onIntrinsicHeightChange).toHaveBeenCalledTimes(2);
        } finally {
            (globalThis as { window?: unknown }).window = previousWindow;
            globalThis.requestAnimationFrame = previousRequestAnimationFrame;
            globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
        }
    });

    it('preserves the targeted fallback for a pre-frame Artifact acquisition failure', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            platform="web"
            unavailableDiagnosticCode="transport_unavailable"
            targetedFallback={React.createElement('TargetedHostedFallback', {
                testID: 'targeted-hosted-acquisition-fallback',
            })}
        />);

        expect(screen.findByTestId('targeted-hosted-acquisition-fallback')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
    });

    it('offers a mount-local retry for an ordinary pre-frame Artifact acquisition failure', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const onRetry = vi.fn();
        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            platform="web"
            unavailableDiagnosticCode="transport_unavailable"
            onUnavailableRetry={onRetry}
        />);

        await act(async () => {
            screen.pressByTestId('plugin-hosted-web-unavailable-action');
        });
        expect(onRetry).toHaveBeenCalledExactlyOnceWith();
    });

    it('fails closed when a bound mount supplies a null selected hosted-web renderer', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            projectedContribution={null}
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it.each(['web', 'desktop', 'ios', 'android'] as const)(
        'publishes the packaged-frame adapter unavailability diagnostic on %s instead of advertising a frame',
        async (platform) => {
            const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
            const packagedStaticAssetProjection: PluginUiProjectionModel = {
                ...projection,
                hostedWebById: {
                    ...projection.hostedWebById,
                    'hostedWeb:acme.preview:preview-web': {
                        ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                        service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                        runtime: {
                            state: 'fallback',
                            diagnostics: ['hosted_web_frame_adapter_unavailable'],
                            decision: {
                                state: 'fallback',
                                reason: 'hosted_web_frame_adapter_unavailable',
                                diagnostics: ['hosted_web_frame_adapter_unavailable'],
                            },
                        },
                    },
                },
            };

            const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={{ ...surfaceContext, platform }}
                pluginUiProjection={packagedStaticAssetProjection}
                platform={platform}
            />);

            expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_frame_adapter_unavailable')).toBeTruthy();
            expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
        },
    );

    it('reports a missing Artifact endpoint without rewriting an admitted browser frame as unavailable', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const projectedBrowserArtifact: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projectedBrowserArtifact}
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_preview_unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it.each([
        'e2ee_unavailable',
        'transport_unavailable',
        'feature_disabled',
        'hosted_web_static_artifact_missing',
        'hosted_web_frame_adapter_unavailable',
    ] as const)('preserves the bounded %s hosted-web reason through the safe state card', async (reason) => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const unavailableProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    runtime: {
                        state: 'fallback',
                        diagnostics: [reason],
                        decision: {
                            state: 'fallback',
                            reason,
                            diagnostics: [reason],
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={unavailableProjection}
            platform="web"
        />);

        expect(screen.findByTestId(`plugin-hosted-web-unavailable-diagnostic-${reason}`)).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('keeps an issuer diagnostic authoritative when a local guard also refuses the frame', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const { sandbox: _sandbox, ...descriptorWithoutSandbox } = projection.hostedWebById['hostedWeb:acme.preview:preview-web'];
        const missingSandboxProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': descriptorWithoutSandbox,
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={missingSandboxProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
            unavailableDiagnosticCode="e2ee_unavailable"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-e2ee_unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_sandbox_unavailable')).toBeNull();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('uses an exact projected daemon endpoint even when packaged-frame admission is unavailable', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const daemonPreviewProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        decision: {
                            state: 'fallback',
                            reason: 'hosted_web_frame_adapter_unavailable',
                            diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={daemonPreviewProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
    });

    it('does not let a bypassed packaged-frame fallback hide a later local security refusal', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const { security: _security, ...descriptorWithoutSecurity } = projection.hostedWebById['hostedWeb:acme.preview:preview-web'];
        const daemonPreviewProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...descriptorWithoutSecurity,
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        decision: {
                            state: 'fallback',
                            reason: 'hosted_web_frame_adapter_unavailable',
                            diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={daemonPreviewProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_security_unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_frame_adapter_unavailable')).toBeNull();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('keeps a browser Artifact capability frame opaque without exposing its Session in the guest URL', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const artifactProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        decision: {
                            state: 'fallback',
                            reason: 'hosted_web_frame_adapter_unavailable',
                            diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        },
                    },
                },
            },
        };
        try {
            const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={artifactProjection}
                endpointUrl="https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/"
                opaqueArtifactFrame
                platform="web"
                onBridgeMessage={() => undefined}
            />);

            const frame = findHostedWebIframe(screen);
            const frameUrl = new URL(String(frame.props.src));
            expect(frameUrl.searchParams.get('happierSessionId')).toBeNull();
            expect(frameUrl.searchParams.get('happierHostOrigin')).toBe('https://host.happier.test');
            expect(frameUrl.toString()).not.toContain('session-1');
            expect(frame.props.sandbox).toBe('allow-scripts');
            expect(frame.props.csp).toBeUndefined();
        } finally {
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });

    it('fails closed when projection runtime policy does not make hosted-web executable', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const disabledProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['feature_disabled'],
                        decision: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['feature_disabled'],
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={disabledProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('publishes a policy category when the canonical projection policy refuses the pane', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const policyRefusalProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    availability: {
                        state: 'available', reason: 'available', diagnostics: [],
                        when: { fact: 'host.feature', operator: 'enabled', value: 'preview-hosting' },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={policyRefusalProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_policy_denied')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebPolicyDenied');
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('renders the host frame only for preview-policy-accepted URLs', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        const frame = findHostedWebIframe(screen);
        expect(frame).toBeTruthy();
        expect(frame?.props.src).toContain('https://preview.happier.test/plugin/acme/');
        expect(frame?.props.src).toContain('happierBridgeNonce=');
        // A secure endpoint gets the addressable origin the bridge needs and
        // nothing more (EU-8).
        expect(frame?.props.sandbox).toBe('allow-scripts allow-same-origin');
        expect(frame?.props.referrerPolicy).toBe('no-referrer');
        expect(frame?.props.title).toBe('Preview panel');
    });

    it('renders only when a hosted-web security policy is present and valid', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const policyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    sandbox: { scripts: true, sameOrigin: true },
                    security: {
                        allowedCallbackOrigins: ['https://oauth.example.test'],
                        csp: {
                            connectSrc: 'selfOnly',
                            allowEval: false,
                        },
                        mixedContent: 'deny',
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={policyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        const frame = findHostedWebIframe(screen);
        expect(frame).toBeTruthy();
        expect(frame?.props.referrerPolicy).toBe('no-referrer');
        expect(frame?.props.sandbox).toContain('allow-same-origin');
    });

    it('fails closed when session hosted-web endpoints request unenforceable CSP widening', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const sessionEndpointProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    service: { kind: 'sessionEndpoint', endpointIdPath: '/preview/id' },
                    security: {
                        allowedConnectOrigins: ['https://api.example.test'],
                        csp: {
                            connectSrc: 'declaredOrigins',
                            allowEval: false,
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={sessionEndpointProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_security_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebSecurityUnavailable');
    });

    it('presents a missing sandbox policy with its own recovery guidance while retaining its bounded diagnostic', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const { sandbox: _sandbox, ...descriptorWithoutSandbox } = projection.hostedWebById['hostedWeb:acme.preview:preview-web'];
        const missingSandboxProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': descriptorWithoutSandbox,
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={missingSandboxProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_sandbox_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebSandboxUnavailable');
        expect(screen.getTextContent()).not.toContain('hosted_web_sandbox_unavailable');
    });

    it('forwards only nonce-bound hosted web bridge messages from the expected origin', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const onBridgeMessage = vi.fn();
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={projection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    {...({
                        onBridgeMessage,
                    } as any)}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );

            const frame = findHostedWebIframe(screen);
            expect(readFrameWireIdentity(screen).mountNonce).toBeTruthy();

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://evil.example.test',
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });

            expect(onBridgeMessage).toHaveBeenCalledTimes(1);
            expect(onBridgeMessage).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'ready',
                identity: readFrameWireIdentity(screen),
            }));
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('uses the secure platform random source for bridge identity without Math.random', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
            throw new Error('Math.random must not be used for bridge nonce generation');
        });
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockReturnValueOnce('secure-instance').mockReturnValueOnce('secure-mount-nonce');
        onTestFinished(() => { platformRandom.mockRestore(); });

        try {
            const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                onBridgeMessage={() => undefined}
            />);

            const frame = findHostedWebIframe(screen);
            expect(frame?.props.src).toContain('happierBridgeNonce=secure-mount-nonce');
            expect(frame?.props.src).toContain('happierInstanceId=secure-instance');
            expect(randomSpy).not.toHaveBeenCalled();
        } finally {
            randomSpy.mockRestore();
            if (previousCrypto) {
                Object.defineProperty(globalThis, 'crypto', previousCrypto);
            } else {
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }
    });

    it('presents a missing bridge nonce with its own recovery guidance while retaining its bounded diagnostic', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(() => { throw new Error('Secure random source unavailable'); });
        onTestFinished(() => { platformRandom.mockRestore(); });
        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
            onBridgeMessage={() => undefined}
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_bridge_nonce_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebBridgeNonceUnavailable');
        expect(screen.getTextContent()).not.toContain('hosted_web_bridge_nonce_unavailable');
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('keeps bridge authority across aggregate projection changes and rotates it when the renderer occurrence changes', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('instance-generation-one')
            .mockReturnValueOnce('generation-one')
            .mockReturnValueOnce('instance-generation-two')
            .mockReturnValueOnce('generation-two');
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(randomUUID);
        onTestFinished(() => { platformRandom.mockRestore(); });
        const element = (generation: number, occurrenceId: string) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={{
                    ...projection,
                    generation,
                    hostedWebById: {
                        ...projection.hostedWebById,
                        'hostedWeb:acme.preview:preview-web': {
                            ...projection.hostedWebById['hostedWeb:acme.preview:preview-web']!,
                            occurrenceId,
                        },
                    },
                }}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                onBridgeMessage={() => undefined}
            />
        );

        try {
            const screen = await renderScreen(element(1, 'preview-occurrence-1'));
            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=generation-one');

            await screen.update(element(2, 'preview-occurrence-1'));

            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=generation-one');
            expect(randomUUID).toHaveBeenCalledTimes(2);

            await screen.update(element(3, 'preview-occurrence-2'));

            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=generation-two');
            expect(randomUUID).toHaveBeenCalledTimes(4);
        } finally {
            if (previousCrypto) {
                Object.defineProperty(globalThis, 'crypto', previousCrypto);
            } else {
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }
    });

    it('rotates bridge authority when a renewed Artifact capability replaces the guest URL', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('instance-capability-one')
            .mockReturnValueOnce('capability-one')
            .mockReturnValueOnce('instance-capability-two')
            .mockReturnValueOnce('capability-two');
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(randomUUID);
        onTestFinished(() => { platformRandom.mockRestore(); });
        const element = (capability: string) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                endpointUrl={`https://artifacts.happier.test/browser/${capability}/`}
                platform="web"
                onBridgeMessage={() => undefined}
            />
        );

        try {
            const screen = await renderScreen(element('first'));
            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=capability-one');

            await screen.update(element('second'));

            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=capability-two');
            expect(randomUUID).toHaveBeenCalledTimes(4);
        } finally {
            if (previousCrypto) {
                Object.defineProperty(globalThis, 'crypto', previousCrypto);
            } else {
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }
    });

    it('rotates bridge authority when the canonical Account lifetime is replaced', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('instance-account-lifetime-one')
            .mockReturnValueOnce('account-lifetime-one')
            .mockReturnValueOnce('instance-account-lifetime-two')
            .mockReturnValueOnce('account-lifetime-two');
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(randomUUID);
        onTestFinished(() => { platformRandom.mockRestore(); });
        const element = () => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                onBridgeMessage={() => undefined}
            />
        );

        try {
            const screen = await renderScreen(element());
            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=account-lifetime-one');

            mountLifetime.retire();
            mountLifetime = createPluginSurfaceMountLifetimeFixture('account-b');
            await screen.update(element());

            expect(findHostedWebIframe(screen).props.src)
                .toContain('happierBridgeNonce=account-lifetime-two');
        } finally {
            if (previousCrypto) {
                Object.defineProperty(globalThis, 'crypto', previousCrypto);
            } else {
                delete (globalThis as { crypto?: unknown }).crypto;
            }
        }
    });

    it('does not restart hosted-web readiness authority when only the aggregate projection generation changes', async () => {
        vi.useFakeTimers();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const hostApi = {
            platform: 'web' as const,
            channel: 'internal' as const,
            handleRequest: vi.fn(async () => null),
        };
        const element = (generation: number) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={{ ...projection, generation }}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                hostApi={hostApi}
                readyTimeoutMs={10}
            />
        );

        const screen = await renderScreen(element(1));
        await act(async () => {
            findHostedWebIframe(screen).props.onLoad?.();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(6);
        });

        await screen.update(element(2));
        await act(async () => {
            findHostedWebIframe(screen).props.onLoad?.();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5);
        });

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('does not admit a predecessor direct host-method bridge envelope', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };

        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const handleRequest = vi.fn(async () => ({ state: 'available', title: 'Preview' }));

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={browserSurfaceContext}
                    pluginUiProjection={bridgeProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    hostApi={{
                        platform: 'web',
                        channel: 'internal',
                        handleRequest,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 2,
                        kind: 'readResource',
                        payload: { resource: { kind: 'session' } },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });

            expect(iframeSource.postMessage).not.toHaveBeenCalled();
            expect(handleRequest).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('keeps the hosted snapshot mounted while host API interaction reconnects', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const handleRequest = vi.fn(async () => ({ state: 'available' }));
        const hostApi: NonNullable<React.ComponentProps<typeof PluginHostedWebPane>['hostApi']> = {
            platform: 'web',
            channel: 'internal',
            handleRequest,
        };
        const element = (interactionEnabled: boolean) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                hostApi={hostApi}
                interactionEnabled={interactionEnabled}
            />
        );

        try {
            const screen = await renderScreen(element(false), {
                createNodeMock: (node) => (
                    (node as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            });
            const offlineIdentity = readFrameWireIdentity(screen);
            expect(offlineIdentity.mountNonce).toBeTruthy();
            const offlineBoundary = screen.findByTestId(
                'plugin-surface-snapshot:sessionSurface:acme.preview:preview-pane',
            );
            expect(offlineBoundary?.props).toMatchObject({
                inert: true,
                'aria-hidden': true,
            });
            expect(offlineBoundary?.props.style).toMatchObject({ pointerEvents: 'none' });
            expect(screen.findByTestId(
                'plugin-surface-offline-summary:sessionSurface:acme.preview:preview-pane',
            )?.props.role).toBe('status');
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

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 3,
                        kind: 'readResource',
                        payload: { resource: { kind: 'session' } },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });
            expect(iframeSource.postMessage).not.toHaveBeenCalled();
            expect(handleRequest).not.toHaveBeenCalled();

            await screen.update(element(true));
            const reconnectedBoundary = screen.findByTestId(
                'plugin-surface-snapshot:sessionSurface:acme.preview:preview-pane',
            );
            expect(reconnectedBoundary?.props.inert).toBe(false);
            expect(reconnectedBoundary?.props['aria-hidden']).toBe(false);
            expect(reconnectedBoundary?.props.style).toMatchObject({ pointerEvents: 'auto' });
            expect(screen.findByTestId(
                'plugin-surface-offline-summary:sessionSurface:acme.preview:preview-pane',
            )).toBeNull();
            expect(readFrameWireIdentity(screen)).toEqual(offlineIdentity);
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 4,
                        kind: 'readResource',
                        payload: { resource: { kind: 'session' } },
                    },
                    source: iframeSource,
                } as MessageEvent);
            });
            expect(handleRequest).not.toHaveBeenCalled();
            expect(iframeSource.postMessage).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it.each(['url', 'inlineHtml'] as const)('falls back when %s bridge ready is not received before the host timeout', async (sourceKind) => {
        vi.useFakeTimers();
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://app.happier.test' },
        });
        onTestFinished(() => {
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        });
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const handleRequest = vi.fn();
        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            {...(sourceKind === 'inlineHtml' ? {
                inlineDocument: { kind: 'html' as const, html: '<p>No SDK</p>' },
                projectedContribution: null,
            } : {})}
            platform="web"
            hostApi={{
                platform: 'web',
                channel: 'internal',
                handleRequest,
            }}
            readyTimeoutMs={5}
        />);

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();

        await act(async () => {
            findHostedWebIframe(screen).props.onLoad?.();
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5);
        });

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_bridge_timeout')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebBridgeTimeout');
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('keeps the targeted caller fallback when hosted-web bridge readiness times out', async () => {
        vi.useFakeTimers();
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
            hostApi={{
                platform: 'web',
                channel: 'internal',
                handleRequest: vi.fn(),
            }}
            readyTimeoutMs={5}
            targetedFallback={React.createElement('TargetedHostedFallback', {
                testID: 'targeted-hosted-ready-timeout-fallback',
            })}
        />);

        await act(async () => {
            findHostedWebIframe(screen).props.onLoad?.();
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5);
        });

        expect(screen.findByTestId('targeted-hosted-ready-timeout-fallback')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('presents an origin-less URL implementation with its own recovery guidance while retaining its bounded diagnostic', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousUrl = globalThis.URL;
        class OriginlessHttpsUrl {
            readonly protocol = 'https:';
            readonly origin = '';

            constructor(_input: string) {
                // This platform-boundary fixture models a URL implementation that cannot
                // supply an addressable frame origin; the pane must fail closed before use.
            }
        }
        Object.defineProperty(globalThis, 'URL', {
            configurable: true,
            value: OriginlessHttpsUrl,
        });
        try {
            const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
            />);

            expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_frame_origin_unavailable')).toBeTruthy();
            expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebFrameOriginUnavailable');
            expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
        } finally {
            Object.defineProperty(globalThis, 'URL', {
                configurable: true,
                value: previousUrl,
            });
        }
    });

    it('gives the guest an addressable origin regardless of the declared route mode (EU-8)', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const pathFallbackProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    entry: { routeMode: 'pathFallback', path: '/' },
                    sandbox: { scripts: true, sameOrigin: true },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={pathFallbackProjection}
            endpointUrl="https://app.happier.test/v1/local-services/preview/preview_1/"
            platform="web"
        />);

        // REPLACED ORACLE (EU-8). This asserted `not.toContain('allow-same-origin')`
        // for a `pathFallback` endpoint, which locked in an OPAQUE guest origin —
        // and an opaque origin silently breaks BOTH bridge directions in a real
        // browser (the guest posts from `origin: "null"`, and the host cannot
        // address an exact `targetOrigin` back). It could only look correct
        // because every unit test on this path fabricates `event.origin`.
        // The former browser-script citation was retired: it exercised a
        // Session preview substitute rather than this hosted frame, so this
        // test makes no Chromium-execution claim.
        const frame = findHostedWebIframe(screen);
        expect(frame).toBeTruthy();
        expect(frame?.props.sandbox).toContain('allow-scripts');
        expect(frame?.props.sandbox).toContain('allow-same-origin');
        // Still clamped: the author's other sandbox requests are unaffected by
        // the transport's origin requirement.
        expect(frame?.props.sandbox).not.toContain('allow-popups');
        expect(frame?.props.sandbox).not.toContain('allow-top-navigation');
    });

    it('does not render daemon loopback endpoints on native clients', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="http://127.0.0.1:5173/"
            platform="ios"
        />);

        expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_endpoint_policy_denied')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.hostedWebEndpointPolicyDenied');
    });

    it('does not render loopback aliases or IPv4-mapped loopback endpoints on native clients', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');

        const ipv4Alias = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="http://127.1.2.3:5173/"
            platform="ios"
        />);
        const mappedIpv6 = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={projection}
            endpointUrl="http://[::ffff:127.0.0.1]:5173/"
            platform="android"
        />);

        expect(ipv4Alias.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(mappedIpv6.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(ipv4Alias.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_endpoint_policy_denied')).toBeTruthy();
        expect(mappedIpv6.findByTestId('plugin-hosted-web-unavailable-diagnostic-hosted_web_endpoint_policy_denied')).toBeTruthy();
    });

    describe('native dev-loopback relaxation (RN-WEB-LOADER item 6)', () => {
        type DevGlobal = typeof globalThis & { __DEV__?: boolean };

        function stubDevBuild(enabled: boolean): () => void {
            const devGlobal = globalThis as DevGlobal;
            const hadOwnDevFlag = Object.prototype.hasOwnProperty.call(devGlobal, '__DEV__');
            const previousDevFlag = devGlobal.__DEV__;
            vi.stubGlobal('__DEV__', enabled);
            return () => {
                if (hadOwnDevFlag) {
                    vi.stubGlobal('__DEV__', previousDevFlag);
                } else {
                    Reflect.deleteProperty(devGlobal, '__DEV__');
                }
            };
        }

        const devLoopbackProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    security: { mixedContent: 'devLoopbackOnly' },
                },
            },
        };

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('still blocks a devLoopbackOnly + development-channel endpoint on native in a PRODUCTION build (fail-closed default unchanged)', async () => {
            const restore = stubDevBuild(false);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={devLoopbackProjection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'development', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('still blocks a devLoopbackOnly endpoint on native in a dev build when the channel is NOT development', async () => {
            const restore = stubDevBuild(true);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={devLoopbackProjection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'internal', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('still blocks a development-channel loopback endpoint on native in a dev build when security does NOT declare devLoopbackOnly', async () => {
            const restore = stubDevBuild(true);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'development', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('renders a devLoopbackOnly + development-channel loopback endpoint on native ONLY in a dev build (all three conditions hold)', async () => {
            const restore = stubDevBuild(true);
            try {
                const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
                const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={devLoopbackProjection}
                    endpointUrl="http://127.0.0.1:5173/"
                    platform="ios"
                    hostApi={{ platform: 'ios', channel: 'development', handleRequest: async () => null }}
                />);
                expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
            } finally {
                restore();
            }
        });

        it('leaves production HTTPS-served hostedWeb endpoints unaffected on native (Q2: not a gap)', async () => {
            const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
            const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={surfaceContext}
                pluginUiProjection={projection}
                endpointUrl="https://plugin.example.test/"
                platform="ios"
            />);
            expect(screen.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
            expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        });
    });

    it('renders a platform-compatible hosted-web projection and hides incompatible platforms', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const policyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    availability: {
                        state: 'available', reason: 'available', diagnostics: [],
                        when: { fact: 'host.platform', operator: 'equals', value: 'web' },
                    },
                },
            },
        };

        const screen = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={policyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);
        const native = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={policyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="ios"
        />);

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        expect(native.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });

    it('fails closed when hosted-web security policy is absent or malformed', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const missingPolicyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    security: undefined,
                },
            },
        };
        const malformedPolicyProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    security: {
                        allowedConnectOrigins: ['https://preview.happier.test/*'],
                    },
                },
            },
        };

        const missing = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={missingPolicyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);
        const malformed = await renderScreen(<PluginHostedWebPane mountLifetime={mountLifetime}
            contributionId="hostedWeb:acme.preview:preview-web"
            surfaceContext={surfaceContext}
            pluginUiProjection={malformedPolicyProjection}
            endpointUrl="https://preview.happier.test/plugin/acme/"
            platform="web"
        />);

        expect(missing.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(malformed.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
    });
    it('pushes a host context update into the real frame over the canonical wire (EU-8)', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });

        const canonicalProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;
        const canonicalHostApi = {
            authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
            mount: canonicalMount,
            methods: ['context'] as const,
            target: { kind: 'session', sessionId: 'session-1' },
            accountEncryptionMode: 'e2ee' as const,
            translations: { 'preview.title': 'Preview' },
            targetedContributions: canonicalTargetedContributions,
        } as const;

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={canonicalProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                    canonicalHostApi={canonicalHostApi}
                    focusEligible
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );

            const guestEnvelope = (
                sequence: number,
                kind: 'ready' | 'hostApi',
                payload: unknown,
            ) => ({
                origin: 'https://preview.happier.test',
                source: iframeSource,
                data: {
                    version: 1,
                    identity: readFrameWireIdentity(screen),
                    sequence,
                    kind,
                    payload,
                },
            } as unknown as MessageEvent);

            await act(async () => {
                (globalThis as any).window.dispatchEvent(guestEnvelope(1, 'ready', { ready: true }));
            });
            const negotiated = iframeSource.postMessage as unknown as ReturnType<typeof vi.fn>;
            expect(negotiated).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'bootstrap',
                identity: readFrameWireIdentity(screen),
            }), 'https://preview.happier.test');
            negotiated.mockClear();

            await act(async () => {
                (globalThis as any).window.dispatchEvent(guestEnvelope(2, 'hostApi', {
                    wireVersion: 1,
                    kind: 'negotiate',
                    identity: readFrameWireIdentity(screen),
                    apiRange: '^1.0.0',
                }));
            });
            await act(async () => {
                (globalThis as any).window.dispatchEvent(guestEnvelope(3, 'hostApi', {
                    wireVersion: 1,
                    kind: 'subscribe',
                    identity: readFrameWireIdentity(screen),
                    requestId: 'request-1',
                    subscriptionId: 'subscription-1',
                    method: 'watchContext',
                }));
            });

            expect(negotiated.mock.calls[0]?.[0]).toMatchObject({
                kind: 'result',
                payload: { kind: 'negotiated', methods: expect.arrayContaining(['watchContext']) },
            });
            negotiated.mockClear();

            // A change to the mount's own facts must reach the frame as a push.
            await screen.update(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={canonicalProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                    canonicalHostApi={{
                        ...canonicalHostApi,
                        translations: { 'preview.title': 'Aper\u00e7u' },
                    }}
                    focusEligible={false}
                />,
            );

            const pushes = negotiated.mock.calls.filter(
                (call) => (call[0] as { direction?: string }).direction === 'hostToFrame',
            );
            expect(pushes).toHaveLength(1);
            expect(pushes[0]?.[0]).toMatchObject({
                direction: 'hostToFrame',
                kind: 'hostApi',
                identity: readFrameWireIdentity(screen),
                payload: {
                    kind: 'subscription',
                    subscriptionId: 'subscription-1',
                    event: {
                        surface: { translations: { 'preview.title': 'Aper\u00e7u' } },
                        activity: { active: false },
                    },
                },
            });
            // Exact origin, never a wildcard: a wildcard would hand host facts
            // to whatever document occupies the frame after a navigation.
            expect(pushes[0]?.[1]).toBe('https://preview.happier.test');

            // A theme/locale-style context refresh preserves a live guest
            // subscription, but a different exact target is a new bound surface
            // lifetime. It must not be delivered as another context push through
            // the old bridge — that would let the prior target keep its host API.
            negotiated.mockClear();
            await screen.update(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={canonicalProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                    canonicalHostApi={{
                        ...canonicalHostApi,
                        target: {
                            kind: 'browser',
                            targetId: 'browser-target-replacement',
                            origin: 'https://replacement.example.test',
                        },
                    }}
                />,
            );
            const targetReplacementPushes = negotiated.mock.calls.filter(
                (call) => (call[0] as { direction?: string }).direction === 'hostToFrame',
            );
            expect(targetReplacementPushes).toHaveLength(1);
            expect(targetReplacementPushes[0]).toEqual([
                expect.objectContaining({
                    direction: 'hostToFrame',
                    kind: 'hostApi',
                    payload: expect.objectContaining({
                        kind: 'disconnected',
                        reason: 'host_api_handler_disposed',
                    }),
                }),
                'https://preview.happier.test',
            ]);
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });
    it('keeps the canonical frame mounted while its incumbent bridge renegotiates newly installed methods', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSources: Array<{ postMessage: ReturnType<typeof vi.fn> }> = [];
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;
        const renderPane = (methods: readonly ('context' | 'readResource')[]) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                canonicalHostApi={{
                    authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
                    mount: canonicalMount,
                    methods,
                    target: { kind: 'session', sessionId: 'session-1' },
                    accountEncryptionMode: 'e2ee',
                    translations: { 'preview.title': 'Preview' },
                    targetedContributions: canonicalTargetedContributions,
                }}
            />
        );

        try {
            const screen = await renderScreen(renderPane(['context']), {
                createNodeMock: (element) => {
                    if ((element as { type?: string }).type !== 'iframe') return null;
                    const source = { postMessage: vi.fn() };
                    iframeSources.push(source);
                    return { contentWindow: source as unknown as WindowProxy };
                },
            });
            const incumbentSource = iframeSources[0];
            expect(incumbentSource).toBeDefined();

            const guestEnvelope = (sequence: number, payload: unknown) => ({
                origin: 'https://preview.happier.test',
                source: incumbentSource as unknown as WindowProxy,
                data: {
                    version: 1,
                    identity: readFrameWireIdentity(screen),
                    sequence,
                    kind: 'hostApi',
                    payload,
                },
            } as unknown as MessageEvent);
            const readyEnvelope = (sequence: number) => ({
                origin: 'https://preview.happier.test',
                source: incumbentSource as unknown as WindowProxy,
                data: {
                    version: 1,
                    identity: readFrameWireIdentity(screen),
                    sequence,
                    kind: 'ready',
                    payload: { ready: true },
                },
            } as unknown as MessageEvent);

            await act(async () => {
                (globalThis as any).window.dispatchEvent(readyEnvelope(1));
            });
            await act(async () => {
                (globalThis as any).window.dispatchEvent(guestEnvelope(2, {
                    wireVersion: 1,
                    kind: 'negotiate',
                    identity: readFrameWireIdentity(screen),
                    apiRange: '^1.0.0',
                }));
            });
            expect(incumbentSource?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'result',
                payload: expect.objectContaining({
                    kind: 'negotiated',
                    methods: expect.not.arrayContaining(['readResource']),
                }),
            }), 'https://preview.happier.test');
            incumbentSource?.postMessage.mockClear();

            await screen.update(renderPane(['context', 'readResource']));

            // A capability expansion is transport negotiation, not a physical
            // iframe lifetime: guest state and its post-ready bootstrap remain.
            expect(iframeSources).toHaveLength(1);
            await act(async () => {
                (globalThis as any).window.dispatchEvent(guestEnvelope(3, {
                    wireVersion: 1,
                    kind: 'negotiate',
                    identity: readFrameWireIdentity(screen),
                    apiRange: '^1.0.0',
                }));
            });
            expect(incumbentSource?.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'result',
                payload: expect.objectContaining({
                    kind: 'negotiated',
                    methods: expect.arrayContaining(['readResource']),
                }),
            }), 'https://preview.happier.test');
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });
    it('lends the incumbent Composer publication sink only for the mounted bridge lifetime', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const setComposerSubscriptionPublisher = vi.fn();
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;
        const paneProps = {
            contributionId: 'hostedWeb:acme.preview:preview-web',
            surfaceContext: sessionSurfaceContext,
            pluginUiProjection: {
                ...projection,
                hostedWebById: {
                    ...projection.hostedWebById,
                    'hostedWeb:acme.preview:preview-web': {
                        ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                        bridge: { allowedMessages: ['hostApi'] },
                    },
                },
            },
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            platform: 'web' as const,
            hostApi: { platform: 'web' as const, channel: 'internal' as const, handleRequest: async () => null },
            canonicalHostApi: {
                authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
                mount: canonicalMount,
                methods: ['watchComposer'] as const,
                target: { kind: 'session' as const, sessionId: 'session-1' },
                accountEncryptionMode: 'e2ee' as const,
                translations: { 'preview.title': 'Preview' },
                targetedContributions: canonicalTargetedContributions,
            },
            setComposerSubscriptionPublisher,
        };

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime} {...paneProps} />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: { postMessage: vi.fn() } as unknown as WindowProxy }
                            : null
                    ),
                },
            );

            expect(setComposerSubscriptionPublisher).toHaveBeenLastCalledWith(expect.any(Function));

            await screen.unmount();

            expect(setComposerSubscriptionPublisher).toHaveBeenLastCalledWith(undefined);
        } finally {
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });
    it('admits the strict ready lifecycle for a canonical host API bridge and sends bootstrap only after readiness', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={bridgeProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                    canonicalHostApi={{
                        authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
                        mount: canonicalMount,
                        methods: ['context'],
                        target: { kind: 'session', sessionId: 'session-1' },
                        accountEncryptionMode: 'e2ee',
                        translations: { 'preview.title': 'Preview' },
                        targetedContributions: canonicalTargetedContributions,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            expect(iframeSource.postMessage).not.toHaveBeenCalled();
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierSessionId')).toBeNull();

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    source: iframeSource,
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as MessageEvent);
            });

            expect(iframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'bootstrap',
                identity: readFrameWireIdentity(screen),
                payload: expect.objectContaining({ identity: readFrameWireIdentity(screen), authorPlugin: { id: identity.pluginId, version: identity.pluginVersion } }),
            }), 'https://preview.happier.test');
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });

    it('bootstraps the selected B generated V2 Artifact frame from its nonce-bound sessionless ready message', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.review:detail': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    id: 'hostedWeb:acme.review:detail',
                    pluginId: 'acme.review',
                    contributionId: 'detail',
                    generatedV2: true,
                    bridge: { allowedMessages: ['hostApi'] },
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        decision: {
                            state: 'fallback',
                            reason: 'hosted_web_frame_adapter_unavailable',
                            diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        },
                    },
                },
            },
        };
        const identity = {
            pluginId: 'acme.review',
            pluginVersion: '1.2.3',
            viewId: 'detail',
            generation: '1',
            sessionId: 'session-1',
        } as const;

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.review:detail"
                    surfaceContext={{
                        ...sessionSurfaceContext,
                        pluginId: 'acme.review',
                        contributionId: 'detail',
                        surfaceId: 'targeted:review-hosted-42',
                    }}
                    pluginUiProjection={bridgeProjection}
                    endpointUrl="https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/"
                    opaqueArtifactFrame
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                    canonicalHostApi={{
                        authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
                        mount: canonicalMount,
                        methods: ['context'],
                        target: { kind: 'browser', targetId: 'browser-targeted-hosted-77' },
                        accountEncryptionMode: 'plain',
                        translations: {},
                        targetedContributions: {
                            target: {
                                pluginId: 'acme.browser',
                                occurrenceId: 'browser-targeted-hosted-occurrence-77',
                                sourceCustody: {
                                    kind: 'managed',
                                    immutableGenerationId: 'browser-targeted-hosted-generation-77',
                                    installSource: 'archive',
                                },
                            },
                            points: [],
                        },
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierSessionId')).toBeNull();

            // The real opaque guest bootstrap: an opaque document has no
            // addressable origin, so it creates a MessageChannel, keeps one
            // port and TRANSFERS the other with its `ready` envelope. Every
            // host reply and push then rides that document-bound port; the
            // window `message` payload transport this test used to fabricate
            // does not exist on this path.
            const documentChannel = createTestMessageChannel();
            const incumbentIdentity = readFrameWireIdentity(screen);
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'null',
                    source: iframeSource,
                    ports: [documentChannel.port1],
                    data: {
                        version: 1,
                        identity: incumbentIdentity,
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as unknown as MessageEvent);
                await Promise.resolve();
            });

            expect(documentChannel.port1PostMessage).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'bootstrap',
                identity: incumbentIdentity,
                payload: expect.objectContaining({ identity: incumbentIdentity, authorPlugin: { id: identity.pluginId, version: identity.pluginVersion } }),
            }));
            // An opaque frame is never addressed by a window post: doing so
            // would broadcast host facts to whatever document now occupies it.
            expect(iframeSource.postMessage).not.toHaveBeenCalled();

            // A second `ready` without a transferred port cannot rebind the
            // channel, and the incumbent port keeps serving the bound document.
            documentChannel.port1PostMessage.mockClear();
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'null',
                    source: iframeSource,
                    data: {
                        version: 1,
                        identity: incumbentIdentity,
                        sequence: 2,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as MessageEvent);
                documentChannel.port2.postMessage({
                    version: 1,
                    identity: incumbentIdentity,
                    sequence: 3,
                    kind: 'ready',
                    payload: { ready: true },
                });
                await Promise.resolve();
            });
            expect(iframeSource.postMessage).not.toHaveBeenCalled();
            // The bound port stays the one reply channel, and a repeated ready
            // is answered as a duplicate rather than re-bootstrapping the mount.
            expect(documentChannel.port1PostMessage).toHaveBeenCalledWith(expect.objectContaining({
                identity: incumbentIdentity,
                kind: 'ack',
                payload: expect.objectContaining({ readyState: 'duplicate' }),
            }));
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });

    it('retires an opaque Artifact resource bridge before a replacement document can receive host traffic', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const handleRequest = vi.fn(async () => null);
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                    service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        decision: {
                            state: 'fallback',
                            reason: 'hosted_web_frame_adapter_unavailable',
                            diagnostics: ['hosted_web_frame_adapter_unavailable'],
                        },
                    },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={bridgeProjection}
                    endpointUrl="https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/capability/"
                    opaqueArtifactFrame
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest }}
                    canonicalHostApi={{
                        authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
                        mount: canonicalMount,
                        methods: ['watchResource'],
                        target: { kind: 'session', sessionId: 'session-1' },
                        accountEncryptionMode: 'plain',
                        translations: { 'preview.title': 'Preview' },
                        targetedContributions: canonicalTargetedContributions,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            const initialFrame = findHostedWebIframe(screen);
            const incumbentIdentity = readFrameWireIdentity(screen);

            // Real opaque handshake: the guest transfers one document-bound
            // port with `ready`, and every later request rides that port.
            const documentChannel = createTestMessageChannel();
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'null',
                    source: iframeSource,
                    ports: [documentChannel.port1],
                    data: {
                        version: 1,
                        identity: incumbentIdentity,
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as unknown as MessageEvent);
                await Promise.resolve();
            });
            expect(documentChannel.port1PostMessage).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'bootstrap',
                identity: incumbentIdentity,
            }));

            await act(async () => {
                documentChannel.port2.postMessage({
                    version: 1,
                    identity: incumbentIdentity,
                    sequence: 2,
                    kind: 'hostApi',
                    payload: {
                        wireVersion: 1,
                        kind: 'subscribe',
                        identity: incumbentIdentity,
                        requestId: 'watch-resource-request',
                        subscriptionId: 'watch-resource-subscription',
                        method: 'watchResource',
                        payload: { resource: { kind: 'session' } },
                    },
                });
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
                method: 'watchResource',
            })));
            documentChannel.port1PostMessage.mockClear();
            (iframeSource.postMessage as ReturnType<typeof vi.fn>).mockClear();

            await act(async () => {
                initialFrame.props.onLoad?.();
                await Promise.resolve();
            });
            await act(async () => {
                initialFrame.props.onLoad?.();
                await Promise.resolve();
            });

            await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
                method: 'disposeHostResource',
                payload: { subscriptionId: 'watch-resource-subscription' },
            })));
            // The replacement document owns this frame now. The severed sink
            // means the retired guest's port carries no further host traffic,
            // and nothing is broadcast to the window either.
            expect(documentChannel.port1PostMessage).not.toHaveBeenCalled();
            expect(iframeSource.postMessage).not.toHaveBeenCalled();
            expect(screen.root.findAllByType('iframe')).toHaveLength(0);

            // A replacement can never reuse the retired channel: the frame is
            // revoked, so a fresh port from the replacement document is ignored
            // rather than silently rebinding the retired mount.
            const replacementChannel = createTestMessageChannel();
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'null',
                    source: iframeSource,
                    ports: [replacementChannel.port1],
                    data: {
                        version: 1,
                        identity: incumbentIdentity,
                        sequence: 3,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as unknown as MessageEvent);
                await Promise.resolve();
            });
            expect(replacementChannel.port1PostMessage).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });

    it.each([
        { label: 'the ordinary surface remains current until replacement', closeBeforeReplacement: false },
        { label: 'ordinary surface currentness has already closed', closeBeforeReplacement: true },
    ])('delivers canonical disconnect during teardown when $label', async ({ closeBeforeReplacement }) => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        let current = true;
        const isCurrent = () => current;
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;
        const canonicalHostApi = {
            authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
            mount: canonicalMount,
            methods: ['context'] as const,
            target: { kind: 'session', sessionId: 'session-1' },
            accountEncryptionMode: 'e2ee' as const,
            translations: { 'preview.title': 'Preview' },
            targetedContributions: canonicalTargetedContributions,
        } as const;
        const element = (target: PluginSurfaceTarget) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                hostApi={{ platform: 'web', channel: 'internal', handleRequest: async () => null }}
                isCurrent={isCurrent}
                canonicalHostApi={{ ...canonicalHostApi, target }}
            />
        );

        try {
            const screen = await renderScreen(element(canonicalHostApi.target), {
                createNodeMock: (node) => (
                    (node as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            });
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    source: iframeSource,
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as MessageEvent);
            });
            (iframeSource.postMessage as ReturnType<typeof vi.fn>).mockClear();

            // A replacement retires the old exact frame lifetime. Ordinary
            // traffic is stale now, but this one terminal push is what lets the
            // guest abort its Data pager instead of retaining Account-A rows.
            if (closeBeforeReplacement) current = false;
            await screen.update(element({
                kind: 'browser',
                targetId: 'replacement-target',
                origin: 'https://replacement.example.test',
            }));

            expect(iframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'hostApi',
                payload: expect.objectContaining({
                    kind: 'disconnected',
                    reason: 'host_api_handler_disposed',
                }),
            }), 'https://preview.happier.test');
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });

    it('rejects bridge traffic after the bound surface is no longer current without invoking the host', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const handleRequest = vi.fn(async () => null);
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={sessionSurfaceContext}
                    pluginUiProjection={bridgeProjection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    hostApi={{ platform: 'web', channel: 'internal', handleRequest }}
                    isCurrent={() => false}
                    canonicalHostApi={{
                        authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
                        mount: canonicalMount,
                        methods: ['executeAction'],
                        target: { kind: 'session', sessionId: 'session-1' },
                        accountEncryptionMode: 'e2ee',
                        translations: { 'preview.title': 'Preview' },
                        targetedContributions: canonicalTargetedContributions,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );

            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    source: iframeSource,
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'hostApi',
                        payload: {
                            wireVersion: 1,
                            kind: 'request',
                            identity: readFrameWireIdentity(screen),
                            requestId: 'request-1',
                            method: 'executeAction',
                            payload: { action: 'open' },
                        },
                    },
                } as MessageEvent);
            });

            expect(handleRequest).not.toHaveBeenCalled();
            expect(iframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'error',
                payload: { code: 'stale_surface', diagnostics: [] },
            }), 'https://preview.happier.test');
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });

    it('remounts a reopened bound instance with a freshly minted bridge nonce', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('instance-mount-instance-one')
            .mockReturnValueOnce('mount-instance-one')
            .mockReturnValueOnce('instance-mount-instance-two')
            .mockReturnValueOnce('mount-instance-two');
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(randomUUID);
        onTestFinished(() => { platformRandom.mockRestore(); });

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    {...({ mountInstanceKey: 'mount-one' } as any)}
                />,
            );
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierBridgeNonce')).toBe('mount-instance-one');

            await screen.update(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    {...({ mountInstanceKey: 'mount-two' } as any)}
                />,
            );
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierBridgeNonce')).toBe('mount-instance-two');
        } finally {
            if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
            else Reflect.deleteProperty(globalThis, 'crypto');
        }
    });

    it('mints a new bridge nonce when the bound page location changes', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('instance-sub-path-one')
            .mockReturnValueOnce('sub-path-one')
            .mockReturnValueOnce('instance-sub-path-two')
            .mockReturnValueOnce('sub-path-two');
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(randomUUID);
        onTestFinished(() => { platformRandom.mockRestore(); });

        try {
            const screen = await renderScreen(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    {...({ mountInstanceKey: 'mount-one', subPath: 'notes/one' } as any)}
                />,
            );
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierBridgeNonce')).toBe('sub-path-one');

            // The same bound instance navigating to another plugin-local page is a
            // new guest document. A nonce minted for the previous page must not
            // stay valid for the frame that replaces it.
            await screen.update(
                <PluginHostedWebPane mountLifetime={mountLifetime}
                    contributionId="hostedWeb:acme.preview:preview-web"
                    surfaceContext={surfaceContext}
                    pluginUiProjection={projection}
                    endpointUrl="https://preview.happier.test/plugin/acme/"
                    platform="web"
                    {...({ mountInstanceKey: 'mount-one', subPath: 'notes/two' } as any)}
                />,
            );
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierBridgeNonce')).toBe('sub-path-two');
        } finally {
            if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
            else Reflect.deleteProperty(globalThis, 'crypto');
        }
    });

    it('remounts a same-instance targeted hosted-web guest with a fresh nonce when launch input changes', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const listeners = new Set<(event: MessageEvent) => void>();
        const iframeSources = [
            { postMessage: vi.fn() },
            { postMessage: vi.fn() },
        ] as unknown as WindowProxy[];
        let iframeMounts = 0;
        const previousWindow = (globalThis as any).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const randomUUID = vi.fn()
            .mockReturnValueOnce('instance-launch-frame-one')
            .mockReturnValueOnce('launch-frame-one')
            .mockReturnValueOnce('instance-launch-frame-two')
            .mockReturnValueOnce('launch-frame-two');
        (globalThis as any).window = {
            addEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.add(listener);
            },
            removeEventListener: (event: string, listener: (event: MessageEvent) => void) => {
                if (event === 'message') listeners.delete(listener);
            },
            dispatchEvent: (event: MessageEvent) => {
                for (const listener of [...listeners]) listener(event);
            },
        };
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        const platformRandom = vi.spyOn(await import('@/platform/randomUUID'), 'randomUUID')
            .mockImplementation(randomUUID);
        onTestFinished(() => { platformRandom.mockRestore(); });
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };
        const identity = {
            pluginId: 'acme.preview',
            pluginVersion: '1.2.3',
            viewId: 'preview-pane',
            generation: '1',
            sessionId: 'session-1',
        } as const;
        const canonicalHostApi = {
            authorPlugin: { id: identity.pluginId, version: identity.pluginVersion },
            mount: canonicalMount,
            methods: ['context'] as const,
            target: { kind: 'session', sessionId: 'session-1' } as const,
            accountEncryptionMode: 'e2ee' as const,
            translations: { 'preview.title': 'Preview' },
            targetedContributions: canonicalTargetedContributions,
        };
        const hostApi = { platform: 'web' as const, channel: 'internal' as const, handleRequest: vi.fn(async () => null) };
        const element = (launchInput: PluginUiLaunchInputV1) => (
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                hostApi={hostApi}
                canonicalHostApi={canonicalHostApi}
                launchInput={launchInput}
                mountInstanceKey="review-42"
            />
        );

        try {
            const screen = await renderScreen(element({ reviewId: 'review-42', stale: 'discard-me' }), {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? (() => {
                            const iframeSource = iframeSources[iframeMounts]!;
                            iframeMounts += 1;
                            return { contentWindow: iframeSource };
                        })()
                        : null
                ),
            });
            const firstIframeSource = iframeSources[0]!;
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierBridgeNonce'))
                .toBe('launch-frame-one');
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    source: firstIframeSource,
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as MessageEvent);
            });
            (firstIframeSource.postMessage as ReturnType<typeof vi.fn>).mockClear();

            // Launch input is bootstrap authority. Reopening the same logical
            // mount must give it a new guest realm rather than replacing a
            // live realm's bootstrap state in place.
            await screen.update(element({ filter: 'open' }));
            expect(iframeMounts).toBe(2);
            expect(new URL(String(findHostedWebIframe(screen).props.src)).searchParams.get('happierBridgeNonce'))
                .toBe('launch-frame-two');
            expect(firstIframeSource.postMessage).toHaveBeenCalledTimes(1);
            expect(firstIframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'hostApi',
                payload: expect.objectContaining({
                    kind: 'disconnected',
                    reason: 'host_api_handler_disposed',
                }),
            }), 'https://preview.happier.test');
            (firstIframeSource.postMessage as ReturnType<typeof vi.fn>).mockClear();

            const secondIframeSource = iframeSources[1]!;
            await act(async () => {
                (globalThis as any).window.dispatchEvent({
                    origin: 'https://preview.happier.test',
                    source: secondIframeSource,
                    data: {
                        version: 1,
                        identity: readFrameWireIdentity(screen),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    },
                } as MessageEvent);
            });
            await vi.waitFor(() => expect(secondIframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                direction: 'hostToFrame',
                kind: 'bootstrap',
                identity: readFrameWireIdentity(screen),
                payload: expect.objectContaining({
                    identity: readFrameWireIdentity(screen),
                    launchInput: { filter: 'open' },
                }),
            }), 'https://preview.happier.test'));
            expect(firstIframeSource.postMessage).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
            if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
            else Reflect.deleteProperty(globalThis, 'crypto');
        }
    });

    it('never places subPath, launch input, or canonical runtime identity in the frame URL', async () => {
        const { PluginHostedWebPane } = await import('./PluginHostedWebPane');
        const bridgeProjection: PluginUiProjectionModel = {
            ...projection,
            hostedWebById: {
                ...projection.hostedWebById,
                'hostedWeb:acme.preview:preview-web': {
                    ...projection.hostedWebById['hostedWeb:acme.preview:preview-web'],
                    bridge: { allowedMessages: ['hostApi'] },
                },
            },
        };

        const screen = await renderScreen(
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
                {...({ subPath: 'work/ideas.md', launchInput: { noteId: 'note-7' } } as any)}
            />,
        );

        const frame = findHostedWebIframe(screen);
        const url = new URL(String(frame?.props.src));
        expect(url.searchParams.has('happierSubPath')).toBe(false);
        expect(url.searchParams.has('happierLaunchInput')).toBe(false);
        expect(url.searchParams.has('happierPluginVersion')).toBe(false);
        expect(url.searchParams.has('happierViewId')).toBe(false);
        expect(url.searchParams.has('happierGeneration')).toBe(false);

        // Wrong-implementation control: absent launch facts are absent, not
        // empty strings or `null`, so the guest can still tell "no input" from
        // "input that happens to be null".
        const withoutLaunch = await renderScreen(
            <PluginHostedWebPane mountLifetime={mountLifetime}
                contributionId="hostedWeb:acme.preview:preview-web"
                surfaceContext={sessionSurfaceContext}
                pluginUiProjection={bridgeProjection}
                endpointUrl="https://preview.happier.test/plugin/acme/"
                platform="web"
            />,
        );
        const plainUrl = new URL(String(findHostedWebIframe(withoutLaunch)?.props.src));
        expect(plainUrl.searchParams.has('happierSubPath')).toBe(false);
        expect(plainUrl.searchParams.has('happierLaunchInput')).toBe(false);
    });
});
