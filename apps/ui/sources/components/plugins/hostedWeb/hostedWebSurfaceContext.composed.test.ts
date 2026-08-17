import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeHostMessageEnvelopeV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { PLUGIN_UI_HOST_METHODS_V1 } from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiHostMethodV1,
    PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';
import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { createPluginSurfaceContext } from '@/components/plugins/surfaces/pluginSurfaceContext';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { resolvePluginUiTranslationBundle } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';

/**
 * §7 layer 3 — the public hosted-web client against the real host bridge, with
 * neither end hand-built.
 *
 * The host composes its snapshot through the one context owner and the one theme
 * projection; the guest parses it through the SDK's strict `readSurface`. A
 * disagreement about the exact target, the semantic theme or the translation
 * bundle fails here rather than at author time.
 */
const requestSurface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const identity = {
    pluginId: 'acme.preview',
    pluginVersion: '1.2.3',
    viewId: 'preview-pane',
    generation: '7',
    sessionId: 'session-1',
} as const;

const translatedProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    translationsByPluginId: {
        'acme.preview': {
            id: 'translations:acme.preview',
            pluginId: 'acme.preview',
            contributionKind: 'translations',
            locales: ['en', 'fr'],
            bundles: {
                en: { 'preview.title': 'Preview', 'preview.onlyEnglish': 'English only' },
                fr: { 'preview.title': 'Aperçu' },
            },
        },
    },
} as unknown as PluginUiProjectionModel;

const targetedContributions = {
    target: {
        pluginId: 'acme.target',
        immutableGenerationId: 'target-generation-1',
    },
    points: [],
} as const satisfies SurfaceContext['targetedContributions'];

function themeForProfile(index: number, mode: 'light' | 'dark' = 'dark') {
    const definition = BUILT_IN_THEME_PROFILES[index];
    if (!definition) throw new Error('missing built-in theme profile fixture');
    return projectPluginUiTheme(resolveThemeProfile({ mode, profile: definition.profile }));
}

function createHostSurface(input: Readonly<{
    themeProfileIndex: number;
    locale: string;
    accountEncryptionMode?: SurfaceContext['accountEncryptionMode'];
    target?: SurfaceContext['target'];
}>): SurfaceContext {
    return createPluginSurfaceContext({
        mount: {
            kind: 'destination',
            destination: { pluginId: 'acme.preview', localId: 'preview-web' },
            container: 'rightPane',
        },
        target: input.target ?? { kind: 'session', sessionId: 'session-1', agentId: 'codex' },
        accountEncryptionMode: input.accountEncryptionMode ?? 'e2ee',
        environment: {
            platform: 'web',
            locale: input.locale,
            direction: 'ltr',
            colorScheme: 'dark',
            contrast: 'normal',
            textScale: 1,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
            theme: themeForProfile(input.themeProfileIndex),
        },
        translations: resolvePluginUiTranslationBundle({
            projection: translatedProjection,
            pluginId: 'acme.preview',
            locale: input.locale,
        }),
        targetedContributions,
    });
}

/**
 * Connect the public client to the real bridge handler: the client's wire
 * envelopes are carried inside the production hosted-web bridge envelope and its
 * replies are delivered back verbatim.
 */
async function connectClient(input: Readonly<{
    surface: SurfaceContext;
    handleRequest?: (request: PluginUiHostApiRequestEnvelopeV1) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;
    /** EU-8: the host->frame push sink the real frame supplies. */
    withPushChannel?: boolean;
    /** The mount's factual installed set; defaults to the canonical test set. */
    methods?: readonly PluginUiHostMethodV1[];
}>) {
    const pushed: PluginHostedWebBridgeHostMessageEnvelopeV1[] = [];
    const sent: unknown[] = [];
    let sequence = 0;
    let deliver: ((message: unknown) => void) | undefined;
    const handler = createPluginHostedWebHostApiBridgeHandler({
        surface: requestSurface,
        requestIdPrefix: 'hosted-web',
        bridgeNonce: 'nonce-1',
        ...(input.handleRequest ? { handleRequest: input.handleRequest } : {}),
        canonicalHostApi: {
            identity,
            surface: input.surface as unknown as PluginUiJsonValueV1,
            methods: [...(input.methods ?? PLUGIN_UI_HOST_METHODS_V1)],
        },
        ...(input.withPushChannel
            ? {
                postToFrame: (envelope: PluginHostedWebBridgeHostMessageEnvelopeV1) => {
                    pushed.push(envelope);
                    deliver?.(envelope.payload);
                },
            }
            : {}),
    });
    // The public client is reachable only after the guest's one strict ready
    // admission. This composed harness used to inject a transport directly and
    // therefore skipped the host lifecycle that production now requires.
    await handler({
        version: 1,
        pluginId: requestSurface.pluginId,
        contributionId: requestSurface.contributionId,
        surfaceId: requestSurface.surfaceId,
        sessionId: requestSurface.sessionId,
        nonce: 'nonce-1',
        sequence: ++sequence,
        kind: 'ready',
        payload: { ready: true },
    });
    // Bootstrap is deliberately sent before the guest transport installs its
    // listener. The tests below concern the later canonical wire, so do not
    // mistake that lifecycle packet for a resource/context subscription push.
    pushed.length = 0;
    // The guest realm installs this bootstrap; the seam key is owned by
    // `packages/plugin-sdk/src/ui/clientBootstrap.ts` and is host-private, so the
    // test writes it exactly as the SDK's own realm installer does.
    Reflect.set(globalThis, '__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__', {
        identity,
        transport: {
            send(message: unknown) {
                sent.push(message);
                sequence += 1;
                const envelope: PluginHostedWebBridgeEnvelopeV1 = {
                    version: 1,
                    pluginId: requestSurface.pluginId,
                    contributionId: requestSurface.contributionId,
                    surfaceId: requestSurface.surfaceId,
                    sessionId: requestSurface.sessionId,
                    nonce: 'nonce-1',
                    sequence,
                    kind: 'hostApi',
                    payload: message as PluginUiJsonValueV1,
                };
                void handler(envelope).then((response) => {
                    if (response.kind === 'result') deliver?.(response.payload);
                });
            },
            subscribe(listener: (message: unknown) => void) {
                deliver = listener;
                return { dispose: () => { deliver = undefined; } };
            },
        },
    });
    return { client: await createPluginUiHostApiClient(), handler, pushed, sent };
}

describe('hosted-web surface context over the real bridge and public client (§3.2, §3.3)', () => {
    it('delivers the exact target, the semantic theme and the plugin translation bundle', async () => {
        const hostSurface = createHostSurface({ themeProfileIndex: 0, locale: 'fr' });
        const { client } = await connectClient({ surface: hostSurface });

        const observed = await client.context();
        expect(observed.mount).toEqual(hostSurface.mount);
        expect(observed.target).toEqual({ kind: 'session', sessionId: 'session-1', agentId: 'codex' });
        expect(observed.accountEncryptionMode).toBe('e2ee');
        expect(observed.targetedContributions).toEqual(targetedContributions);
        expect(observed.theme).toEqual(hostSurface.theme);
        // Preferred locale wins per key; the English bundle still supplies the
        // keys the preferred locale does not translate.
        expect(observed.translations).toEqual({
            'preview.title': 'Aperçu',
            'preview.onlyEnglish': 'English only',
        });
    });

    it('changes the observed theme when the ACTIVE theme profile changes', async () => {
        const first = await connectClient({ surface: createHostSurface({ themeProfileIndex: 0, locale: 'en' }) });
        const second = await connectClient({ surface: createHostSurface({ themeProfileIndex: 1, locale: 'en' }) });

        const before = (await first.client.context()).theme;
        const after = (await second.client.context()).theme;
        expect(after).not.toEqual(before);
        expect(Object.keys(after.colors).some((key) => (
            after.colors[key as keyof typeof after.colors] !== before.colors[key as keyof typeof before.colors]
        ))).toBe(true);
    });

    it('rejects a target that is not exact instead of degrading it', async () => {
        // A session arm with no session id is a malformed host payload. The
        // client must refuse it rather than hand the author an identity-less
        // target — which is exactly what the retired optional `session?` bag
        // allowed.
        const inexact = {
            ...createHostSurface({ themeProfileIndex: 0, locale: 'en' }),
            target: { kind: 'session' },
        } as unknown as SurfaceContext;
        await expect(connectClient({ surface: inexact })).rejects.toMatchObject({
            code: 'invalid_payload',
        });
    });

    it('serves notify and confirm over the bridge and returns the user answer', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handleRequest = vi.fn(async (request: PluginUiHostApiRequestEnvelopeV1) => {
            requests.push(request);
            return request.method === 'confirm' ? { confirmed: true } : null;
        });
        const { client } = await connectClient({
            surface: createHostSurface({ themeProfileIndex: 0, locale: 'en' }),
            handleRequest,
        });

        expect(client.version().methods).toEqual(expect.arrayContaining(['notify', 'confirm']));
        await expect(client.notify('Saved', { severity: 'warning' })).resolves.toBeUndefined();
        await expect(client.confirm('Delete it?', { title: 'Confirm' })).resolves.toBe(true);
        expect(requests.map((request) => request.method)).toEqual(['notify', 'confirm']);
        expect(requests[0]?.payload).toEqual({ message: 'Saved', severity: 'warning' });
        expect(requests[1]?.payload).toEqual({ message: 'Delete it?', title: 'Confirm' });
    });
});

/**
 * §7 layer 3 for the host->frame direction (EU-8). The bridge had no unsolicited
 * push path at all, so a mounted hosted-web surface could not observe a locale,
 * theme, direction or accessibility change, and host-side retirement never
 * reached it. Every assertion below runs the REAL bridge handler against the
 * REAL public client — neither end hand-builds the other's envelope.
 */
describe('hosted-web host->frame push channel (§3.12, EU-8)', () => {
    it('delivers a host context update to a watchContext subscriber', async () => {
        const before = createHostSurface({ themeProfileIndex: 0, locale: 'en' });
        const after = createHostSurface({
            themeProfileIndex: 1,
            locale: 'fr',
            accountEncryptionMode: 'plain',
        });
        const { client, handler, pushed } = await connectClient({ surface: before, withPushChannel: true });

        expect(client.version().methods).toContain('watchContext');
        const observed: SurfaceContext[] = [];
        const subscription = await client.watchContext((context) => { observed.push(context); });

        handler.pushSurfaceContext(after as unknown as PluginUiJsonValueV1);
        await vi.waitFor(() => expect(observed).toHaveLength(1));
        expect(observed[0]?.theme).toEqual(after.theme);
        expect(observed[0]?.accountEncryptionMode).toBe('plain');
        expect(observed[0]?.translations['preview.title']).toBe('Aperçu');
        // The push rides the canonical wire inside a `hostToFrame` envelope; a
        // second host->frame language would show up here.
        expect(pushed[0]).toMatchObject({
            direction: 'hostToFrame',
            kind: 'hostApi',
            payload: { wireVersion: 1, kind: 'subscription', identity },
        });

        // Wrong-implementation control: an identical snapshot is not a change,
        // and a retired subscription observes nothing more.
        handler.pushSurfaceContext(after as unknown as PluginUiJsonValueV1);
        subscription.dispose();
        handler.pushSurfaceContext(before as unknown as PluginUiJsonValueV1);
        await vi.waitFor(() => expect(pushed.length).toBeGreaterThan(0));
        expect(observed).toHaveLength(1);
        // Disposing the final watch listener stops only that listener. A later
        // direct read must still consult the host's one current snapshot rather
        // than being frozen at the subscriber's last delivered value.
        await expect(client.context()).resolves.toEqual(before);
    });

    it('refuses to advertise watchContext when the transport has no push channel', async () => {
        // The wrong implementation advertises a subscription it cannot deliver:
        // the author would establish it and observe nothing forever.
        const { client } = await connectClient({
            surface: createHostSurface({ themeProfileIndex: 0, locale: 'en' }),
        });
        expect(client.version().methods).not.toContain('watchContext');
        await expect(client.watchContext(() => undefined)).rejects.toMatchObject({
            code: 'unsupported_method',
        });
    });

    it('retires the surface at the guest when the host disposes it', async () => {
        const { client, handler } = await connectClient({
            surface: createHostSurface({ themeProfileIndex: 0, locale: 'en' }),
            withPushChannel: true,
            // A request the host never settles: without a push the guest would
            // wait out its whole timeout on a surface that is already gone.
            handleRequest: () => new Promise<PluginUiJsonValueV1>(() => undefined),
        });
        const observed: SurfaceContext[] = [];
        await client.watchContext((context) => { observed.push(context); });
        const inFlight = client.confirm('Still there?');
        // Do not leave the rejection unobserved while the assertions below run.
        const settled = inFlight.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        await expect(client.context()).resolves.toBeDefined();

        handler.dispose();

        // The guest learns immediately rather than discovering retirement on its
        // next request: the in-flight call settles with the host's own reason,
        // the surface becomes inert, and a later host push reaches nobody.
        await expect(settled).resolves.toMatchObject({
            ok: false,
            error: { code: 'host_api_handler_disposed' },
        });
        await expect(client.context()).rejects.toMatchObject({ code: 'ui_host_unavailable' });
        handler.pushSurfaceContext(
            createHostSurface({ themeProfileIndex: 1, locale: 'fr' }) as unknown as PluginUiJsonValueV1,
        );
        expect(observed).toHaveLength(0);
    });

    it('serves a live resource subscription over the bridge and pushes its invalidation (EU-4b)', async () => {
        // Composed: the PUBLIC SDK client establishes `watchResource` through
        // the real bridge, the mount's own handler admits it, and the mount's
        // invalidation sink reaches the guest listener over the host->frame push
        // channel. Nothing here re-implements a subscription registry.
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        // The return type is annotated rather than inferred: TypeScript would
        // otherwise widen the two branches into a union carrying `retired?:
        // undefined`, which no JSON value can hold.
        const handleRequest = vi.fn(async (
            request: PluginUiHostApiRequestEnvelopeV1,
        ): Promise<PluginUiJsonValueV1> => {
            requests.push(request);
            return request.method === 'watchResource'
                ? {
                    subscriptionId: (request.payload as { subscriptionId: string }).subscriptionId,
                    digest: `sha256:${'a'.repeat(64)}`,
                }
                : { retired: true };
        });
        const { client, handler, sent } = await connectClient({
            surface: createHostSurface({ themeProfileIndex: 0, locale: 'en' }),
            handleRequest,
            withPushChannel: true,
            methods: [...PLUGIN_UI_HOST_METHODS_V1],
        });

        const observed: PluginUiResourceSubscriptionEventV1[] = [];
        const subscription = await client.watchResource(
            'live-status',
            (event) => { observed.push(event as PluginUiResourceSubscriptionEventV1); },
        );
        const establishment = requests.find((request) => request.method === 'watchResource');
        expect(establishment?.payload).toMatchObject({
            resource: 'live-status',
            subscriptionId: expect.any(String),
        });

        const subscriptionId = (establishment?.payload as { subscriptionId: string }).subscriptionId;
        expect(subscription).toMatchObject({ admittedDigest: `sha256:${'a'.repeat(64)}` });
        expect(handler.publishResourceSubscriptionEvent({
            version: 1,
            subscriptionId,
            kind: 'invalidated',
            digest: `sha256:${'b'.repeat(64)}`,
        })).toBe(true);
        await vi.waitFor(() => { expect(observed).toHaveLength(1); });
        expect(observed[0]).toMatchObject({ kind: 'invalidated', digest: `sha256:${'b'.repeat(64)}` });

        // Negative control: an event naming a subscription this transport never
        // admitted is not pushed at all.
        expect(handler.publishResourceSubscriptionEvent({
            version: 1,
            subscriptionId: 'never-established',
            kind: 'invalidated',
            digest: `sha256:${'c'.repeat(64)}`,
        })).toBe(false);

        subscription.dispose();
        expect(sent).toContainEqual(expect.objectContaining({
            kind: 'disposeHostResource',
            subscriptionId,
        }));
        await vi.waitFor(() => {
            expect(requests.some((request) => request.method === 'disposeHostResource')).toBe(true);
        });
    });

    it('refuses a live resource subscription on a mount that did not install it', async () => {
        const { client } = await connectClient({
            surface: createHostSurface({ themeProfileIndex: 0, locale: 'en' }),
            handleRequest: async () => null,
            withPushChannel: true,
            // This transport can push, but the mounted controller did not
            // install the Resource handler. Keep the factual method set
            // separate from transport capability so the real negotiation
            // owner—not this harness—refuses the request.
            methods: PLUGIN_UI_HOST_METHODS_V1.filter((method) => method !== 'watchResource'),
        });
        await expect(client.watchResource('live-status', () => undefined))
            .rejects.toMatchObject({ code: 'unsupported_method' });
    });
});
