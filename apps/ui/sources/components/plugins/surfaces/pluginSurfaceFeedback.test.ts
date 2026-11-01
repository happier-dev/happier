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
const { createPluginActionCurrentIntentHandler } = await import('./pluginSurfaceFeedback');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { PluginProjectedActionV2Schema, normalizeActionsSettingsV1 } = await import('@happier-dev/protocol');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { createDirectTriageActionsTransport } = await import('../../../../../../packages/plugins/triage/src/ui/actions/actionsCommand');
const { TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol');
const { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } = await import('../../../../../../packages/plugins/triage/src/settings/actions');
const { createTestkitAccountKv } = await import('../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support');
const { createDirectTriageUnlinkTransport } = await import('../../../../../../packages/plugins/triage/src/sessions/cockpit/unlinkLinkedEntry');
const { TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/triage/src/actions/entrySessionProtocol');
const { createTestkitCorpusCollections } = await import('../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support');
const { testkitEntryRef } = await import('../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
const { linkEntryToSession } = await import('../../../../../../packages/plugins/triage/src/sessions/entrySessionLinks');

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
function createMountedSurface(isCurrent?: () => boolean, dangerLevel: 'safe' | 'writesLocal' = 'writesLocal', actionLocalId = 'update', lifetimeSignal?: AbortSignal) {
    const action = PluginProjectedActionV2Schema.parse({
        pluginId: surfaceContext.pluginId, id: actionLocalId, occurrenceId: 'occurrence-1', title: 'Update preview',
        dangerLevel, scopes: ['global'], surfaces: ['ui'],
        ...(dangerLevel === 'safe' ? {} : { confirmation: { title: 'Update preview?', body: 'This changes local state.' } }),
        available: true, execution: { target: 'daemon' },
    });
    const host = createPluginSurfaceActionHostApi({
        surfaceContext,
        resolveContributedAction: ({ pluginId, localId }) => pluginId === action.pluginId && localId === action.id ? action : null,
        interactionRequester: {
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            occurrenceId: 'occurrence-1',
            invocationId: 'surface_1',
        },
        ...(isCurrent ? { isCurrent } : {}),
        ...(lifetimeSignal ? { resourceLifetimeSignal: lifetimeSignal } : {}),
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
async function openedDialog(previous?: ReturnType<typeof modalHarness.readConfig>): Promise<void> {
    const opened = () => modalHarness.shown() && modalHarness.readConfig() !== previous;
    for (let attempt = 0; attempt < 10 && !opened(); attempt += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    if (!opened()) throw new Error('the confirmation dialog never opened');
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
    it('asks again after a declined Unlink and keeps the retry independent of the old dialog', async () => {
        const storage = getStorage();
        const previous = storage.getState();
        const localId = TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1;
        const actionId = `acme.preview/actions/${localId}`;
        const lifetime = new AbortController();
        const firstOperation = new AbortController();
        const { host, adapter } = createMountedSurface(undefined, 'safe', localId, lifetime.signal);
        const account = createTestkitCorpusCollections();
        const transport = createDirectTriageUnlinkTransport(account.collections, adapter.api);
        try {
            storage.setState(state => ({ ...state, settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                    actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
                }),
            } }));
            const target = { sessionId: 'session-1', entryRef: testkitEntryRef() };
            const linked = await linkEntryToSession({ collections: account.collections, ...target,
                display: { locator: { v: 1, displayPath: 'test#42' }, scopeLabel: 'test' }, nowMs: 1 });
            if (linked.status !== 'linked') throw new Error('Could not seed the real link owner');
            const declined = transport.unlink(target, { signal: firstOperation.signal });
            await openedDialog();
            const oldDialog = modalHarness.readConfig();
            oldDialog.props.onCancel();
            await expect(declined).resolves.toBeNull();
            expect(await account.collections.sessionLinks.get(linked.linkTag)).not.toBeNull();

            const retry = transport.unlink(target);
            let settled = false;
            void retry.then(() => { settled = true; }, () => { settled = true; });
            await openedDialog(oldDialog);
            // An exiting dialog can still deliver dismissal/unmount callbacks;
            // retiring the first operation must not withdraw the new question.
            oldDialog.onRequestClose();
            oldDialog.onHostUnmount();
            firstOperation.abort();
            await new Promise(resolve => { setTimeout(resolve, 0); });
            expect(settled).toBe(false);
            expect(await account.collections.sessionLinks.get(linked.linkTag)).not.toBeNull();
            expect(lifetime.signal.aborted).toBe(false);
            modalHarness.readConfig().props.onConfirm();
            await expect(retry).resolves.toEqual({ v: 1, status: 'unlinked' });
            expect(await account.collections.sessionLinks.get(linked.linkTag)).toBeNull();
        } finally {
            adapter.dispose();
            host.dispose?.();
            storage.setState(previous);
        }
    });
    it('refuses a direct writer when its bound mount lifetime has ended', async () => {
        const controller = new AbortController();
        const { host, adapter } = createMountedSurface(undefined, 'safe', 'update', controller.signal);
        const writes: string[] = [];
        try {
            controller.abort();
            const writing = (async () => {
                if (await adapter.api.admitAction('update')) writes.push('saved');
            })();
            await expect(writing).rejects.toMatchObject({ code: 'unavailable' });
            expect(writes).toEqual([]);
            expect(modalHarness.shown()).toBe(false);
        } finally {
            adapter.dispose();
            host.dispose?.();
        }
    });
    it.each(['off', 'ui_off', 'ask_first', 'allowed', 'default', 'decline', 'neighbour_off', 'agent_off'] as const)(
        'admits the real Account catalog writer without a daemon: %s', async (mode) => {
            const storage = getStorage();
            const previous = storage.getState();
            const localId = TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1;
            const actionId = `acme.preview/actions/${localId}`;
            const { host, adapter } = createMountedSurface(undefined, 'safe', localId);
            const account = createTestkitAccountKv();
            const transport = createDirectTriageActionsTransport(account.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), adapter.api);
            try {
                storage.setState(state => ({ ...state, settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({
                    v: 1,
                    actions: mode === 'neighbour_off' ? { 'acme.preview/actions/other': { enabled: false } } : {
                        [actionId]: mode === 'off' ? { enabled: false }
                            : mode === 'ui_off' ? { disabledSurfaces: ['ui'] }
                            : mode === 'agent_off' ? { disabledSurfaces: ['agent'] }
                            : mode === 'ask_first' || mode === 'decline' ? { approvalRequiredSurfaces: ['ui'] } : {},
                    },
                    ...(mode === 'allowed' || mode === 'off' || mode === 'ui_off' ? { approvalWaivedSurfaces: { [actionId]: ['ui'] } } : {}),
                }) } }));
                const before = await transport.read();
                const writing = transport.administer({ v: 1, kind: 'delete', actionId: before.actions[0]!.actionId, expectedRevision: before.revision });
                if (mode === 'off' || mode === 'ui_off') {
                    await expect(writing).rejects.toMatchObject({ code: 'denied' });
                } else {
                    if (mode === 'ask_first' || mode === 'decline') {
                        await openedDialog();
                        expect(account.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
                        if (mode === 'decline') modalHarness.readConfig().props.onCancel();
                        else modalHarness.readConfig().props.onConfirm();
                    }
                    if (mode === 'decline') await expect(writing).resolves.toBeNull();
                    else await expect(writing).resolves.toMatchObject({ status: 'applied' });
                }
                const written = mode !== 'off' && mode !== 'ui_off' && mode !== 'decline';
                expect(account.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) !== undefined).toBe(written);
                if (written) expect((await transport.read()).actions[0]?.enabled).toBe(false);
                if (mode !== 'ask_first' && mode !== 'decline') expect(modalHarness.shown()).toBe(false);
            } finally {
                adapter.dispose();
                host.dispose?.();
                storage.setState(previous);
            }
        },
    );
    it.each(['off_after_question', 'abort', 'retire'] as const)('keeps the Account writer inert after %s', async (mode) => {
        const storage = getStorage();
        const previous = storage.getState();
        const localId = TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1;
        const actionId = `acme.preview/actions/${localId}`;
        const { host, adapter } = createMountedSurface(undefined, 'safe', localId);
        const account = createTestkitAccountKv();
        const transport = createDirectTriageActionsTransport(account.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), adapter.api);
        const controller = new AbortController();
        try {
            storage.setState(state => ({ ...state, settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
            }) } }));
            const before = await transport.read();
            const writing = transport.administer({ v: 1, kind: 'delete', actionId: before.actions[0]!.actionId, expectedRevision: before.revision }, { signal: controller.signal });
            // Observe rejection immediately as well, so an abort cannot become an unhandled promise.
            const rejected = expect(writing).rejects.toMatchObject({ code: mode === 'off_after_question' ? 'denied' : mode === 'retire' ? 'stale_surface' : 'unavailable' });
            await openedDialog();
            if (mode === 'abort') controller.abort();
            else if (mode === 'retire') host.dispose?.();
            else {
                storage.setState(state => ({ ...state, settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                    actions: { [actionId]: { enabled: false } },
                }) } }));
                modalHarness.readConfig().props.onConfirm();
            }
            await rejected;
            expect(account.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
        } finally {
            adapter.dispose();
            host.dispose?.();
            storage.setState(previous);
        }
    });

    it.each([
        { mode: 'Action off', actionId: 'acme.preview/actions/update', override: { enabled: false }, admitted: false },
        { mode: 'UI audience off', actionId: 'acme.preview/actions/update', override: { disabledSurfaces: ['ui'] }, admitted: false },
        { mode: 'neighbour off', actionId: 'acme.preview/actions/other', override: { enabled: false }, admitted: true },
        { mode: 'other audience off', actionId: 'acme.preview/actions/update', override: { disabledSurfaces: ['agent'] }, admitted: true },
    ])('refuses a disabled Action before a waived daemonless direct write: $mode', async ({ actionId, override, admitted }) => {
        const storage = getStorage();
        const previous = storage.getState();
        const { host, adapter } = createMountedSurface();
        const writes: string[] = [];
        try {
            storage.setState(state => ({ ...state, settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                    actions: { [actionId]: override },
                    approvalWaivedSurfaces: { 'acme.preview/actions/update': ['ui'] },
                }),
            } }));
            const result = (async () => {
                if (await adapter.api.confirm('Update?', { action: 'update' })) writes.push('saved');
            })();
            if (admitted) await result;
            else await expect(result).rejects.toMatchObject({ code: 'denied' });
            expect(writes).toEqual(admitted ? ['saved'] : []);
            expect(modalHarness.shown()).toBe(false);
        } finally {
            adapter.dispose();
            host.dispose?.();
            storage.setState(previous);
        }
    });

    it('refuses an Action-bound direct write when its declaration is unavailable', async () => {
        const { adapter } = createMountedSurface();
        await expect(adapter.api.confirm('Update?', { action: 'missing' })).rejects.toMatchObject({ code: 'unavailable' });
        expect(modalHarness.shown()).toBe(false);
        adapter.dispose();
    });
    it('uses Action policy for direct UI writes: waiver skips, safe Ask-first asks and decline prevents the write', async () => {
        const storage = getStorage();
        const previous = storage.getState();
        const setPolicy = (required: boolean) => storage.setState(state => ({
            ...state, settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1(required
                ? { v: 1, actions: { 'acme.preview/actions/update': { approvalRequiredSurfaces: ['ui'] } } }
                : { v: 1, approvalWaivedSurfaces: { 'acme.preview/actions/update': ['ui'] } }) },
        }));
        try {
            setPolicy(false);
            const waived = createMountedSurface();
            const waivedResult = waived.adapter.api.confirm('Update?', { action: 'update' }).catch(error => error);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(modalHarness.shown()).toBe(false);
            await expect(waivedResult).resolves.toBe(true);
            waived.adapter.dispose();
            setPolicy(true);
            const required = createMountedSurface(undefined, 'safe');
            let written = false;
            const write = (async () => {
                if (await required.adapter.api.confirm('Update?', { action: 'update' })) written = true;
            })();
            await openedDialog();
            expect(written).toBe(false);
            modalHarness.readConfig().props.onCancel();
            await write;
            expect(written).toBe(false);
            required.adapter.dispose();
        } finally {
            storage.setState(previous);
        }
    });
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

    it('presents an Action confirmation through the plugin\'s admitted translation bundle', async () => {
        // The declaration carries `{ key, fallback }`. Reading `.fallback`
        // pinned every admitted plugin to its authored English wording, which
        // the projected bundle is the only authority able to replace.
        const requestCurrentIntent = createPluginActionCurrentIntentHandler({
            requester: {
                pluginId: 'acme.preview',
                contributionId: 'publish',
                occurrenceId: 'occurrence-1',
                invocationId: 'surface_1',
            },
            isCurrent: () => true,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                translationsByPluginId: {
                    'acme.preview': {
                        pluginId: 'acme.preview',
                        bundles: {
                            en: {
                                'acme.publish.title': 'Publish this preview?',
                                'acme.publish.body': 'It becomes visible to your team.',
                                'acme.publish.verb': 'Publish',
                            },
                        },
                    },
                },
            } as never,
        });

        const pending = requestCurrentIntent({
            action: {
                id: 'publish',
                pluginId: 'acme.preview',
                title: 'Publish',
                scopes: ['session'],
                surfaces: ['ui'],
                execution: { target: 'client' },
                dangerLevel: 'safe',
                available: true,
                confirmVerb: { key: 'acme.publish.verb', fallback: 'Post' },
                irreversible: true,
                confirmation: {
                    title: { key: 'acme.publish.title', fallback: 'Publish?' },
                    body: { key: 'acme.publish.body', fallback: 'Are you sure?' },
                },
            } as never,
            fingerprint: 'publish-1',
            input: {},
            surface: 'ui',
            invocationSurface: 'ui',
        });
        await openedDialog();

        expect(modalHarness.readConfig().chrome?.title).toBe('Publish this preview?');
        expect(modalHarness.show.mock.calls[0]?.[0]).toMatchObject({
            props: { description: 'It becomes visible to your team.', confirmLabel: 'Publish' },
        });
        modalHarness.readConfig().props.onConfirm();
        await expect(pending).resolves.toMatchObject({ status: 'approved' });
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
