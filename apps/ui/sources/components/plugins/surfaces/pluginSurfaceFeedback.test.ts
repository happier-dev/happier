import {
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `@/modal` is the platform dialog boundary and is owned by the testkit mock.
 * `show`/`hide` are captured here so a test can drive the REAL
 * app-scope transient Interaction lifecycle — open, answer, abort, host unmount —
 * exactly as the app-shell owner drives it. `confirm` is captured too, so a
 * regression back to the retired `Modal.confirm` lifecycle is observable rather
 * than silent.
 */
const modalHarness = vi.hoisted(() => {
    let config: {
        props: { onConfirm(): void; onCancel(): void };
        onRequestClose(): void;
        onHostUnmount(): void;
        chrome?: { title?: string; testID?: string };
    } | null = null;
    let nextModalId = 'plugin-confirm-modal';
    return {
        show: vi.fn((next: unknown) => {
            config = next as typeof config;
            return nextModalId;
        }),
        hide: vi.fn(),
        confirm: vi.fn(async () => true),
        readConfig: () => {
            if (!config) throw new Error('no modal was shown');
            return config;
        },
        shown: () => config !== null,
        setNextModalId: (id: string) => { nextModalId = id; },
        reset: () => {
            config = null;
            nextModalId = 'plugin-confirm-modal';
        },
    };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalHarness.show as never,
            hide: modalHarness.hide,
            confirm: modalHarness.confirm,
        },
    }).module;
});

const { createCanonicalPluginReactNativeHostApiAdapter } = await import(
    '@/components/plugins/reactNative/hostApi'
);
const { createPluginSurfaceActionHostApi } = await import('./pluginSurfaceActionDispatch');
const {
    readPresentationNotice,
    retirePresentationNotice,
} = await import('@/components/sessions/presentation/presentationNotices');
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');

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

const canonicalSurface = createPluginSurfaceContextFixture({
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'native-preview' },
        container: 'rightPane',
    },
    target: { kind: 'session', sessionId: 'session-1' },
});

/**
 * Composed: the public SDK host API a generated RN surface holds, over the real
 * canonical adapter, over the real mounted host-API composition. Nothing between
 * the plugin call and Happier's own presentation/interaction owner is stubbed —
 * only `@/modal`, the platform dialog boundary, is substituted, and it answers
 * with a real user decision.
 */
function createMountedSurface(isCurrent?: () => boolean) {
    const host = createPluginSurfaceActionHostApi({
        surfaceContext,
        interactionRequester: {
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            generationId: 'generation-1',
            invocationId: 'surface_1',
        },
        ...(isCurrent ? { isCurrent } : {}),
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: canonicalSurface,
        requestSurface: surfaceContext,
        requestIdPrefix: 'rn-feedback',
        handleRequest: host.handleRequest,
        installedMethods: host.installedMethods,
    });
    return { host, adapter };
}

/**
 * Let the request cross the adapter, the mounted host API and the confirmation
 * owner so the dialog is actually on screen before a test answers it.
 */
async function openedDialog(): Promise<void> {
    for (let attempt = 0; attempt < 10 && !modalHarness.shown(); attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    if (!modalHarness.shown()) throw new Error('the confirmation dialog never opened');
}

beforeEach(() => {
    modalHarness.show.mockClear();
    modalHarness.hide.mockClear();
    modalHarness.confirm.mockClear();
    modalHarness.reset();
    retirePresentationNotice();
});

afterEach(() => {
    retirePresentationNotice();
});

describe('mounted plugin surface feedback and confirmation (§3.4, UI-T21)', () => {
    it('advertises notify and confirm as installed methods', () => {
        const { host, adapter } = createMountedSurface();
        expect(host.installedMethods).toEqual(expect.arrayContaining(['notify', 'confirm']));
        expect(adapter.api.version().methods).toEqual(expect.arrayContaining(['notify', 'confirm']));
        adapter.dispose();
    });

    it('reaches the app presentation notice owner, not merely the handler', async () => {
        const { adapter } = createMountedSurface();
        await expect(adapter.api.notify('Preview refreshed', { severity: 'warning' })).resolves.toBeUndefined();

        // The observable is the owner's state, which the app's notice host
        // renders — not a spy on the handler.
        expect(readPresentationNotice()).toMatchObject({
            message: 'Preview refreshed',
            severity: 'warning',
        });
        adapter.dispose();
    });

    it('retires its notice when the surface retires', async () => {
        const { host, adapter } = createMountedSurface();
        await adapter.api.notify('Still working');
        expect(readPresentationNotice()).not.toBeNull();

        host.dispose?.();
        expect(readPresentationNotice()).toBeNull();
        adapter.dispose();
    });

    it('reaches the cancellable app-shell confirmation owner and returns the user answer', async () => {
        const { adapter } = createMountedSurface();
        const confirmed = adapter.api.confirm('Delete the preview?', { title: 'Delete' });
        await openedDialog();

        // The owner, not a second lifecycle around `Modal.confirm`: the mounted
        // dialog is the app-shell confirmation, titled and described from the
        // plugin's own message.
        expect(modalHarness.confirm).not.toHaveBeenCalled();
        expect(modalHarness.readConfig().chrome?.testID).toBe('app-shell-transient-interaction-dialog');
        expect(modalHarness.readConfig().chrome?.title).toBe('Delete');
        expect(modalHarness.show.mock.calls[0]?.[0]).toMatchObject({
            props: { description: 'Delete the preview?' },
        });

        modalHarness.readConfig().props.onConfirm();
        await expect(confirmed).resolves.toBe(true);

        const declined = adapter.api.confirm('Delete the preview?');
        await openedDialog();
        // Without an author-supplied title the message is the dialog body, not a
        // duplicated heading.
        expect(modalHarness.readConfig().chrome?.title).toBeUndefined();
        modalHarness.readConfig().props.onCancel();
        await expect(declined).resolves.toBe(false);
        adapter.dispose();
    });

    it('a declined confirmation prevents the effect', async () => {
        // The deciding shape for an author: `confirm` resolves the user's answer
        // rather than throwing, so the guarded effect is simply not run.
        const { adapter } = createMountedSurface();
        const effect = vi.fn();

        const pending = adapter.api.confirm('Delete the preview?');
        await openedDialog();
        modalHarness.readConfig().props.onCancel();
        if (await pending) effect();

        expect(effect).not.toHaveBeenCalled();
        expect(readPresentationNotice()).toBeNull();
        adapter.dispose();
    });

    it('retires a confirmation that is still pending when the surface retires', async () => {
        // The r0.9 defect: currentness was checked only BEFORE the dialog opened,
        // so a surface that retired while the user was still deciding received a
        // boolean settlement it had no authority to act on.
        const { host, adapter } = createMountedSurface();
        const pending = adapter.api.confirm('Delete the preview?', { title: 'Delete' });
        await openedDialog();

        host.dispose?.();

        // Dismissed, and a late answer from the still-rendered dialog is inert.
        expect(modalHarness.hide).toHaveBeenCalledWith('plugin-confirm-modal');
        modalHarness.readConfig().props.onConfirm();

        // The author learns the UI could not deliver an answer. A bare `false`
        // here would read as a decline the user never made.
        await expect(pending).rejects.toMatchObject({ code: 'stale_surface' });
        adapter.dispose();
    });

    it('withdraws a confirmation the author cancelled without reporting a decline', async () => {
        // `PluginCancellationOptions` is a promise the host owes for the WHOLE
        // in-flight window. Checking the author's signal only before opening the
        // dialog left a cancelled confirmation on screen waiting for an answer
        // nobody could act on, and the question could still settle afterwards.
        const { adapter } = createMountedSurface();
        const controller = new AbortController();
        const pending = adapter.api.confirm('Delete the preview?', {
            title: 'Delete',
            signal: controller.signal,
        });
        const settled = pending.then(
            (confirmed) => ({ kind: 'resolved' as const, confirmed }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
        );
        await openedDialog();

        controller.abort();

        // The canonical confirmation owner dismisses it, ...
        expect(modalHarness.hide).toHaveBeenCalledWith('plugin-confirm-modal');
        // ... and a late answer from the still-rendered dialog is inert.
        modalHarness.readConfig().props.onConfirm();

        const outcome = await settled;
        // Never `false`: the author withdrawing the question is not the user
        // saying no, and collapsing the two would have the plugin act on a
        // decline that never happened.
        expect(outcome).not.toMatchObject({ kind: 'resolved' });
        expect(outcome).toMatchObject({
            kind: 'rejected',
            error: { code: 'unavailable' },
        });
        adapter.dispose();
    });

    it('still returns the user answer when a supplied signal never aborts', async () => {
        // Negative control for the case above: holding a cancellation signal is
        // not itself a cancellation, so a real decline stays a `false` answer.
        const { adapter } = createMountedSurface();
        const controller = new AbortController();
        const pending = adapter.api.confirm('Delete the preview?', { signal: controller.signal });
        await openedDialog();

        modalHarness.readConfig().props.onCancel();

        await expect(pending).resolves.toBe(false);
        expect(modalHarness.hide).not.toHaveBeenCalled();
        adapter.dispose();
    });

    it('treats a late answer from a superseded generation as unavailable, not a decline', async () => {
        // Generation replacement retires the mount without disposing this host
        // API, so the dialog stays on screen: the answer must still not settle.
        let current = true;
        const { adapter } = createMountedSurface(() => current);
        const pending = adapter.api.confirm('Delete the preview?');
        await openedDialog();

        current = false;
        modalHarness.readConfig().props.onConfirm();

        await expect(pending).rejects.toMatchObject({ code: 'stale_surface' });
        adapter.dispose();
    });

    it('separates a confirmation the host could not present from a decline', async () => {
        modalHarness.setNextModalId('');
        const { adapter } = createMountedSurface();

        await expect(adapter.api.confirm('Delete the preview?'))
            .rejects.toMatchObject({ code: 'unavailable' });
        adapter.dispose();
    });

    it('refuses feedback from a retired mount', async () => {
        let current = true;
        const { adapter } = createMountedSurface(() => current);
        current = false;

        await expect(adapter.api.notify('Too late')).rejects.toMatchObject({ code: 'stale_surface' });
        await expect(adapter.api.confirm('Too late?')).rejects.toMatchObject({ code: 'stale_surface' });
        expect(readPresentationNotice()).toBeNull();
        expect(modalHarness.show).not.toHaveBeenCalled();
        expect(modalHarness.confirm).not.toHaveBeenCalled();
        adapter.dispose();
    });

    it('rejects a malformed feedback payload instead of showing an empty notice', async () => {
        const { host } = createMountedSurface();
        const request = {
            version: 1 as const,
            requestId: 'req-1',
            surface: surfaceContext,
            method: 'notify' as const,
            payload: { message: '   ' },
        };
        await expect(Promise.resolve(host.handleRequest(request)))
            .resolves.toMatchObject({ code: 'invalid_payload' });
        expect(readPresentationNotice()).toBeNull();
    });
});
