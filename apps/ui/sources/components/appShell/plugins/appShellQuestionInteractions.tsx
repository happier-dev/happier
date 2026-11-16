import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierPressable,
} from '@happier-dev/plugin-ui/presentation';
import { createTransientInteractionOwner } from '@happier-dev/protocol/plugins/interactions/owner';
import type {
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionAnswerV1,
    InteractionTransientQuestionV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionTransientRequestV1,
    InteractionTransientRequesterV1,
    InteractionTransientResultV1,
} from '@happier-dev/protocol/plugins/interactions/transientV1';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { TransientQuestionForm } from './TransientQuestionForm';
import { Modal, type CustomModalInjectedProps, type IModal } from '@/modal';
import { t } from '@/text';
import {
    composeAppShellInvocationSignal,
} from './pluginUiInvocationHost';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

const styles = StyleSheet.create((theme) => ({
    body: { maxHeight: 520, padding: theme.space.s16, gap: theme.space.s16 },
    prompt: { color: theme.colors.text.primary, ...Typography.variant('label', 'regular') },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.space.s10 },
    action: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8, justifyContent: 'center' },
    actionText: { color: theme.colors.text.link, ...Typography.variant('label') },
}));

type QuestionDialogProps = CustomModalInjectedProps & Readonly<{
    questions: readonly InteractionTransientQuestionV1[];
    onAnswer(answers: Readonly<Record<string, InteractionTransientQuestionAnswerV1>>): void;
    onCancel(): void;
}>;

export function AppShellQuestionDialog(props: QuestionDialogProps): React.ReactElement {
    return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <TransientQuestionForm questions={props.questions}
                onAnswer={(answers) => { props.onAnswer(answers); props.onClose(); }}
                onCancel={() => { props.onCancel(); props.onClose(); }} />
        </ScrollView>
    );
}

type QuestionModal = Pick<IModal, 'show' | 'hide'>;

/** Host-private chrome only; it never changes the stamped Interaction request. */
type AppShellTransientConfirmationPresentation = Readonly<{
    confirmLabel?: string;
    /** `null` preserves an author request that intentionally omitted a heading. */
    title?: string | null;
}>;

function readConfirmationPresentation(
    value: unknown,
): AppShellTransientConfirmationPresentation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const confirmLabel = record.confirmLabel;
    const title = record.title;
    const hasTitle = title === null || (typeof title === 'string' && title.trim().length > 0);
    return (
        (typeof confirmLabel === 'string' && confirmLabel.trim().length > 0) || hasTitle
    )
        ? Object.freeze({
            ...(typeof confirmLabel === 'string' && confirmLabel.trim().length > 0 ? { confirmLabel } : {}),
            ...(hasTitle ? { title: title as string | null } : {}),
        })
        : null;
}

type ConfirmationDialogProps = CustomModalInjectedProps & Readonly<{
    description: string;
    confirmLabel: string;
    onConfirm(): void;
    onCancel(): void;
}>;

export function AppShellConfirmationDialog(props: ConfirmationDialogProps): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={styles.body}>
            <Text style={styles.prompt}>{props.description}</Text>
            <View style={styles.actions}>
                {/*
                  * This control settles `declined` — an explicit negative
                  * DECISION the requester acts on — while dismissing the dialog
                  * settles `userCancelled`. Labelling it "Cancel" told the user
                  * it did the same thing as walking away, so it names the
                  * decision it actually makes.
                  */}
                <HappierPressable
                    testID="app-shell-confirmation-decline"
                    accessibilityRole="button"
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onCancel(); props.onClose(); }}
                    style={styles.action}
                >
                    <Text style={styles.actionText}>{t('common.decline')}</Text>
                </HappierPressable>
                <HappierPressable
                    testID="app-shell-confirmation-confirm"
                    accessibilityRole="button"
                    hitReach={{ left: theme.space.s10 / 2, right: theme.space.s10 / 2 }}
                    onPress={() => { props.onConfirm(); props.onClose(); }}
                    style={styles.action}
                >
                    <Text style={styles.actionText}>{props.confirmLabel}</Text>
                </HappierPressable>
            </View>
        </View>
    );
}

function unavailableCandidate(request: InteractionTransientRequestV1): InteractionTransientResultV1 {
    if (request.kind === 'questions') {
        return Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'unavailable' });
    }
    if (request.kind === 'approval') {
        return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'unavailable' });
    }
    return Object.freeze({ requestId: request.requestId, kind: 'confirmation', status: 'unavailable' });
}

function userCancelledCandidate(request: InteractionTransientRequestV1): InteractionTransientResultV1 {
    if (request.kind === 'questions') {
        return Object.freeze({ requestId: request.requestId, kind: 'questions', status: 'userCancelled' });
    }
    if (request.kind === 'approval') {
        return Object.freeze({ requestId: request.requestId, kind: 'approval', status: 'userCancelled' });
    }
    return Object.freeze({ requestId: request.requestId, kind: 'confirmation', status: 'userCancelled' });
}

/**
 * Presentation-only adapter for a request already normalized and stamped by
 * the current-Session interaction owner. It returns a candidate; that owner
 * alone validates currentness and settles the interaction lifecycle.
 */
export async function presentAppShellTransientInteraction(input: Readonly<{
    request: InteractionTransientRequestV1;
    signal: AbortSignal;
    modal?: QuestionModal;
    presentationContext?: unknown;
}>): Promise<InteractionTransientResultV1> {
    if (input.signal.aborted) return unavailableCandidate(input.request);
    const modal = input.modal ?? Modal;
    return await new Promise<InteractionTransientResultV1>((resolve) => {
        let modalId = '';
        const complete = (candidate: InteractionTransientResultV1, hide = false) => {
            input.signal.removeEventListener('abort', abort);
            if (hide && modalId) modal.hide(modalId);
            resolve(candidate);
        };
        const abort = () => complete(unavailableCandidate(input.request), true);
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) {
            abort();
            return;
        }

        if (input.request.kind === 'questions') {
            const request = input.request;
            modalId = modal.show({
                component: AppShellQuestionDialog,
                props: {
                    questions: request.questions,
                    onAnswer: (answers) => complete({
                        requestId: request.requestId,
                        kind: 'questions',
                        status: 'answered',
                        answers: { ...answers },
                    }),
                    onCancel: () => complete(userCancelledCandidate(request)),
                },
                onRequestClose: () => complete(userCancelledCandidate(request)),
                onHostUnmount: () => complete(unavailableCandidate(request)),
                chrome: {
                    kind: 'card',
                    title: request.title ?? t('tools.askUserQuestion.submit'),
                    testID: 'app-shell-question-dialog',
                    bodyScroll: 'auto',
                    dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.85, size: 'dialog' },
                },
                closeOnBackdrop: true,
            });
        } else {
            const request = input.request;
            const presentation = readConfirmationPresentation(input.presentationContext);
            const description = request.kind === 'confirmation'
                ? request.message
                : request.description ?? request.subject.name;
            const title = presentation && Object.prototype.hasOwnProperty.call(presentation, 'title')
                ? presentation.title ?? undefined
                : request.title;
            modalId = modal.show({
                component: AppShellConfirmationDialog,
                props: {
                    description,
                    confirmLabel: presentation?.confirmLabel ?? t('common.ok'),
                    onConfirm: () => complete(request.kind === 'approval'
                        ? { requestId: request.requestId, kind: 'approval', status: 'approved' }
                        : { requestId: request.requestId, kind: 'confirmation', status: 'approved' }),
                    onCancel: () => complete(request.kind === 'approval'
                        ? { requestId: request.requestId, kind: 'approval', status: 'declined' }
                        : { requestId: request.requestId, kind: 'confirmation', status: 'declined' }),
                },
                onRequestClose: () => complete(userCancelledCandidate(request)),
                onHostUnmount: () => complete(unavailableCandidate(request)),
                chrome: {
                    kind: 'card',
                    ...(title === undefined ? {} : { title }),
                    testID: 'app-shell-transient-interaction-dialog',
                    dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.7, size: 'dialog' },
                },
                closeOnBackdrop: true,
            });
        }
        if (!modalId) complete(unavailableCandidate(input.request));
    });
}

/**
 * Thin present-user app adapter over the Protocol lifecycle owner. The active
 * app-shell invocation supplies identity, cancellation and currentness; the
 * Protocol owner settles the interaction on its lifecycle or the user's answer.
 */
export function createAppShellTransientInteractions(input: Readonly<{
    requester: InteractionTransientRequesterV1;
    signal: AbortSignal;
    isCurrent(): boolean;
    modal?: QuestionModal;
}>): Readonly<{
    askQuestions(
        request: InteractionTransientQuestionsAuthorRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<InteractionTransientQuestionsResultV1>;
    confirm(
        request: InteractionTransientConfirmationAuthorRequestV1,
        options?: Readonly<{
            signal?: AbortSignal;
            presentationContext?: unknown;
        }>,
    ): Promise<InteractionTransientConfirmationResultV1>;
}> {
    const owner = createTransientInteractionOwner({
        scope: Object.freeze({ kind: 'app' }),
        isOccurrenceCurrent: input.isCurrent,
        deadlineMs: null,
        // Dispatch owns the typed, content-free failure projection. Do not turn
        // a broken presenter into an unexplained availability refusal first.
        propagatePresentationError: () => true,
        present: async (request, options) => await presentAppShellTransientInteraction({
            request,
            signal: options.signal,
            ...(input.modal ? { modal: input.modal } : {}),
            ...(options.presentationContext === undefined
                ? {}
                : { presentationContext: options.presentationContext }),
        }),
    });
    return Object.freeze({
        async askQuestions(request, options) {
            const operation = composeAppShellInvocationSignal(input.signal, options?.signal);
            try {
                const result = await owner.request(request, {
                    requester: input.requester,
                    signal: operation.signal,
                });
                if (result.kind !== 'questions') {
                    throw new Error('Transient interaction owner returned an incompatible question result');
                }
                return result;
            } finally {
                operation.dispose();
            }
        },
        async confirm(request, options) {
            const operation = composeAppShellInvocationSignal(input.signal, options?.signal);
            try {
                const result = await owner.request(request, {
                    requester: input.requester,
                    signal: operation.signal,
                    ...(options?.presentationContext === undefined
                        ? {}
                        : { presentationContext: options.presentationContext }),
                });
                if (result.kind !== 'confirmation') {
                    throw new Error('Transient interaction owner returned an incompatible confirmation result');
                }
                return result;
            } finally {
                operation.dispose();
            }
        },
    });
}
