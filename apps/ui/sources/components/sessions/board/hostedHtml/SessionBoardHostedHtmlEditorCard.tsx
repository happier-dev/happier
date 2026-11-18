import * as React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { runUnsavedChangesGuard, type ActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    useSessionBoardHostedHtmlEditor,
    type SessionBoardHostedHtmlEditorInput,
} from './useSessionBoardHostedHtmlEditor';
import { resolveSessionBoardFailurePresentation } from '../sessionBoardFailurePresentation';

const stylesheet = StyleSheet.create((theme) => ({
    title: { ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.text.primary },
    titleInput: {  ...Typography.variant('heading'), color: theme.colors.text.primary, paddingVertical: theme.space.s6 },
    editorLabel: {  ...Typography.variant('body', 'semiBold'), color: theme.colors.text.secondary, paddingTop: theme.space.s8 },
    editor: { minHeight: 240, paddingTop: theme.space.s8 },
    review: {
        marginTop: theme.space.s12,
        paddingTop: theme.space.s12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
        gap: theme.space.s6,
    },
    reviewHeading: {  ...Typography.variant('body', 'semiBold'), color: theme.colors.text.secondary },
    reviewEditor: { minHeight: 160 },
    footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: theme.space.s8, paddingTop: theme.space.s12 },
    notice: {  ...Typography.variant('body'), color: theme.colors.state.danger.textForeground, flex: 1, minWidth: 160 },
}));

export type SessionBoardHostedHtmlEditorCardProps = Omit<SessionBoardHostedHtmlEditorInput, 'flushHtml'> & Readonly<{
    onCancel: () => void;
    onGuardChange?: (guard: ((transition: () => void | Promise<void>) => Promise<boolean>) | null) => void;
    /** Registers the lossless active→retained editor handoff with the Session owner. */
    onContinuityFlushChange?: (flush: (() => void | Promise<void>) | null) => void;
    testID?: string;
}>;

export function SessionBoardHostedHtmlEditorCard(props: SessionBoardHostedHtmlEditorCardProps): React.ReactElement {
    const testID = props.testID ?? 'session-board-hosted-html-editor';
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const navigation = useNavigation();
    const editorRef = React.useRef<CodeEditorHandle | null>(null);
    const flushHtml = React.useCallback(async () => {
        const editor = editorRef.current;
        if (!editor) return null;
        await editor.flushPendingChange();
        return editor.getValue();
    }, []);
    const editor = useSessionBoardHostedHtmlEditor({ ...props, flushHtml });
    const requestDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: t('common.unsavedChangesWarning'),
            discardText: t('common.discard'),
            saveText: t('common.save'),
            keepEditingText: t('common.keepEditing'),
        },
    ), []);
    const prepareGuard = editor.flushToContinuity;
    const guard = React.useMemo<ActiveUnsavedChangesGuard>(() => ({
        isDirtyRef: editor.dirtyRef,
        requestDecision,
        prepareGuard,
        onSave: editor.save,
        tag: 'SessionBoardHostedHtmlEditorCard',
    }), [editor.dirtyRef, editor.save, prepareGuard, requestDecision]);
    const runGuarded = React.useCallback(async (transition: () => void | Promise<void>) => (
        await Promise.resolve(runUnsavedChangesGuard(guard, transition))
    ), [guard]);
    React.useEffect(() => {
        props.onGuardChange?.(runGuarded);
        return () => props.onGuardChange?.(null);
    }, [props.onGuardChange, runGuarded]);
    React.useEffect(() => {
        props.onContinuityFlushChange?.(editor.flushToContinuity);
        return () => props.onContinuityFlushChange?.(null);
    }, [editor.flushToContinuity, props.onContinuityFlushChange]);
    useUnsavedChangesBeforeRemoveGuard({
        enabled: true,
        isDirty: editor.dirty,
        isDirtyRef: editor.dirtyRef,
        requestDecision,
        prepareGuard,
        onSave: editor.save,
        interceptWhenClean: true,
        onContinue: (action) => {
            props.onCancel();
            if (action) (navigation as { dispatch?: (value: unknown) => void }).dispatch?.(action);
        },
        tag: 'SessionBoardHostedHtmlEditorCard.beforeRemove',
    });
    const notice = (() => {
        if (!props.reachable) return resolveSessionBoardFailurePresentation('offline').message;
        switch (editor.status.kind) {
            case 'invalid':
                return resolveSessionBoardFailurePresentation(editor.status.error).message;
            case 'failed':
                return resolveSessionBoardFailurePresentation(editor.status.error).message;
            case 'conflict':
                return resolveSessionBoardFailurePresentation('session_board_revision_conflict').message;
            case 'outcomeUnknown':
                return resolveSessionBoardFailurePresentation('outcome_unknown').message;
            case 'approvalPending':
                return resolveSessionBoardFailurePresentation('approval_required').message;
            case 'unavailable':
                return resolveSessionBoardFailurePresentation(editor.status.reason).message;
            case 'editing':
            case 'saving':
                return null;
        }
    })();
    const reviewHtml = editor.status.kind === 'conflict' && editor.status.reviewed
        ? editor.latestHtml
        : null;
    return (
        <SurfaceCard testID={testID} padding="md">
            <Text style={styles.title}>{t('sessionBoard.add.interactiveView')}</Text>
            <TextInput
                testID={`${testID}-title`}
                style={styles.titleInput}
                value={editor.title}
                onChangeText={editor.setTitle}
                autoFocus
                placeholder={t('sessionBoard.note.titlePlaceholder')}
                placeholderTextColor={theme.colors.text.secondary}
                accessibilityLabel={t('sessionBoard.item.renameA11y')}
            />
            <Text style={styles.editorLabel}>{t('sessionBoard.add.interactiveView')}</Text>
            <View style={styles.editor} accessibilityLabel={t('sessionBoard.add.interactiveView')}>
                <CodeEditor
                    ref={editorRef}
                    testID={`${testID}-source`}
                    resetKey={`session-board-hosted-html:${props.itemId}`}
                    value={editor.html}
                    language="html"
                    onChange={editor.setHtml}
                    wrapLines
                    showLineNumbers
                />
            </View>
            {reviewHtml !== null ? (
                <View style={styles.review} testID={`${testID}-review`}>
                    <Text style={styles.reviewHeading}>{t('sessionBoard.note.conflict.latestHeading')}</Text>
                    <View style={styles.reviewEditor}>
                        <CodeEditor
                            testID={`${testID}-latest-source`}
                            resetKey={`session-board-hosted-html-latest:${props.itemId}:${editor.expectedRevision ?? 'missing'}`}
                            value={reviewHtml}
                            language="html"
                            onChange={() => undefined}
                            readOnly
                            wrapLines
                            showLineNumbers
                        />
                    </View>
                </View>
            ) : null}
            <View style={styles.footer}>
                {notice ? <Text testID={`${testID}-notice`} style={styles.notice} accessibilityLiveRegion="polite" role="alert">{notice}</Text> : null}
                <RoundButton size="small" display="inverted" testID={`${testID}-cancel`} title={t('common.cancel')} onPress={() => { void runGuarded(props.onCancel); }} />
                {editor.status.kind === 'conflict' && !editor.status.reviewed ? (
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
                        title={editor.status.kind === 'conflict'
                            ? t('sessionBoard.note.conflict.applyMine')
                            : t('common.save')}
                        disabled={!editor.canSave}
                        loading={editor.status.kind === 'saving'}
                        accessibilityHint={props.reachable ? undefined : t('sessionBoard.mutation.offline')}
                        onPress={() => fireAndForget(editor.save(), { tag: 'SessionBoardHostedHtmlEditorCard.save' })}
                    />
                )}
            </View>
        </SurfaceCard>
    );
}
