import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import type {
    InteractionTransientQuestionV1,
    InteractionTransientRequestV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { flattenTestStyle } from '@/dev/testkit';

import {
    AppShellConfirmationDialog,
    AppShellQuestionDialog,
    createAppShellTransientInteractions,
    presentAppShellTransientInteraction,
} from './appShellQuestionInteractions';
import { DEFAULT_INVOCATION_TIMEOUT_MS } from './pluginUiInvocationHost';

function questionRequest(): Extract<InteractionTransientRequestV1, Readonly<{ kind: 'questions' }>> {
    return {
        requestId: 'question-request-1',
        scope: { kind: 'session', sessionId: 'session-1' },
        requester: {
            pluginId: 'acme.widgets',
            contributionId: 'run',
            generationId: 'generation-1',
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
            generationId: 'generation-1',
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
            generationId: 'generation-1',
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

describe('app-shell transient interaction presenter', () => {
    it('uses the Android physical 48dp target for every transient question and confirmation control', async () => {
        const { Platform } = await import('react-native');
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
            let confirmationTree!: renderer.ReactTestRenderer;
            await act(async () => {
                questionTree = renderer.create(<AppShellQuestionDialog
                    onClose={vi.fn()}
                    questions={questions}
                    onAnswer={vi.fn()}
                    onCancel={vi.fn()}
                />);
                confirmationTree = renderer.create(<AppShellConfirmationDialog
                    onClose={vi.fn()}
                    description="Proceed?"
                    confirmLabel="Confirm"
                    onConfirm={vi.fn()}
                    onCancel={vi.fn()}
                />);
            });

            for (const testID of [
                'app-shell-question-text-text',
                'app-shell-question-choice-choice-safe',
                'app-shell-question-choice-custom',
                'app-shell-question-cancel',
                'app-shell-question-submit',
            ]) {
                expect(flattenTestStyle(questionTree.root.findByProps({ testID }).props.style).minHeight).toBe(48);
            }
            for (const testID of ['app-shell-confirmation-cancel', 'app-shell-confirmation-confirm']) {
                expect(flattenTestStyle(confirmationTree.root.findByProps({ testID }).props.style).minHeight).toBe(48);
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

        expect(tree.root.findByProps({
            testID: 'app-shell-question-mode-choice-safe',
        }).props.accessibilityState).toEqual({ checked: true });
        expect(tree.root.findByProps({
            testID: 'app-shell-question-features-choice-voice',
        }).props.accessibilityState).toEqual({ checked: true });
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

            const safe = tree.root.findByProps({ testID: 'app-shell-question-mode-choice-safe' });
            const fast = tree.root.findByProps({ testID: 'app-shell-question-mode-choice-fast' });
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
            expect(tree.root.findByProps({
                testID: 'app-shell-question-mode-choice-safe',
            }).props.tabIndex).toBe(-1);
            expect(tree.root.findByProps({
                testID: 'app-shell-question-mode-choice-fast',
            }).props).toMatchObject({
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
            expect(tree.root.findByProps({
                testID: 'app-shell-question-mode-choice-safe',
            }).props).toMatchObject({
                accessibilityRole: 'radio',
                accessibilityState: { checked: false },
                onKeyDown: undefined,
                tabIndex: undefined,
            });
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('uses the host invocation deadline for present-user questions and never manufactures a Session', async () => {
        vi.useFakeTimers();
        try {
            const interactions = createAppShellTransientInteractions({
                requester: {
                    pluginId: 'acme.voice',
                    contributionId: 'elevenlabs',
                    generationId: 'generation-1',
                    invocationId: 'settings-invocation-1',
                },
                signal: new AbortController().signal,
                isCurrent: () => true,
                modal: createModalHarness().modal,
            });
            const pending = interactions.askQuestions({
                kind: 'questions',
                questions: [{ id: 'mode', prompt: 'Which mode?', type: 'text' }],
            });

            await vi.advanceTimersByTimeAsync(DEFAULT_INVOCATION_TIMEOUT_MS);
            await expect(pending).resolves.toEqual(expect.objectContaining({
                kind: 'questions',
                status: 'timedOut',
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
                generationId: 'generation-1',
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
