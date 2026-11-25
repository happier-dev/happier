import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { TransientQuestionForm } from './TransientQuestionForm';
import { Modal, type CustomModalInjectedProps, type IModal } from '@/modal';
import { t } from '@/text';
import {
    composeAppShellInvocationSignal,
} from './pluginUiInvocationHost';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

const styles = StyleSheet.create((theme) => ({
    body: { maxHeight: 520, padding: theme.space.s16, gap: theme.space.s16 },
    // Card chrome pads only its header and footer; the body aligns with the title's edge.
    confirmationBody: { paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
    prompt: { color: theme.colors.text.primary },
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
    /** The producer's decision that the confirmed Action destroys something (its danger level or irreversibility). */
    destructive?: true;
}>;

function readConfirmationPresentation(
    value: unknown,
): AppShellTransientConfirmationPresentation | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    const confirmLabel = record.confirmLabel;
    const title = record.title;
    const hasTitle = title === null || (typeof title === 'string' && title.trim().length > 0);
    const destructive = record.destructive === true;
    return (
        (typeof confirmLabel === 'string' && confirmLabel.trim().length > 0) || hasTitle || destructive
    )
        ? Object.freeze({
            ...(typeof confirmLabel === 'string' && confirmLabel.trim().length > 0 ? { confirmLabel } : {}),
            ...(hasTitle ? { title: title as string | null } : {}),
            ...(destructive ? { destructive: true as const } : {}),
        })
        : null;
}

function normalizeSentence(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** A body that only repeats the heading says nothing new, so the card shows the heading alone. */
function readConfirmationBody(description: string, title: string | undefined): string | null {
    if (description.trim().length === 0) return null;
    return title !== undefined && normalizeSentence(description) === normalizeSentence(title) ? null : description;
}

type ConfirmationDialogProps = CustomModalInjectedProps & Readonly<{
    /** The consequence under the title; `null` when there is none beyond the title. */
    description: string | null;
    confirmLabel: string;
    /**
     * `cancel` for a confirmation the person started themselves; `decline` when they answer someone
     * else's request (an approval), where the negative is a decision the requester acts on.
     */
    negative: 'cancel' | 'decline';
    destructive: boolean;
    onConfirm(): void;
    onCancel(): void;
}>;

/** The shared confirmation card: title in the chrome, the consequence once, then Cancel and the Action's verb. */
export function AppShellConfirmationDialog(props: ConfirmationDialogProps): React.ReactElement | null {
    const { onCancel, onConfirm, onClose, setChrome, negative, confirmLabel, destructive } = props;
    React.useEffect(() => {
        setChrome?.({
            kind: 'card',
            footer: (
                <ModalCardFooterActions cancel={{
                    testID: 'app-shell-confirmation-decline',
                    title: negative === 'decline' ? t('common.decline') : t('common.cancel'),
                    onPress: () => { onCancel(); onClose(); },
                }}>
                    <RoundButton
                        testID="app-shell-confirmation-confirm"
                        size="normal"
                        display={destructive ? 'destructive' : 'default'}
                        title={confirmLabel}
                        onPress={() => { onConfirm(); onClose(); }}
                    />
                </ModalCardFooterActions>
            ),
        });
    }, [confirmLabel, destructive, negative, onCancel, onClose, onConfirm, setChrome]);
    if (props.description === null) return null;
    return (
        <View style={styles.confirmationBody}>
            <Text testID="app-shell-confirmation-body" variant="body" style={styles.prompt}>{props.description}</Text>
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
            const title = presentation && Object.prototype.hasOwnProperty.call(presentation, 'title')
                ? presentation.title ?? undefined
                : request.title;
            const description = readConfirmationBody(request.kind === 'confirmation'
                ? request.message
                : request.description ?? request.subject.name, title);
            modalId = modal.show({
                component: AppShellConfirmationDialog,
                props: {
                    description,
                    confirmLabel: presentation?.confirmLabel ?? t('common.ok'),
                    negative: request.kind === 'approval' ? 'decline' : 'cancel',
                    destructive: presentation?.destructive === true,
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
                    // The same presentation as the native Action confirmation: a bottom sheet on a phone.
                    phonePresentation: 'sheet',
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
