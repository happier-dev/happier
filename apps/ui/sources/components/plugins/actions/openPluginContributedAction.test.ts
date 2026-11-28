import { readActionFailureDetails } from '@/dev/testkit/fixtures/actionFailureDetails';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginContributedActionController } from './pluginContributedActionController';

import type {
    PluginContributedActionController,
    PluginContributedActionDescriptor,
    PluginContributedActionForm,
    PluginContributedActionOpenOutcome,
} from './pluginContributedActionController';
import {
    openPluginContributedAction,
    openPluginContributedActionSessionReference,
} from './openPluginContributedAction';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('./ActionInputFormModal', () => ({
    ActionInputFormModal: () => null,
}));

function action(): PluginContributedActionDescriptor {
    return {
        identity: { pluginId: 'acme.channels', localId: 'configure' },
        qualifiedActionId: 'acme.channels/configure',
        title: 'Configure channels',
        description: null,
        icon: null,
        priority: 0,
        placement: 'primary',
        slash: null,
        scope: 'session',
        scopes: ['session'],
        inputHints: {
            fields: [{ path: 'endpoint', title: 'Endpoint', widget: 'url' }],
        },
        kind: 'form',
    };
}

function form(descriptor: PluginContributedActionDescriptor): PluginContributedActionForm {
    return {
        action: descriptor,
        presentation: {
            title: descriptor.title,
            description: descriptor.description,
            inputHints: descriptor.inputHints ?? { fields: [] },
        },
        getInput: () => ({}),
        replaceInput: () => {},
        isRetired: () => false,
        isSubmitting: () => false,
        getFields: () => [],
        subscribe: () => () => {},
        submit: async () => ({ kind: 'stale', reason: 'action_retired' }),
        cancel: () => {},
        retire: vi.fn(),
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('openPluginContributedAction', () => {
    it('presents the controller-owned form once and retires it when the current composer scope aborts', async () => {
        const descriptor = action();
        const actionForm = form(descriptor);
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn().mockResolvedValue({ kind: 'form', action: descriptor, form: actionForm }),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const abortController = new AbortController();
        const { Modal } = await import('@/modal');

        await openPluginContributedAction({
            controller,
            action: descriptor,
            signal: abortController.signal,
        });

        expect(Modal.show).toHaveBeenCalledTimes(1);
        const config = vi.mocked(Modal.show).mock.calls[0]?.[0] as unknown as Readonly<{
            props?: Readonly<{ form: PluginContributedActionForm; onRetire?: () => void }>;
            onRequestClose?: () => void;
        }>;
        expect(config.props?.form).toBe(actionForm);

        abortController.abort();

        expect(actionForm.retire).toHaveBeenCalledTimes(1);
        expect(Modal.hide).toHaveBeenCalledWith('modal-id');
        config.onRequestClose?.();
        config.props?.onRetire?.();
        expect(actionForm.retire).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unavailable', 'pluginRuntime.actionFailed'],
        ['machine_unavailable', 'errors.daemonUnavailableBody'],
    ] as const)('preserves a failed %s dispatch and uses its existing failure explanation', async (code, copyKey) => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn().mockResolvedValue({
                kind: 'direct',
                action: descriptor,
                outcome: { ok: false, code, reason: 'do-not-present-this' },
            }),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');

        await openPluginContributedAction({ controller, action: descriptor });

        expect(controller.open).toHaveBeenCalledWith(descriptor, undefined);
        expect(Modal.show).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalledWith(
            t('common.error'),
            t(copyKey),
            expect.any(Array),
        );
    });

    it.each([
        ['account', 'pluginRuntime.accountActivationRefused'],
        ['daemon', 'pluginSurfaces.originReason.activation_refused'],
    ] as const)('says a direct %s Action that could not start by its execution realm', async (executionTarget, copyKey) => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const, executionTarget };
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn().mockResolvedValue({
                kind: 'direct',
                action: descriptor,
                outcome: { ok: false, code: 'activation_failed', reason: 'activation_failed', layer: 'registration' },
            }),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');

        await openPluginContributedAction({ controller, action: descriptor });

        expect(vi.mocked(Modal.alert).mock.calls[0]?.[1]).toBe(t(copyKey));
    });

    it('keeps a settled plugin refusal code and issued request ID in shared technical details', async () => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        const requestId = 'message-action-refusal';
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn().mockResolvedValue({
                kind: 'direct',
                action: descriptor,
                outcome: { ok: false, code: 'credential_scope_denied', reason: 'credential_scope_denied',
                    message: 'Choose another credential', remediation: { kind: 'retry' }, requestId, effectAttempted: false,
                    failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null },
                    details: { requestId } },
            }),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');

        await openPluginContributedAction({ controller, action: descriptor });

        expect(vi.mocked(Modal.alert).mock.calls[0]?.[1]).toContain('Choose another credential');
        const buttons = vi.mocked(Modal.alert).mock.calls[0]?.[2];
        const technical = buttons?.find(button => button.text === t('approvals.technicalDetails'));
        expect(technical).toBeDefined();
        technical?.onPress?.();
        expect(readActionFailureDetails(vi.mocked(Modal.alert).mock.calls.at(-1)?.[1])).toEqual({
            code: 'credential_scope_denied', requestId, effectAttempted: 'false', causePhase: 'execution_authorization', errorClass: 'Error',
        });
    });

    it.each([
        ['stale', { kind: 'stale' as const, reason: 'action_retired' as const }, 'pluginRuntime.actionStale'],
        ['unavailable', { kind: 'unavailable' as const, reason: 'host_unavailable' as const }, 'pluginRuntime.actionUnavailable'],
    ] as const)('returns and surfaces a controller-owned %s outcome instead of silently dropping a picker selection', async (_kind, expected, copyKey) => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn().mockResolvedValue(expected),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');

        await expect(openPluginContributedAction({ controller, action: descriptor })).resolves.toEqual(expected);
        expect(Modal.alert).toHaveBeenCalledWith(
            t('common.error'),
            t(copyKey),
        );
    });

    it('presents an unexpected native presentation failure without exposing its raw error or claiming startup is pending', async () => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => null,
        });
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');
        // Native presentation is an external boundary; the real controller
        // normalizes an absent host before presentation begins.
        vi.mocked(Modal.alert).mockImplementationOnce(() => { throw new Error('private native details'); });

        await expect(openPluginContributedAction({ controller, action: descriptor })).resolves.toEqual({
            kind: 'unavailable', reason: 'host_unavailable',
        });
        expect(Modal.alert).toHaveBeenLastCalledWith(t('common.error'), t('pluginRuntime.actionOpenFailed'));
    });

    it('does not surface a direct outcome that arrives after the composer scope retires', async () => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        let resolveOpen: (outcome: PluginContributedActionOpenOutcome) => void = () => {
            throw new Error('expected controller.open to install its resolver');
        };
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn(() => new Promise<PluginContributedActionOpenOutcome>((resolve) => {
                resolveOpen = resolve;
            })),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const abortController = new AbortController();
        const { Modal } = await import('@/modal');

        const opening = openPluginContributedAction({
            controller,
            action: descriptor,
            signal: abortController.signal,
        });
        abortController.abort();
        resolveOpen({
            kind: 'direct',
            action: descriptor,
            outcome: { ok: false, code: 'unavailable', reason: 'retired_direct_action' },
        });
        await opening;

        expect(Modal.show).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it.each([
        ['success', { ok: true as const, result: { completed: true } }],
        ['failure', { ok: false as const, code: 'unavailable' as const, reason: 'known_failure' }],
        ['outcome unknown', { ok: false as const, code: 'timeout' as const, reason: 'plugin_ui_action_outcome_unknown' }],
    ] as const)('retains a settled direct %s outcome when the composer scope retires before presentation continues', async (_label, outcome) => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        const expected = {
            kind: 'direct' as const,
            action: descriptor,
            outcome,
        } satisfies PluginContributedActionOpenOutcome;
        const abortController = new AbortController();
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn(() => new Promise<PluginContributedActionOpenOutcome>((resolve) => {
                queueMicrotask(() => {
                    // `open()` has settled the canonical Action outcome before
                    // presentation learns that its composer scope retired.
                    resolve(expected);
                    abortController.abort();
                });
            })),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');

        await expect(openPluginContributedAction({
            controller,
            action: descriptor,
            signal: abortController.signal,
        })).resolves.toBe(expected);

        expect(abortController.signal.aborted).toBe(true);
        expect(Modal.show).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('keeps a true pre-dispatch composer abort stale without calling the Action controller', async () => {
        const descriptor = { ...action(), inputHints: null, kind: 'direct' as const };
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: vi.fn(),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
        } satisfies PluginContributedActionController;
        const abortController = new AbortController();
        abortController.abort();
        const { Modal } = await import('@/modal');

        await expect(openPluginContributedAction({
            controller,
            action: descriptor,
            signal: abortController.signal,
        })).resolves.toEqual({ kind: 'stale', reason: 'host_retired' });

        expect(controller.open).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('presents a form returned by the current session-reference controller without reconstructing its command', async () => {
        const descriptor = action();
        const actionForm = form(descriptor);
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => true,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: vi.fn().mockResolvedValue({ kind: 'form', action: descriptor, form: actionForm }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');
        const reference = { pluginId: 'acme.channels', localId: 'configure' };

        await expect(openPluginContributedActionSessionReference({
            controller,
            action: reference,
        })).resolves.toMatchObject({ kind: 'form', action: descriptor });

        expect(controller.openSessionReference).toHaveBeenCalledWith(reference, undefined, undefined);
        expect(Modal.show).toHaveBeenCalledTimes(1);
    });

    it('keeps a stale actionable-presentation source inert without presenting generic feedback', async () => {
        type PresentationReferenceParams = Parameters<typeof openPluginContributedActionSessionReference>[0] & Readonly<{
            showUnavailableFeedback?: boolean;
        }>;
        const openPresentationReference = openPluginContributedActionSessionReference as unknown as (
            params: PresentationReferenceParams,
        ) => Promise<PluginContributedActionOpenOutcome>;
        const controller = {
            list: () => [],
            listSlashCommands: () => [],
            open: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            isReferenceAvailable: () => false,
            isSessionReferenceAvailable: () => false,
            invokeReference: async () => ({ kind: 'stale' as const, reason: 'action_retired' as const }),
            openSessionReference: vi.fn().mockResolvedValue({
                kind: 'stale' as const,
                reason: 'action_retired' as const,
            }),
        } satisfies PluginContributedActionController;
        const { Modal } = await import('@/modal');

        await expect(openPresentationReference({
            controller,
            action: { pluginId: 'acme.channels', localId: 'configure' },
            showUnavailableFeedback: false,
        })).resolves.toEqual({ kind: 'stale', reason: 'action_retired' });

        expect(Modal.alert).not.toHaveBeenCalled();
    });
});
