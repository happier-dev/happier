import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { publishPresentationNotice, readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

import { createActionInputForm, type ActionInputForm, type ActionInputFormSubmissionResult } from './actionInputForm';
import { ActionInputFormModal } from './ActionInputFormModal';

const routerPush = vi.hoisted(() => vi.fn());

type RoundButtonProps = React.ComponentProps<typeof import('@/components/ui/buttons/RoundButton').RoundButton>;
type ChromeWithFooter = Readonly<{
    footer: React.ReactElement<React.PropsWithChildren>;
}>;

function findSubmitButton(chrome: ChromeWithFooter): React.ReactElement<RoundButtonProps> | undefined {
    return React.Children.toArray(chrome.footer.props.children)
        .find((child): child is React.ReactElement<RoundButtonProps> => (
            React.isValidElement<RoundButtonProps>(child)
            && child.props.testID === 'plugin-contributed-action-form-submit'
        ));
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPush }),
}));

function failedForm(): ActionInputForm {
    return {
        presentation: {
            title: 'Connect socket provider',
            description: null,
            inputHints: { fields: [] },
        },
        getInput: () => ({}),
        replaceInput: () => {},
        isRetired: () => false,
        isSubmitting: () => false,
        getFields: () => [],
        subscribe: () => () => {},
        submit: async () => ({ kind: 'settled', outcome: { ok: false } }),
        cancel: () => {},
        retire: () => {},
    };
}

function submittingForm(): ActionInputForm {
    return {
        ...failedForm(),
        isSubmitting: () => true,
    };
}

describe('ActionInputFormModal', () => {
    it('retains an authored repair message from a settled Action failure', async () => {
        const form = createActionInputForm({
            presentation: { title: 'Configure', description: null, inputHints: { fields: [] } },
            submit: async () => ({ ok: false, code: 'configuration_missing', message: 'Choose a configured connection.' }),
        });
        const setChrome = vi.fn();
        const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
        const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
        if (!submit) throw new Error('Expected form submit');
        await act(async () => { submit.props.onPress?.(); await Promise.resolve(); });
        expect(screen.getTextContent()).toContain('Choose a configured connection.');
    });

    it.each(['unavailable', 'settled'] as const)('retains the typed %s refusal in the shared diagnostic disclosure', async (kind) => {
        const form: ActionInputForm<ActionInputFormSubmissionResult, string, string> = {
            ...failedForm(),
            submit: async () => kind === 'unavailable'
                ? { kind: 'unavailable', reason: 'host_unavailable' }
                : { kind: 'settled', outcome: { ok: false, code: 'unavailable', phase: 'admission' } },
        };
        const setChrome = vi.fn();
        const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
        const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
        if (!submit) throw new Error('Expected form submit');
        await act(async () => { submit.props.onPress?.(); await Promise.resolve(); });
        const disclosure = screen.findByTestId('plugin-contributed-action-form-error-details');
        expect(disclosure).toBeDefined();
        await pressTestInstanceAsync(disclosure);
        expect(screen.getTextContent()).toContain(kind === 'unavailable' ? 'host_unavailable' : 'unavailable');
        if (kind === 'settled') expect(screen.getTextContent()).toContain('admission');
    });

    it('renders an external plugin declared default and submits an explicit switch override', async () => {
        const { createActionInputForm } = await import('./actionInputForm');
        const submit = vi.fn(async (_candidate: Readonly<Record<string, unknown>>) => ({ ok: true }));
        const form = createActionInputForm({
            presentation: {
                title: 'External plugin settings',
                description: null,
                inputHints: { fields: [{ path: 'enabled', title: 'Enabled', widget: 'boolean', defaultValue: true }] },
            },
            submit,
        });
        const setChrome = vi.fn();
        const anchor = { kind: 'rect', rect: { left: 12, top: 24, width: 100, height: 30 } } as const;
        const screen = await renderScreen(<ActionInputFormModal form={form} anchor={anchor} onClose={vi.fn()} setChrome={setChrome} />);
        expect(setChrome.mock.calls.at(-1)?.[0]).toMatchObject({ anchor, phonePresentation: 'sheet' });
        const control = () => screen.findAllByType('Pressable')
            .find((node) => (node.props.role ?? node.props.accessibilityRole) === 'switch');
        expect(control()?.props.accessibilityState?.checked).toBe(true);
        await pressTestInstanceAsync(control());
        expect(control()?.props.accessibilityState?.checked).toBe(false);
        await act(async () => { await form.submit(); });
        expect(submit.mock.calls[0]?.[0]).toEqual({ enabled: false });
    });

    it('keeps the cancellation action reachable while its canonical form owner is pending', async () => {
        const setChrome = vi.fn();
        const cancelForm = vi.fn();
        const onClose = vi.fn();
        const form = {
            ...submittingForm(),
            cancel: cancelForm,
        };
        await renderScreen(
            <ActionInputFormModal
                form={form}
                onClose={onClose}
                setChrome={setChrome}
            />,
        );

        // The shared card footer owns where Cancel sits; render it and read the buttons it actually draws.
        const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const footer = await renderScreen(chrome.footer);
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const button = (testID: string) => footer.findAllByType(RoundButton)
            .find((node) => node.props.testID === testID);
        const cancel = button('plugin-contributed-action-form-cancel');
        const submit = button('plugin-contributed-action-form-submit');
        if (!cancel || !submit) throw new Error('expected Action form footer actions');

        expect(cancel.props.disabled).not.toBe(true);
        expect(submit.props.disabled).toBe(true);
        expect(submit.props.loading).toBe(true);

        cancel.props.onPress?.();
        expect(cancelForm).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('announces an asynchronous form submission failure through the shared semantic validation feedback', async () => {
        const setChrome = vi.fn();
        const screen = await renderScreen(
            <ActionInputFormModal
                form={failedForm()}
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );
        const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const submit = findSubmitButton(chrome);
        if (!submit) throw new Error('expected submit action in modal chrome');

        await act(async () => {
            submit.props.onPress?.();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            const feedback = screen.findAllByTestId('plugin-contributed-action-form-error');
            expect(feedback.some((node) => (
                node.props.accessibilityRole === 'alert'
                && node.props.accessibilityLiveRegion === 'polite'
            ))).toBe(true);
        });
    });

    it('keeps a declined consent editable without announcing a submission failure', async () => {
        const form = createActionInputForm({
            presentation: failedForm().presentation,
            initialInput: { profileId: 'work' },
            submit: async () => ({ ok: false, cancelled: true } as const),
        });
        const setChrome = vi.fn();
        const onClose = vi.fn();
        const screen = await renderScreen(<ActionInputFormModal form={form} onClose={onClose} setChrome={setChrome} />);
        const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
        if (!submit) throw new Error('Expected real form submit');
        await act(async () => { submit.props.onPress?.(); await Promise.resolve(); });
        expect(screen.findAllByTestId('plugin-contributed-action-form-error')).toHaveLength(0);
        expect(onClose).not.toHaveBeenCalled();
        expect(form.getInput()).toEqual({ profileId: 'work' });
        await act(async () => { form.retire(); });
    });

    it.each([undefined, 'artifact'] as const)('presents the deciding source refusal with optional layer %s through the shared reason presenter', async (layer) => {
        const { createPluginAccountAvailabilityReaderStore } = await import('@/sync/domains/plugins/availability/reader');
        const { resolveReasonCopy } = await import('@/sync/domains/surfaces/copy/resolveReasonCopy');
        const scope = { serverId: 'form-home', accountId: 'form-account' };
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = store.bind(scope);
        const form = createActionInputForm({ presentation: failedForm().presentation, submit: async () => {
            const result = reader.readCurrentArtifact({ pluginId: 'acme.form', contributionId: 'run', tier: 'reactNative', platform: 'web' });
            if (result.kind !== 'unavailable') throw new Error('Expected missing selected slot');
            return { ok: false, code: result.code, ...(layer ? { layer } : {}), phase: 'admission' as const, retryable: false };
        } });
        const setChrome = vi.fn();
        const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
        const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
        if (!submit) throw new Error('Expected real form submit');
        await act(async () => { submit.props.onPress?.(); await Promise.resolve(); });
        expect(screen.getTextContent()).toContain(resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'artifact_not_current' }).body);
        await act(async () => { form.retire(); });
    });

    it('offers adding a Connected Account beside a Connected Account choice that already has accounts', async () => {
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Set up Discord Channels', description: null, choosesConnectedAccount: true, inputHints: { fields: [{
                path: 'credentialRef', title: 'Connected account', widget: 'select',
                options: [{ value: 'account-1', label: 'Happier QA Bot' }],
            }] } },
            submit: async () => ({ ok: true }),
        });
        try {
            const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
            const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
            const handoff = React.Children.toArray(chrome.footer.props.children)
                .find((child): child is React.ReactElement<RoundButtonProps> => (
                    React.isValidElement<RoundButtonProps>(child)
                    && child.props.testID === 'plugin-contributed-action-form-repair-connected-accounts'
                ));
            expect(handoff).toBeDefined();
            // The choice is not empty, so nothing says it is.
            expect(screen.findAllByTestId('plugin-contributed-action-form-connected-accounts-empty')).toHaveLength(0);
        } finally { await act(async () => { form.retire(); }); }
    });

    it('leads to connecting an account, and offers no submit, while the required account choice has none', async () => {
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Set up GitHub repository Event source', description: null, inputHints: { fields: [{
                path: 'credentialRef', title: 'GitHub account', widget: 'select', options: [], required: true,
                resolvedEmptyConnectedAccountOptions: true,
            }, { path: 'repository', title: 'Repository', widget: 'text', required: true }] } },
            initialInput: { repository: 'acme/widgets' },
            submit: async () => ({ ok: true }),
        });
        try {
            const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
            const footer = await renderScreen((setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter).footer);
            const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
            const button = (testID: string) => footer.findAllByType(RoundButton).find(node => node.props.testID === testID);
            expect(button('plugin-contributed-action-form-submit')).toBeUndefined();
            const connect = button('plugin-contributed-action-form-repair-connected-accounts');
            expect(connect?.props.display ?? 'default').toBe('default');
            expect(connect?.props.title).toBe('connectedServicesSetup.connectAccount');
            expect(screen.findAllByTestId('plugin-contributed-action-form-connected-accounts-empty')
                .find(node => node.props.message !== undefined)?.props.message)
                .toBe('connectedServicesSetup.accountNeededFirst');
            // The empty choice is not drawn: the line above says what it needs. The prefilled repository stays.
            expect(screen.getTextContent()).not.toContain('GitHub account');
            expect(screen.getTextContent()).toContain('Repository');
        } finally { await act(async () => { form.retire(); }); }
    });

    it('says under an empty required field that it is needed, and submits only once it is filled', async () => {
        const submit = vi.fn(async (_candidate: Readonly<Record<string, unknown>>) => ({ ok: true }));
        const form = createActionInputForm({
            presentation: { title: 'Leave a note', description: null, inputHints: { fields: [
                { path: 'note', title: 'Note', widget: 'text', required: true },
                { path: 'tone', title: 'Tone', widget: 'text' },
            ] } },
            submit,
        });
        const setChrome = vi.fn();
        try {
            const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
            const press = async () => {
                const button = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
                if (!button) throw new Error('Expected form submit');
                await act(async () => { button.props.onPress?.(); await Promise.resolve(); });
            };
            expect(screen.getTextContent()).not.toContain('pluginRuntime.requiredFieldMissing');
            await press();
            // The owner would refuse an empty required value: the form says so where it is, and sends nothing.
            expect(submit).not.toHaveBeenCalled();
            expect(screen.getTextContent()).toContain('pluginRuntime.requiredFieldMissing');
            await act(async () => { form.replaceInput({ ...form.getInput(), note: 'Ship it' }); });
            expect(screen.getTextContent()).not.toContain('pluginRuntime.requiredFieldMissing');
            await press();
            expect(submit.mock.calls[0]?.[0]).toMatchObject({ note: 'Ship it' });
        } finally { await act(async () => { form.retire(); }); }
    });

    it('closes on a settled Action and confirms it once through the notice host, never drawing its result', async () => {
        retirePresentationNotice();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Post a standup note', description: null, inputHints: { fields: [
                { path: 'note', title: 'Note', widget: 'text', required: true },
            ] } },
            initialInput: { note: 'Shipped the form' },
            submit: async () => ({ ok: true, result: { noteId: 'note-7f3a', body: 'Shipped the form' } }),
        });
        try {
            const screen = await renderScreen(<ActionInputFormModal form={form} onClose={onClose} setChrome={setChrome} />);
            const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
            await act(async () => { submit?.props.onPress?.(); await Promise.resolve(); });
            expect(onClose).toHaveBeenCalledOnce();
            expect(readPresentationNotice()).toMatchObject({
                severity: 'info', message: 'pluginRuntime.actionDone', emphasis: 'Post a standup note',
            });
            // No typed target reference: nothing to open.
            expect(readPresentationNotice()?.action).toBeUndefined();
            expect(screen.getTextContent()).not.toContain('note-7f3a');
        } finally {
            retirePresentationNotice();
            await act(async () => { form.retire(); });
        }
    });

    it.each([
        ['a selection that ran no Action', { ok: true }],
        ['an Action that is waiting for approval', { ok: true, result: { kind: 'approval_request_created' } }],
    ] as const)('closes on %s without saying it is done', async (_name, settled) => {
        retirePresentationNotice();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Choose a channel', description: null, inputHints: { fields: [] } },
            submit: async () => settled,
        });
        try {
            await renderScreen(<ActionInputFormModal form={form} onClose={onClose} setChrome={setChrome} />);
            const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
            await act(async () => { submit?.props.onPress?.(); await Promise.resolve(); });
            expect(onClose).toHaveBeenCalledOnce();
            expect(readPresentationNotice()).toBeNull();
        } finally { await act(async () => { form.retire(); }); }
    });

    it('leaves the notice the Action itself published (its Undo) in place of a second confirmation', async () => {
        retirePresentationNotice();
        const undo = { label: 'Undo', run: vi.fn() };
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Move widget', description: null, inputHints: { fields: [] } },
            submit: async () => {
                publishPresentationNotice({ key: 'widget-moved', severity: 'info', message: 'Widget moved', undo });
                return { ok: true, result: { moved: true } };
            },
        });
        try {
            await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
            const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
            await act(async () => { submit?.props.onPress?.(); await Promise.resolve(); });
            expect(readPresentationNotice()).toMatchObject({ key: 'widget-moved', undo });
        } finally {
            retirePresentationNotice();
            await act(async () => { form.retire(); });
        }
    });

    it.each([
        ['account', 'pluginRuntime.accountActivationRefused'],
        ['daemon', 'pluginSurfaces.originReason.activation_refused'],
    ] as const)('keeps a refused %s Action in the form, said by its execution realm', async (executionTarget, sentence) => {
        retirePresentationNotice();
        const onClose = vi.fn();
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Post a standup note', description: null, inputHints: { fields: [] }, executionTarget },
            submit: async () => ({ ok: false, code: 'activation_failed' }),
        });
        try {
            const screen = await renderScreen(<ActionInputFormModal form={form} onClose={onClose} setChrome={setChrome} />);
            const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
            await act(async () => { submit?.props.onPress?.(); await Promise.resolve(); });
            expect(onClose).not.toHaveBeenCalled();
            expect(readPresentationNotice()).toBeNull();
            expect(screen.getTextContent()).toContain(sentence);
            if (executionTarget === 'account') expect(screen.getTextContent()).not.toContain('originReason.activation_refused');
        } finally { await act(async () => { form.retire(); }); }
    });

    it('names a hosted setup with the host heading and continues with it', async () => {
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Set up GitHub repository Event source', description: 'Resolves a GitHub repository.',
                inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }] } },
            initialInput: { repository: 'acme/widgets' },
            submit: async () => ({ ok: true }),
        });
        try {
            await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome}
                heading={{ title: 'Deploy on push or merge', description: 'Deploys Staging.' }} />);
            const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter & Readonly<{ title?: string; subtitle?: string }>;
            expect(chrome).toMatchObject({ title: 'Deploy on push or merge', subtitle: 'Deploys Staging.' });
            const submit = findSubmitButton(chrome);
            expect(submit?.props.title).toBe('common.continue');
            expect(submit?.props.disabled).toBe(false);
        } finally { await act(async () => { form.retire(); }); }
    });

    it.each([null, { machineId: 'settings-machine', serverId: 'settings-home' }])(
        'repairs empty Connected Account options on the admitted form target %j', async pickerContext => {
            const { Modal } = await import('@/modal');
            const show = vi.spyOn(Modal, 'show').mockReturnValue('repair-connect');
            const setChrome = vi.fn();
            const onClose = vi.fn();
            routerPush.mockClear();
            const form = createActionInputForm({
                presentation: { title: 'Connect account', description: null, inputHints: { fields: [{
                    path: 'credentialRef', title: 'Connected account', widget: 'select', options: [], required: true,
                    resolvedEmptyConnectedAccountOptions: true,
                }] } },
                submit: async () => ({ ok: true }),
            });
            try {
                const screen = await renderScreen(<ActionInputFormModal form={form}
                    pickerContext={pickerContext ?? undefined} onClose={onClose} setChrome={setChrome} />);
                const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
                const repair = React.Children.toArray(chrome.footer.props.children)
                    .find((child): child is React.ReactElement<RoundButtonProps> => (
                        React.isValidElement<RoundButtonProps>(child)
                        && child.props.testID === 'plugin-contributed-action-form-repair-connected-accounts'
                    ));
                expect(screen.findAllByTestId('plugin-contributed-action-form-connected-accounts-empty')).not.toHaveLength(0);
                expect(repair).toBeDefined();
                await act(async () => { repair?.props.onPress?.(); });
                expect(form.isRetired()).toBe(true);
                expect(onClose).toHaveBeenCalledOnce();
                expect(show).toHaveBeenCalledOnce();
                expect(show.mock.calls[0]![0].props?.request.initialMachineTarget).toEqual(pickerContext
                    ? { serverIdentityId: pickerContext.serverId, machineId: pickerContext.machineId } : undefined);
                expect(routerPush).not.toHaveBeenCalled();
                show.mock.calls[0]![0].onRequestClose?.();
            } finally { show.mockRestore(); }
        },
    );
});
