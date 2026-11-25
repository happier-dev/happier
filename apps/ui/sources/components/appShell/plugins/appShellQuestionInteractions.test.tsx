import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import type {
    InteractionTransientQuestionV1,
    InteractionTransientRequestV1,
} from '@happier-dev/protocol/plugins/interactions/transientV1';
import { describe, expect, it, vi } from 'vitest';
import { flattenTestStyle } from '@/dev/testkit';
import { t } from '@/text';

import {
    AppShellConfirmationDialog,
    AppShellQuestionDialog,
    createAppShellTransientInteractions,
    presentAppShellTransientInteraction,
} from './appShellQuestionInteractions';

function questionRequest(): Extract<InteractionTransientRequestV1, Readonly<{ kind: 'questions' }>> {
    return {
        requestId: 'question-request-1',
        scope: { kind: 'session', sessionId: 'session-1' },
        requester: {
            pluginId: 'acme.widgets',
            contributionId: 'run',
            occurrenceId: 'occurrence-1',
            invocationId: 'invocation-1',
        },
        createdAtMs: 100,
        expiresAtMs: 1_000,
        kind: 'questions',
        title: 'Choose',
        questions: [{
            id: 'decision',
            prompt: 'Continue?',
            type: 'singleChoice',
            required: true,
            allowCustom: false,
            choices: [{ id: 'continue', label: 'Continue' }],
        }],
    };
}

function confirmationRequest(): Extract<InteractionTransientRequestV1, Readonly<{ kind: 'confirmation' }>> {
    return {
        requestId: 'confirmation-request-1',
        scope: { kind: 'session', sessionId: 'session-1' },
        requester: {
            pluginId: 'acme.widgets',
            contributionId: 'run',
            occurrenceId: 'occurrence-1',
            invocationId: 'invocation-1',
        },
        createdAtMs: 100,
        expiresAtMs: 1_000,
        kind: 'confirmation',
        title: 'Create?',
        message: 'Creates an agent.',
    };
}

function approvalRequest(): Extract<InteractionTransientRequestV1, Readonly<{ kind: 'approval' }>> {
    return {
        requestId: 'approval-request-1',
        scope: { kind: 'session', sessionId: 'session-1' },
        requester: {
            pluginId: 'acme.widgets',
            contributionId: 'run',
            occurrenceId: 'occurrence-1',
            invocationId: 'invocation-1',
        },
        createdAtMs: 100,
        expiresAtMs: 1_000,
        kind: 'approval',
        title: 'Approve tool?',
        description: 'Runs a bounded tool operation.',
        subject: { kind: 'tool', name: 'status', input: { path: 'README.md' } },
    };
}

function createModalHarness(showId = 'question-modal') {
    let config: any = null;
    const modal = {
        show: vi.fn((next: any) => {
            config = next;
            return showId;
        }),
        hide: vi.fn(),
    };
    return { modal: modal as any, readConfig: () => config };
}

function readControlText(control: renderer.ReactTestInstance): string {
    return control.findAll((node) => typeof node.children[0] === 'string')
        .map((node) => node.children[0] as string)
        .join('');
}

/** The host node of a control: the shared pressable's props (checked, role) land on it. */
function host(tree: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance {
    return tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)[0]!;
}

describe('app-shell transient interaction presenter', () => {
    it('draws every transient question control at its design size', async () => {
        const { Platform } = await import('react-native');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const questions = [
                { id: 'text', prompt: 'Text', type: 'text' as const, required: false },
                {
                    id: 'choice',
                    prompt: 'Choice',
                    type: 'singleChoice' as const,
                    required: false,
                    allowCustom: true,
                    choices: [{ id: 'safe', label: 'Safe' }],
                },
            ] as const satisfies readonly InteractionTransientQuestionV1[];
            let questionTree!: renderer.ReactTestRenderer;
            await act(async () => {
                questionTree = renderer.create(<HappierUiPlatformProvider platform={{ platform: 'android', colorScheme: 'light' }}>
                    <AppShellQuestionDialog
                        onClose={vi.fn()}
                        questions={questions}
                        onAnswer={vi.fn()}
                        onCancel={vi.fn()}
                    />
                </HappierUiPlatformProvider>);
            });

            for (const testID of [
                'app-shell-question-text-text',
                'app-shell-question-choice-choice-safe',
                'app-shell-question-choice-custom',
                'app-shell-question-cancel',
                'app-shell-question-submit',
            ]) {
                expect(flattenTestStyle(host(questionTree, testID).props.style).minHeight).toBeUndefined();
            }
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('presents canonical text, single-choice, multiple-choice, and custom answers through one generic dialog', async () => {
        const onAnswer = vi.fn();
        const onClose = vi.fn();
        const questions = [
            { id: 'name', prompt: 'Name', type: 'text', required: true },
            {
                id: 'mode', prompt: 'Mode', type: 'singleChoice', required: true,
                allowCustom: false, choices: [{ id: 'safe', label: 'Safe' }],
            },
            {
                id: 'features', prompt: 'Features', type: 'multipleChoice', required: true,
                allowCustom: true, choices: [{ id: 'voice', label: 'Voice' }],
            },
        ] as const satisfies readonly InteractionTransientQuestionV1[];
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<AppShellQuestionDialog
                onClose={onClose}
                questions={questions}
                onAnswer={onAnswer}
                onCancel={vi.fn()}
            />);
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'app-shell-question-name-text' }).props.onChangeText('Happier');
            tree.root.findByProps({ testID: 'app-shell-question-mode-choice-safe' }).props.onPress();
            tree.root.findByProps({ testID: 'app-shell-question-features-choice-voice' }).props.onPress();
            tree.root.findByProps({ testID: 'app-shell-question-features-custom' }).props.onChangeText('Captions');
        });
        await act(async () => {
            tree.root.findByProps({ testID: 'app-shell-question-submit' }).props.onPress();
        });
        expect(onAnswer).toHaveBeenCalledWith({
            name: { kind: 'text', value: 'Happier' },
            mode: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'safe' } },
            features: {
                kind: 'multipleChoice',
                answers: [
                    { kind: 'choice', choiceId: 'voice' },
                    { kind: 'custom', value: 'Captions' },
                ],
            },
        });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows a visible selected mark in addition to checked semantics for each choice kind', async () => {
        const questions = [
            {
                id: 'mode',
                prompt: 'Choose a mode',
                type: 'singleChoice' as const,
                required: true,
                allowCustom: false,
                choices: [{ id: 'safe', label: 'Safe' }],
            },
            {
                id: 'features',
                prompt: 'Choose features',
                type: 'multipleChoice' as const,
                required: false,
                allowCustom: false,
                choices: [{ id: 'voice', label: 'Voice' }],
            },
        ] as const satisfies readonly InteractionTransientQuestionV1[];
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<AppShellQuestionDialog
                onClose={vi.fn()}
                questions={questions}
                onAnswer={vi.fn()}
                onCancel={vi.fn()}
            />);
        });

        expect(tree.root.findAllByProps({
            testID: 'app-shell-question-mode-choice-safe-selected-indicator',
        })).toHaveLength(0);
        expect(tree.root.findAllByProps({
            testID: 'app-shell-question-features-choice-voice-selected-indicator',
        })).toHaveLength(0);

        await act(async () => {
            tree.root.findByProps({ testID: 'app-shell-question-mode-choice-safe' }).props.onPress();
            tree.root.findByProps({ testID: 'app-shell-question-features-choice-voice' }).props.onPress();
        });

        expect(host(tree, 'app-shell-question-mode-choice-safe').props.accessibilityState).toMatchObject({ checked: true });
        expect(host(tree, 'app-shell-question-features-choice-voice').props.accessibilityState).toMatchObject({ checked: true });
        expect(tree.root.findByProps({
            testID: 'app-shell-question-mode-choice-safe-selected-indicator',
        }).props.name).toBe('check-circle');
        expect(tree.root.findByProps({
            testID: 'app-shell-question-features-choice-voice-selected-indicator',
        }).props.name).toBe('check-circle');
    });

    it('renders each question description and gives single-choice controls one named radio group', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'web';
        try {
            const questions = [{
                id: 'mode',
                prompt: 'Choose a mode',
                description: 'This controls the current invocation only.',
                type: 'singleChoice' as const,
                required: true,
                allowCustom: false,
                choices: [
                    { id: 'safe', label: 'Safe' },
                    { id: 'fast', label: 'Fast' },
                ],
            }] as const satisfies readonly InteractionTransientQuestionV1[];
            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<AppShellQuestionDialog
                    onClose={vi.fn()}
                    questions={questions}
                    onAnswer={vi.fn()}
                    onCancel={vi.fn()}
                />);
            });

            expect(tree.root.findByProps({
                testID: 'app-shell-question-mode-description',
            }).props.children).toBe('This controls the current invocation only.');
            expect(tree.root.findByProps({
                testID: 'app-shell-question-mode-group',
            }).props).toMatchObject({
                role: 'radiogroup',
                accessibilityLabel: 'Choose a mode',
                'aria-label': 'Choose a mode',
            });
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('uses one RNW roving radio tab stop and Arrow keys select the adjacent choice', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'web';
        try {
            const questions = [{
                id: 'mode',
                prompt: 'Choose a mode',
                type: 'singleChoice' as const,
                required: true,
                allowCustom: false,
                choices: [
                    { id: 'safe', label: 'Safe' },
                    { id: 'fast', label: 'Fast' },
                ],
            }] as const satisfies readonly InteractionTransientQuestionV1[];
            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<AppShellQuestionDialog
                    onClose={vi.fn()}
                    questions={questions}
                    onAnswer={vi.fn()}
                    onCancel={vi.fn()}
                />);
            });

            const safe = host(tree, 'app-shell-question-mode-choice-safe');
            const fast = host(tree, 'app-shell-question-mode-choice-fast');
            expect(safe.props.role).toBe('radio');
            expect(safe.props['aria-checked']).toBe(false);
            expect(safe.props.tabIndex).toBe(0);
            expect(fast.props.tabIndex).toBe(-1);

            const event = {
                key: 'ArrowRight',
                nativeEvent: { key: 'ArrowRight' },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            };
            await act(async () => {
                safe.props.onKeyDown(event);
            });

            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopPropagation).toHaveBeenCalledOnce();
            expect(host(tree, 'app-shell-question-mode-choice-safe').props.tabIndex).toBe(-1);
            expect(host(tree, 'app-shell-question-mode-choice-fast').props).toMatchObject({
                tabIndex: 0,
                'aria-checked': true,
                accessibilityState: { checked: true },
            });
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('preserves native radiogroup and checked-state semantics without web keyboard props', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'ios';
        try {
            const questions = [{
                id: 'mode',
                prompt: 'Choose a mode',
                type: 'singleChoice' as const,
                required: false,
                allowCustom: false,
                choices: [{ id: 'safe', label: 'Safe' }],
            }] as const satisfies readonly InteractionTransientQuestionV1[];
            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<AppShellQuestionDialog
                    onClose={vi.fn()}
                    questions={questions}
                    onAnswer={vi.fn()}
                    onCancel={vi.fn()}
                />);
            });

            expect(tree.root.findByProps({
                testID: 'app-shell-question-mode-group',
            }).props).toMatchObject({
                accessibilityRole: 'radiogroup',
                accessibilityLabel: 'Choose a mode',
                role: undefined,
            });
            expect(host(tree, 'app-shell-question-mode-choice-safe').props).toMatchObject({
                accessibilityRole: 'radio',
                accessibilityState: { checked: false },
                onKeyDown: undefined,
                tabIndex: undefined,
            });
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('keeps present-user questions available beyond the former deadline and never manufactures a Session', async () => {
        vi.useFakeTimers();
        try {
            const harness = createModalHarness();
            const interactions = createAppShellTransientInteractions({
                requester: {
                    pluginId: 'acme.voice',
                    contributionId: 'elevenlabs',
                    occurrenceId: 'occurrence-1',
                    invocationId: 'settings-invocation-1',
                },
                signal: new AbortController().signal,
                isCurrent: () => true,
                modal: harness.modal,
            });
            const pending = interactions.askQuestions({
                kind: 'questions',
                questions: [{ id: 'mode', prompt: 'Which mode?', type: 'text' }],
            });

            await vi.advanceTimersByTimeAsync(31_000);
            expect(harness.modal.hide).not.toHaveBeenCalled();
            harness.readConfig().props.onAnswer({ mode: { kind: 'text', value: 'slow answer' } });
            await expect(pending).resolves.toEqual(expect.objectContaining({
                kind: 'questions',
                status: 'answered',
                answers: { mode: { kind: 'text', value: 'slow answer' } },
            }));
        } finally {
            vi.useRealTimers();
        }
    });

    it('routes app-scope confirmations through the same stamped transient owner', async () => {
        const harness = createModalHarness();
        const interactions = createAppShellTransientInteractions({
            requester: {
                pluginId: 'acme.voice',
                contributionId: 'elevenlabs',
                occurrenceId: 'occurrence-1',
                invocationId: 'settings-invocation-1',
            },
            signal: new AbortController().signal,
            isCurrent: () => true,
            modal: harness.modal,
        });

        const pending = interactions.confirm({
            kind: 'confirmation',
            title: 'Continue?',
            message: 'Continue with the selected voice provider?',
        });
        await vi.waitFor(() => expect(harness.readConfig()).not.toBeNull());
        harness.readConfig().props.onConfirm();

        await expect(pending).resolves.toEqual(expect.objectContaining({
            kind: 'confirmation',
            status: 'approved',
        }));
    });

    it('returns a stamped questions candidate without normalizing or settling it', async () => {
        const harness = createModalHarness();
        const pending = presentAppShellTransientInteraction({
            request: questionRequest(),
            signal: new AbortController().signal,
            modal: harness.modal,
        });
        harness.readConfig().props.onAnswer({
            decision: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'continue' } },
        });
        await expect(pending).resolves.toEqual({
            requestId: 'question-request-1',
            kind: 'questions',
            status: 'answered',
            answers: {
                decision: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'continue' } },
            },
        });
        expect(harness.readConfig().chrome.title).toBe('Choose');
    });

    it('returns an exact unavailable candidate when the owner aborts presentation and ignores a late answer', async () => {
        const harness = createModalHarness();
        const controller = new AbortController();
        const pending = presentAppShellTransientInteraction({
            request: questionRequest(),
            signal: controller.signal,
            modal: harness.modal,
        });
        controller.abort();
        harness.readConfig().props.onAnswer({
            decision: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'continue' } },
        });
        await expect(pending).resolves.toEqual({
            requestId: 'question-request-1',
            kind: 'questions',
            status: 'unavailable',
        });
        expect(harness.modal.hide).toHaveBeenCalledWith('question-modal');
    });

    it('retains presenter exceptions through the app interaction owner', async () => {
        const harness = createModalHarness();
        const error = new TypeError('presenter failed');
        harness.modal.show.mockImplementation(() => { throw error; });
        const interactions = createAppShellTransientInteractions({
            requester: confirmationRequest().requester,
            signal: new AbortController().signal,
            isCurrent: () => true,
            modal: harness.modal,
        });
        await expect(interactions.confirm({ kind: 'confirmation', message: 'Continue?' })).rejects.toBe(error);
    });

    it('returns exact unavailable candidates when the modal host disappears or cannot present', async () => {
        const unmountHarness = createModalHarness();
        const unmounted = presentAppShellTransientInteraction({
            request: questionRequest(),
            signal: new AbortController().signal,
            modal: unmountHarness.modal,
        });
        unmountHarness.readConfig().onHostUnmount();
        await expect(unmounted).resolves.toEqual({
            requestId: 'question-request-1',
            kind: 'questions',
            status: 'unavailable',
        });

        const unavailableHarness = createModalHarness('');
        await expect(presentAppShellTransientInteraction({
            request: questionRequest(),
            signal: new AbortController().signal,
            modal: unavailableHarness.modal,
        })).resolves.toEqual({
            requestId: 'question-request-1',
            kind: 'questions',
            status: 'unavailable',
        });
    });

    // The confirmation's footer is the shared card footer: the dialog publishes it through its chrome.
    async function renderConfirmation(props: Partial<React.ComponentProps<typeof AppShellConfirmationDialog>> = {}) {
        let chrome: any = null;
        let body!: renderer.ReactTestRenderer;
        let footer!: renderer.ReactTestRenderer;
        await act(async () => {
            body = renderer.create(<AppShellConfirmationDialog
                onClose={vi.fn()}
                setChrome={(next) => { chrome = next; }}
                description="Removes recorded requests."
                confirmLabel="Clear capture"
                negative="cancel"
                destructive={false}
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
                {...props}
            />);
        });
        await act(async () => { footer = renderer.create(<>{chrome?.footer}</>); });
        return { body, footer };
    }

    function presentConfirmation(request: InteractionTransientRequestV1, presentationContext?: unknown) {
        const harness = createModalHarness();
        void presentAppShellTransientInteraction({
            request,
            signal: new AbortController().signal,
            modal: harness.modal,
            ...(presentationContext === undefined ? {} : { presentationContext }),
        });
        return harness.readConfig();
    }

    it('omits the body when it only repeats the title and keeps a distinct body', () => {
        const repeated = presentConfirmation({ ...confirmationRequest(), message: '  delete the captured  database activity? ' },
            { title: 'Delete the captured database activity?' });
        expect(repeated.chrome.title).toBe('Delete the captured database activity?');
        expect(repeated.props.description).toBeNull();

        const distinct = presentConfirmation(confirmationRequest());
        expect(distinct.chrome.title).toBe('Create?');
        expect(distinct.props.description).toBe('Creates an agent.');

        const untitled = presentConfirmation(confirmationRequest(), { title: null });
        expect(untitled.chrome.title).toBeUndefined();
        expect(untitled.props.description).toBe('Creates an agent.');
    });

    it('answers a confirmation the person started with Cancel and an approval with the decline', () => {
        expect(presentConfirmation(confirmationRequest()).props.negative).toBe('cancel');
        expect(presentConfirmation(approvalRequest()).props.negative).toBe('decline');
    });

    it('takes the destructive confirm only for a destructive Action and the metadata confirm label when present', () => {
        const destructive = presentConfirmation(confirmationRequest(), { confirmLabel: 'Clear capture', destructive: true });
        expect(destructive.props).toMatchObject({ destructive: true, confirmLabel: 'Clear capture' });
        const ordinary = presentConfirmation(confirmationRequest());
        expect(ordinary.props.destructive).toBe(false);
        expect(ordinary.props.confirmLabel).toBe(t('common.ok'));
    });

    it('draws the body only when present and the footer as Cancel then the Action verb', async () => {
        const shown = await renderConfirmation({ destructive: true });
        expect(shown.body.root.findAll((node) => node.props.testID === 'app-shell-confirmation-body' && typeof node.type === 'string')).toHaveLength(1);
        const cancel = shown.footer.root.findAll((node) => node.props.testID === 'app-shell-confirmation-decline')[0]!;
        expect(readControlText(cancel)).toBe(t('common.cancel'));
        const confirm = shown.footer.root.findAll((node) => node.props.testID === 'app-shell-confirmation-confirm' && node.props.display !== undefined)[0]!;
        expect(confirm.props.display).toBe('destructive');

        const quiet = await renderConfirmation({ description: null, negative: 'decline' });
        expect(quiet.body.root.findAll((node) => node.props.testID === 'app-shell-confirmation-body')).toHaveLength(0);
        expect(readControlText(quiet.footer.root.findAll((node) => node.props.testID === 'app-shell-confirmation-decline')[0]!)).toBe(t('common.decline'));
        const ordinary = quiet.footer.root.findAll((node) => node.props.testID === 'app-shell-confirmation-confirm' && node.props.display !== undefined)[0]!;
        expect(ordinary.props.display).toBe('default');
    });

    it('keeps the questions dialog naming its own control a cancel', async () => {
        let questionTree!: renderer.ReactTestRenderer;
        await act(async () => {
            questionTree = renderer.create(<AppShellQuestionDialog
                onClose={vi.fn()}
                questions={[{ id: 'text', prompt: 'Text', type: 'text', required: false }]}
                onAnswer={vi.fn()}
                onCancel={vi.fn()}
            />);
        });
        expect(readControlText(questionTree.root.findByProps({ testID: 'app-shell-question-cancel' }))).toBe(t('common.cancel'));
    });

    it('preserves canonical approval, decline, and user-cancel candidates', async () => {
        const confirmationHarness = createModalHarness();
        const declined = presentAppShellTransientInteraction({
            request: confirmationRequest(),
            signal: new AbortController().signal,
            modal: confirmationHarness.modal,
        });
        confirmationHarness.readConfig().props.onCancel();
        await expect(declined).resolves.toEqual({
            requestId: 'confirmation-request-1',
            kind: 'confirmation',
            status: 'declined',
        });

        const userCancelledHarness = createModalHarness();
        const userCancelled = presentAppShellTransientInteraction({
            request: confirmationRequest(),
            signal: new AbortController().signal,
            modal: userCancelledHarness.modal,
        });
        userCancelledHarness.readConfig().onRequestClose();
        await expect(userCancelled).resolves.toEqual({
            requestId: 'confirmation-request-1',
            kind: 'confirmation',
            status: 'userCancelled',
        });

        const approvalHarness = createModalHarness();
        const approved = presentAppShellTransientInteraction({
            request: approvalRequest(),
            signal: new AbortController().signal,
            modal: approvalHarness.modal,
        });
        approvalHarness.readConfig().props.onConfirm();
        await expect(approved).resolves.toEqual({
            requestId: 'approval-request-1',
            kind: 'approval',
            status: 'approved',
        });
        expect(approvalHarness.readConfig().chrome.title).toBe('Approve tool?');
    });
});
