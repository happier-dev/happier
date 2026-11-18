import * as React from 'react';
import { Platform, View } from 'react-native';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { runUnsavedChangesGuard, type ActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

import {
    useSessionBoardNoteEditor,
    type SessionBoardNoteEditorInput,
} from './useSessionBoardNoteEditor';
import { resolveSessionBoardFailurePresentation } from '../sessionBoardFailurePresentation';

/**
 * The person-authored Note card: **Add → Note**.
 *
 * It is one editing card at the chosen insertion point — a title field, the app's
 * existing markdown editor, and Cancel/Save. It implements no second markdown
 * editor and no Board-local leave guard: the body is
 * {@link MarkdownCodeEditorField} with its own raw/rich eligibility and unavailable
 * fallback, and leaving with unsaved work runs the incumbent
 * {@link useUnsavedChangesBeforeRemoveGuard}.
 *
 * The saved document is the ordinary `source.kind='declarative'` markdown note
 * subset, so it uses the same Board access, Session key, CAS and convergence as
 * every other item. There is no note table and no rich-text platform here.
 */

const stylesheet = StyleSheet.create((theme) => ({
    titleInput: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        paddingVertical: theme.space.s6,
    },
    body: {
        minHeight: 180,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
        paddingTop: theme.space.s8,
    },
    footer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: theme.space.s12,
    },
    notice: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 160,
    },
    noticeAlert: {
        color: theme.colors.state.danger.textForeground,
    },
    review: {
        marginTop: theme.space.s12,
        paddingTop: theme.space.s12,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
        gap: theme.space.s6,
    },
    reviewHeading: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
}));

export type SessionBoardNoteEditorCardProps = Omit<SessionBoardNoteEditorInput, 'flushBody'> & Readonly<{
    /** The current record's body, shown read-only beside the draft after a conflict. */
    latestBody?: string | null;
    onCancel: () => void;
    /** Web routes enable the before-remove guard; panes call {@link onCancel} through it. */
    guardNavigation?: boolean;
    /** Lets sibling Board controls and nested Back use this same draft guard. */
    onGuardChange?: ((guardedTransition: ((transition: () => void | Promise<void>) => Promise<boolean>) | null) => void);
    /** Registers the lossless active→retained editor handoff with the Session owner. */
    onContinuityFlushChange?: ((flush: (() => void | Promise<void>) | null) => void);
    testID?: string;
}>;

export function SessionBoardNoteEditorCard(props: SessionBoardNoteEditorCardProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const testID = props.testID ?? 'session-board-note-editor';
    const navigation = useNavigation();
    const editorHandleRef = React.useRef<CodeEditorHandle | null>(null);
    // Flush the debounced surface, then read the value it actually holds. Returning
    // it — rather than relying on the state update the flush schedules — is what
    // keeps the final keystroke out of the gap between the press and the write.
    const flushBody = React.useCallback(async (): Promise<string | null> => {
        const handle = editorHandleRef.current;
        if (!handle) return null;
        await handle.flushPendingChange?.();
        return typeof handle.getValue === 'function' ? handle.getValue() : null;
    }, []);

    const editor = useSessionBoardNoteEditor({ ...props, flushBody });
    const { save } = editor;
    const requestSave = React.useCallback(() => {
        fireAndForget(save(), { tag: 'SessionBoardNoteEditorCard.save' });
    }, [save]);

    const requestDecision = React.useCallback(
        () => promptUnsavedChangesAlert(
            (title, message, buttons) => Modal.alert(title, message, buttons),
            {
                title: t('common.discardChanges'),
                message: t('common.unsavedChangesWarning'),
                discardText: t('common.discard'),
                saveText: t('common.save'),
                keepEditingText: t('common.keepEditing'),
            },
        ),
        [],
    );

    const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef: editor.dirtyRef,
        requestDecision,
        prepareGuard: editor.flushToContinuity,
        onSave: () => save(),
        tag: 'SessionBoardNoteEditorCard',
    }), [editor.dirtyRef, editor.flushToContinuity, requestDecision, save]);

    const prepareGuard = editor.flushToContinuity;

    const runGuardedTransition = React.useCallback(async (transition: () => void | Promise<void>): Promise<boolean> => {
        return await Promise.resolve(runUnsavedChangesGuard(guard, transition));
    }, [guard]);

    React.useEffect(() => {
        props.onGuardChange?.(runGuardedTransition);
        return () => props.onGuardChange?.(null);
    }, [props.onGuardChange, runGuardedTransition]);
    React.useEffect(() => {
        props.onContinuityFlushChange?.(editor.flushToContinuity);
        return () => props.onContinuityFlushChange?.(null);
    }, [editor.flushToContinuity, props.onContinuityFlushChange]);

    // Cancelling an untouched draft creates nothing and asks nothing.
    const requestCancel = React.useCallback(() => {
        void runGuardedTransition(props.onCancel);
    }, [props.onCancel, runGuardedTransition]);

    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.draftClear,
        enabled: true,
        allowEditableTarget: true,
        onEscape: () => {
            requestCancel();
            return true;
        },
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
            event.preventDefault();
            event.stopPropagation();
            requestSave();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [requestSave]);

    const continueNavigation = React.useCallback((action: unknown) => {
        props.onCancel();
        if (!action) return;
        (navigation as { dispatch?: (nextAction: unknown) => void } | null)?.dispatch?.(action);
    }, [navigation, props.onCancel]);

    useUnsavedChangesBeforeRemoveGuard({
        enabled: props.guardNavigation === true,
        isDirty: editor.dirty,
        isDirtyRef: editor.dirtyRef,
        requestDecision,
        onSave: () => save(),
        prepareGuard,
        // The embedded editor may own a debounced value before `editor.dirty`
        // changes. Intercept first, flush it, then let the shared dirty ref decide
        // whether to prompt or continue without friction.
        interceptWhenClean: true,
        onContinue: continueNavigation,
        tag: 'SessionBoardNoteEditorCard.beforeRemove',
    });

    const status = editor.status;
    const notice = ((): Readonly<{ text: string; alert: boolean }> | null => {
        if (!props.reachable) {
            const presentation = resolveSessionBoardFailurePresentation('offline');
            return { text: presentation.message, alert: presentation.severity === 'error' };
        }
        switch (status.kind) {
            case 'conflict': {
                const presentation = resolveSessionBoardFailurePresentation('session_board_revision_conflict');
                return { text: presentation.message, alert: presentation.severity === 'error' };
            }
            case 'outcomeUnknown': {
                const presentation = resolveSessionBoardFailurePresentation('outcome_unknown');
                return { text: presentation.message, alert: presentation.severity === 'error' };
            }
            case 'invalid': {
                // The builder refused the draft before any write. The text is
                // still here and Save stays available once it is shortened.
                const presentation = resolveSessionBoardFailurePresentation(status.error);
                return { text: presentation.message, alert: presentation.severity === 'error' };
            }
            case 'approvalPending':
                return { text: resolveSessionBoardFailurePresentation('approval_required').message, alert: false };
            case 'unavailable': {
                const presentation = resolveSessionBoardFailurePresentation(status.reason);
                return { text: presentation.message, alert: presentation.severity === 'error' };
            }
            case 'failed': {
                const presentation = resolveSessionBoardFailurePresentation(status.error);
                return { text: presentation.message, alert: presentation.severity === 'error' };
            }
            case 'editing':
            case 'saving':
                return null;
        }
    })();

    const showReview = status.kind === 'conflict'
        && (status.reviewed || editor.canReviewLatest)
        && props.latestBody !== null
        && props.latestBody !== undefined;

    return (
        <SurfaceCard testID={testID} padding="md">
            <TextInput
                testID={`${testID}-title`}
                style={styles.titleInput}
                value={editor.title}
                onChangeText={editor.setTitle}
                autoFocus
                returnKeyType="next"
                blurOnSubmit={false}
                placeholder={t('sessionBoard.note.titlePlaceholder')}
                placeholderTextColor={theme.colors.text.secondary}
                accessibilityLabel={t('sessionBoard.note.titleA11y')}
                onSubmitEditing={() => editorHandleRef.current?.focus?.()}
                onKeyPress={(event) => {
                    const nativeEvent = event.nativeEvent as typeof event.nativeEvent & {
                        metaKey?: boolean;
                        ctrlKey?: boolean;
                    };
                    if (nativeEvent.key === 'Enter' && (nativeEvent.metaKey || nativeEvent.ctrlKey)) {
                        event.preventDefault?.();
                        event.stopPropagation?.();
                        requestSave();
                    }
                }}
            />
            <View style={styles.body}>
                <MarkdownCodeEditorField
                    testID={`${testID}-body`}
                    value={editor.body}
                    onChange={editor.setBody}
                    resetKey={`session-board-note:${props.itemId}`}
                    language="markdown"
                    editorRef={editorHandleRef}
                />
            </View>
            {showReview ? (
                <View style={styles.review} testID={`${testID}-review`}>
                    <Text style={styles.reviewHeading}>{t('sessionBoard.note.conflict.latestHeading')}</Text>
                    <MarkdownView markdown={props.latestBody!} />
                </View>
            ) : null}
            <View style={styles.footer}>
                {notice ? (
                    <Text
                        testID={`${testID}-notice`}
                        style={[styles.notice, notice.alert ? styles.noticeAlert : null]}
                        accessibilityLiveRegion="polite"
                        role="status"
                    >
                        {notice.text}
                    </Text>
                ) : null}
                <RoundButton
                    size="small"
                    display="inverted"
                    testID={`${testID}-cancel`}
                    title={t('common.cancel')}
                    onPress={requestCancel}
                />
                {status.kind === 'conflict' && !status.reviewed ? (
                    <RoundButton
                        size="small"
                        testID={`${testID}-review-latest`}
                        title={t('sessionBoard.note.conflict.reviewLatest')}
                        disabled={!editor.canReviewLatest}
                        onPress={editor.reviewLatest}
                    />
                ) : (
                    <RoundButton
                        size="small"
                        testID={`${testID}-save`}
                        title={status.kind === 'conflict'
                            ? t('sessionBoard.note.conflict.applyMine')
                            : t('common.save')}
                        disabled={!editor.canSave}
                        accessibilityHint={props.reachable ? undefined : t('sessionBoard.note.offline')}
                        loading={status.kind === 'saving'}
                        onPress={requestSave}
                    />
                )}
            </View>
        </SurfaceCard>
    );
}
