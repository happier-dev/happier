import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginUiHostMethodV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceHostApi } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import {
    createPluginSurfaceOpenSurfaceHandler,
    type PluginSurfaceOpenHandler,
} from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceHostApiHandlers } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';

/**
 * One settlement rule, two physical carriers.
 *
 * `openSurface` is the case that forces the rule to exist: the navigation it
 * performs routinely unmounts the surface that requested it, so the mount's
 * retirement is a CONSEQUENCE of the success. A carrier that reads currentness
 * after the settlement and rewrites it into `stale_surface` tells the author
 * nothing happened after something did, and the only sane response to "nothing
 * happened" is to do it again.
 *
 * `openNewSession` is the sibling navigation: the New Session screen it opens
 * replaces the requesting surface, so the same consequence rule applies. A
 * terminal `settleEphemeralInput` is the sibling settlement: the mounted owner
 * records the input and closes the ephemeral surface as a consequence, and the
 * settlement is durable — rewriting it into `stale_surface` would ask the
 * plugin to settle an already-settled input, which can only fail.
 *
 * `confirm` is the discriminating contrast: its settlement is a DECISION about
 * a mount, so a retired mount cannot vouch for it and both carriers still
 * refuse. A rule that delivered everything would pass the openSurface rows and
 * fail these.
 *
 * Caller WITHDRAWAL is a different fact from retirement and is never rewritten
 * into success: a launch the caller cancelled before the owner settled it
 * settles as the carrier's typed withdrawal, and a response that arrives after
 * the withdrawal is inert.
 */

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const canonicalIdentity = {
    pluginId: 'acme.preview',
    pluginVersion: '1.2.3',
    viewId: 'preview-pane',
    generation: '7',
    sessionId: 'session-1',
} as const;

const canonicalSurface = {
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview' },
        container: 'rightPane',
    },
    target: { kind: 'session', sessionId: 'session-1' },
    platform: 'web',
    locale: 'en',
    direction: 'ltr',
    colorScheme: 'light',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    translations: {},
    targetedContributions: {
        target: { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' },
        points: [],
    },
} as const;

const destination = { pluginId: 'acme.preview', localId: 'details' } as const;

type MountFixture = Readonly<{
    /** Flipped by the fixture to simulate the mount retiring. */
    retire: () => void;
    isCurrent: () => boolean;
    /** Captured while the mount is live: retirement empties the live set. */
    installedMethods: readonly PluginUiHostMethodV1[];
    host: ReturnType<typeof createPluginSurfaceHostApi>;
}>;

function createMount(input: Readonly<{
    openSurface?: PluginSurfaceOpenHandler;
    confirm?: () => Promise<PluginUiJsonValueV1>;
    /** Additional canonical handlers under test (openNewSession, settleEphemeralInput, …). */
    handlers?: PluginSurfaceHostApiHandlers;
}>): MountFixture {
    let current = true;
    const isCurrent = () => current;
    const host = createPluginSurfaceHostApi({
        surfaceContext: surface,
        isCurrent,
        handlers: {
            ...(input.openSurface
                ? { openSurface: createPluginSurfaceOpenSurfaceHandler(input.openSurface, isCurrent) }
                : {}),
            ...(input.confirm ? { confirm: async () => await input.confirm!() } : {}),
            ...input.handlers,
        },
    });
    return {
        retire: () => { current = false; },
        isCurrent,
        installedMethods: [...host.installedMethods],
        host,
    };
}

function createNativeCarrier(mount: MountFixture) {
    return createCanonicalPluginReactNativeHostApiAdapter({
        surface: canonicalSurface as unknown as SurfaceContext,
        requestSurface: surface,
        requestIdPrefix: 'rn-settlement',
        handleRequest: mount.host.handleRequest,
        installedMethods: mount.installedMethods,
        getAdmissionMethods: () => mount.installedMethods,
        isCurrent: mount.isCurrent,
    });
}

function createHostedEnvelope(
    kind: PluginHostedWebBridgeEnvelopeV1['kind'],
    payload: PluginHostedWebBridgeEnvelopeV1['payload'],
    sequence = 7,
): PluginHostedWebBridgeEnvelopeV1 {
    return {
        version: 1,
        pluginId: surface.pluginId,
        contributionId: surface.contributionId,
        surfaceId: surface.surfaceId,
        sessionId: surface.sessionId,
        nonce: 'nonce-1',
        sequence,
        kind,
        payload,
    };
}

async function createHostedCarrier(mount: MountFixture, methods: readonly PluginUiHostMethodV1[]) {
    const handler = createPluginHostedWebHostApiBridgeHandler({
        surface,
        requestIdPrefix: 'hosted-settlement',
        bridgeNonce: 'nonce-1',
        canonicalHostApi: {
            identity: canonicalIdentity,
            surface: canonicalSurface,
            methods,
        },
        handleRequest: mount.host.handleRequest,
        isCurrent: mount.isCurrent,
    });
    await handler(createHostedEnvelope('ready', { ready: true }));
    await handler(createHostedEnvelope('hostApi', {
        wireVersion: 1,
        kind: 'negotiate',
        identity: canonicalIdentity,
        apiRange: '^1.0.0',
    }, 8));
    return handler;
}

function hostedRequest(
    handler: Awaited<ReturnType<typeof createHostedCarrier>>,
    input: Readonly<{ requestId: string; method: string; payload?: unknown; sequence?: number }>,
) {
    return handler(createHostedEnvelope('hostApi', {
        wireVersion: 1,
        kind: 'request',
        identity: canonicalIdentity,
        requestId: input.requestId,
        method: input.method,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
    } as PluginHostedWebBridgeEnvelopeV1['payload'], input.sequence ?? 9));
}

describe('outward-effect settlement across the React Native and hosted-web carriers', () => {
    // Scenario: contributor retirement AFTER success / disconnect AFTER a known
    // settlement. These are the same transport fact — currentness read after the
    // owner settled — and `openSurface` produces it by construction.
    it('delivers a navigation that retired its own mount, on both carriers', async () => {
        const nativeMount = createMount({
            openSurface: async () => { nativeMount.retire(); return { ok: true as const }; },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openSurface(destination)).resolves.toBeUndefined();

        const hostedMount = createMount({
            openSurface: async () => { hostedMount.retire(); return { ok: true as const }; },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        await expect(hostedRequest(hosted, {
            requestId: 'open-1',
            method: 'openSurface',
            payload: { destination },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'openSurface' },
        });
    });

    // Discriminating contrast: a DECISION settled by a mount that then retired
    // is still refused on both carriers. A rule that simply delivered every
    // known settlement would pass the row above and fail this one.
    it('still refuses a confirmation whose mount retired, on both carriers', async () => {
        const nativeMount = createMount({
            openSurface: async () => ({ ok: true as const }),
            confirm: async () => { nativeMount.retire(); return { confirmed: true }; },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.confirm('Delete the preview?')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'stale_surface',
        });

        const hostedMount = createMount({
            openSurface: async () => ({ ok: true as const }),
            confirm: async () => { hostedMount.retire(); return { confirmed: true }; },
        });
        const hosted = await createHostedCarrier(hostedMount, ['confirm']);
        await expect(hostedRequest(hosted, {
            requestId: 'confirm-1',
            method: 'confirm',
            payload: { message: 'Delete the preview?' },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'stale_surface' } },
        });
    });

    it('reports stale_surface consistently when a non-outward handler errors as its mount retires', async () => {
        const nativeMount = createMount({
            confirm: async () => {
                nativeMount.retire();
                throw new Error('confirmation_owner_failed');
            },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.confirm('Delete the preview?')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'stale_surface',
        });

        const hostedMount = createMount({
            confirm: async () => {
                hostedMount.retire();
                throw new Error('confirmation_owner_failed');
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['confirm']);
        await expect(hostedRequest(hosted, {
            requestId: 'confirm-error-retired',
            method: 'confirm',
            payload: { message: 'Delete the preview?' },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'stale_surface' } },
        });
    });

    // Scenario: disconnect BEFORE any settlement. Nothing was applied, so the
    // refusal is truthful on both carriers and the author may retry.
    it('refuses a navigation whose mount retired before the placement settled', async () => {
        const nativeMount = createMount({
            openSurface: async () => ({ ok: true as const }),
        });
        nativeMount.retire();
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openSurface(destination)).rejects.toMatchObject({
            name: 'PluginError',
            code: 'stale_surface',
        });

        const hostedMount = createMount({
            openSurface: async () => ({ ok: true as const }),
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        hostedMount.retire();
        // A bridge whose mount is already retired refuses at its own entry,
        // before the request can reach the owner at all.
        await expect(hostedRequest(hosted, {
            requestId: 'open-stale',
            method: 'openSurface',
            payload: { destination },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });
    });

    // Scenario: the New Session launch is the sibling navigation. The New
    // Session screen replaces the requesting surface, so the retirement is a
    // CONSEQUENCE of the success and must not rewrite it on either carrier.
    it('delivers a New Session launch that retired its own mount, on both carriers', async () => {
        const nativeMount = createMount({
            handlers: {
                openNewSession: async () => {
                    nativeMount.retire();
                    return null;
                },
            },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openNewSession({ prompt: 'Repair CI' })).resolves.toBeUndefined();

        const hostedMount = createMount({
            handlers: {
                openNewSession: async () => {
                    hostedMount.retire();
                    return null;
                },
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openNewSession']);
        await expect(hostedRequest(hosted, {
            requestId: 'new-session-1',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'openNewSession' },
        });
    });

    // Scenario: the terminal ephemeral settlement is the sibling durable
    // settlement. The mounted owner records the input and closes the ephemeral
    // surface as a consequence; a rewritten `stale_surface` would invite the
    // plugin to settle an already-settled input, which can only fail.
    it('delivers a terminal ephemeral settlement that retired its own mount, on both carriers', async () => {
        const nativeMount = createMount({
            handlers: {
                settleEphemeralInput: async () => {
                    nativeMount.retire();
                    return null;
                },
            },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.settleEphemeralInput({ kind: 'completed', input: { answer: 7 } }))
            .resolves.toBeUndefined();

        const hostedMount = createMount({
            handlers: {
                settleEphemeralInput: async () => {
                    hostedMount.retire();
                    return null;
                },
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['settleEphemeralInput']);
        await expect(hostedRequest(hosted, {
            requestId: 'ephemeral-1',
            method: 'settleEphemeralInput',
            payload: { kind: 'completed', input: { answer: 7 } },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'settleEphemeralInput' },
        });
    });

    // Scenario: retirement BEFORE any settlement. Nothing launched and nothing
    // was recorded, so the refusal stays truthful on both carriers.
    it('still refuses a New Session launch whose mount retired before the placement settled', async () => {
        const nativeMount = createMount({
            handlers: { openNewSession: async () => null },
        });
        nativeMount.retire();
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openNewSession({ prompt: 'Repair CI' })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'stale_surface',
        });

        const hostedMount = createMount({
            handlers: { openNewSession: async () => null },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openNewSession']);
        hostedMount.retire();
        await expect(hostedRequest(hosted, {
            requestId: 'new-session-stale',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });
    });

    // Scenario: the placement refused. No effect happened, so the refusal
    // reaches the author unchanged and carries its own retry classification.
    it('carries a placement refusal through unchanged, with its own retry classification', async () => {
        const nativeMount = createMount({
            openSurface: async () => ({
                ok: false as const,
                code: 'unavailable' as const,
                reason: 'plugin_surface_open_destination_unknown',
            }),
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openSurface(destination)).rejects.toMatchObject({
            name: 'PluginError',
            code: 'unavailable',
            // `unavailable` is the retryable classification; `stale_surface` is
            // not. Rewriting a completed navigation into `stale_surface` would
            // therefore have changed BOTH what the author is told and whether
            // the SDK considers a retry meaningful.
            retryable: true,
            diagnostics: [{ code: 'plugin_surface_open_destination_unknown', severity: 'error' }],
        });

        const hostedMount = createMount({
            openSurface: async () => ({
                ok: false as const,
                code: 'unavailable' as const,
                reason: 'plugin_surface_open_destination_unknown',
            }),
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        await expect(hostedRequest(hosted, {
            requestId: 'open-refused',
            method: 'openSurface',
            payload: { destination },
        })).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'unavailable' } },
        });
    });

    // Scenario: the caller withdrew. Each carrier keeps its own withdrawal
    // semantics (the hosted guest settles its own promise the moment it
    // aborts), so this asserts only that a withdrawal is never reported as a
    // completed effect.
    it('answers a withdrawn request as a withdrawal rather than a completed effect', async () => {
        let settleOpen: ((outcome: { ok: true }) => void) | undefined;
        const hostedMount = createMount({
            openSurface: () => new Promise((resolve) => { settleOpen = resolve; }),
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        const inFlight = hostedRequest(hosted, {
            requestId: 'open-withdrawn',
            method: 'openSurface',
            payload: { destination },
        });
        await vi.waitFor(() => expect(settleOpen).toBeTypeOf('function'));
        await expect(hosted(createHostedEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'cancel',
            identity: canonicalIdentity,
            requestId: 'open-withdrawn',
        } as PluginHostedWebBridgeEnvelopeV1['payload'], 11))).resolves.toMatchObject({ kind: 'ack' });
        settleOpen?.({ ok: true });
        await expect(inFlight).resolves.toMatchObject({ kind: 'ack' });
    });

    // Scenario: the caller withdrew a New Session launch BEFORE the owner
    // settled it. The direct carrier must settle the withdrawal promptly — not
    // wait for parked handler cooperation — and a response that arrives after
    // the withdrawal is inert.
    it('settles a withdrawn New Session launch promptly on the direct carrier and fences its late response', async () => {
        const controller = new AbortController();
        let settleLaunch: (() => void) | undefined;
        let seenSignal: AbortSignal | undefined;
        const nativeMount = createMount({
            handlers: {
                openNewSession: async (_request, options) => {
                    seenSignal = options?.signal;
                    return await new Promise<PluginUiJsonValueV1>((resolve) => {
                        settleLaunch = () => resolve(null);
                    });
                },
            },
        });
        const native = createNativeCarrier(nativeMount);
        const launch = native.api.openNewSession({ prompt: 'Repair CI' }, { signal: controller.signal });
        const settlements: unknown[] = [];
        void launch.then(
            () => settlements.push({ kind: 'result' }),
            (error: unknown) => settlements.push({ kind: 'error', error }),
        );

        try {
            await vi.waitFor(() => expect(seenSignal).toBeTypeOf('object'));
            controller.abort();

            await vi.waitFor(() => expect(settlements).toHaveLength(1), { timeout: 250 });
            expect(settlements[0]).toMatchObject({
                kind: 'error',
                error: {
                    code: 'unavailable',
                    diagnostics: [{ code: 'aborted', severity: 'error' }],
                },
            });

            settleLaunch?.();
            await vi.waitFor(() => expect(settlements).toHaveLength(1));
            expect(settlements[0]).toMatchObject({ kind: 'error' });
        } finally {
            settleLaunch?.();
            await launch.catch(() => undefined);
        }
    });

    // Scenario: the hosted carrier's cancel wire message reaches the parked
    // mounted handler (the dialog/surface behind it is retired there), and the
    // abandoned request never becomes a completed launch.
    it('cancels a parked New Session launch at the mounted handler on the hosted carrier', async () => {
        let settleLaunch: (() => void) | undefined;
        let seenSignal: AbortSignal | undefined;
        const hostedMount = createMount({
            handlers: {
                openNewSession: async (_request, options) => {
                    seenSignal = options?.signal;
                    return await new Promise<PluginUiJsonValueV1>((resolve) => {
                        settleLaunch = () => resolve(null);
                    });
                },
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openNewSession']);
        const launch = hostedRequest(hosted, {
            requestId: 'new-session-cancelled',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        });
        await vi.waitFor(() => expect(seenSignal).toBeTypeOf('object'));

        await expect(hosted(createHostedEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'cancel',
            identity: canonicalIdentity,
            requestId: 'new-session-cancelled',
        } as PluginHostedWebBridgeEnvelopeV1['payload'], 11))).resolves.toMatchObject({ kind: 'ack' });
        expect(seenSignal?.aborted).toBe(true);

        settleLaunch?.();
        await expect(launch).resolves.toMatchObject({ kind: 'ack' });
    });
});
