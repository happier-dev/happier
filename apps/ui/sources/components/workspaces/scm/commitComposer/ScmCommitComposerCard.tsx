import * as React from 'react';
import { View } from 'react-native';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

// One glyph size for the composer's action row, so its spinner and icons agree.
const COMPOSER_GLYPH_SIZE_PX = 16;

export type ScmCommitComposerCardProps = Readonly<{
    theme: any;
    commitActionLabel: string;
    draftMessage: string;
    onDraftMessageChange: (value: string) => void;
    busy: boolean;
    status: string | null;
    /** Overrides the message field's placeholder (the Git pane asks for a selection first). */
    placeholder?: string;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    onCommitFromMessage: (message: string) => void;
    selectionSummary?: Readonly<{ fileCount: number; linesAdded: number; linesRemoved: number }> | null;
    selectionCount?: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
    /**
     * When true, the composer surfaces a "Select files to commit" affordance instead of
     * showing a per-row "+" on every changed file. Tapping it enters selection mode
     * (which reveals the row toggles and this selection summary). Defaults off so the
     * changed-files rows stay uncluttered and legible at narrow widths.
     */
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;
    variant?: 'card' | 'railFooter';
    commitMessageGeneratorEnabled?: boolean;
    /** Qualified host and comparison/selection basis captured by the suggestion request. */
    suggestionContextKey?: string;
    onGenerateCommitMessageSuggestion?: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string; errorCode?: string; runId?: string; outcome?: 'pending' | 'unknown' }
    >;
    onCancelCommitMessageSuggestion?: () => Promise<unknown>;
    pushShortcut?: Readonly<{
        label: string;
        disabled: boolean;
        busy: boolean;
        onPress: () => void;
    }> | null;
}>;

function unwrapMarkdownCodeFence(value: string): string {
    const trimmed = value.trim();
    const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    return match?.[1]?.trim() ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeGeneratedCommitMessageSuggestion(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';

    const unwrapped = unwrapMarkdownCodeFence(trimmed);
    try {
        const parsed: unknown = JSON.parse(unwrapped);
        if (!isRecord(parsed)) return unwrapped;

        const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (message) return message;

        const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
        const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
        if (title && body) return `${title}\n\n${body}`;
        return title || body || unwrapped;
    } catch {
        return unwrapped;
    }
}

export const ScmCommitComposerCard = React.memo((props: ScmCommitComposerCardProps) => {
    const trimmedMessage = String(props.draftMessage ?? '').trim();
    const commitDisabled = props.busy || !props.commitAllowed || trimmedMessage.length === 0;
    const variant = props.variant ?? 'card';
    const generatorEnabled = props.commitMessageGeneratorEnabled === true && typeof props.onGenerateCommitMessageSuggestion === 'function';
    const [generating, setGenerating] = React.useState(false);
    const [observation, setObservation] = React.useState<Readonly<{ contextKey?: string; error: string }> | null>(null);
    const mountedRef = useMountedRef();
    const currentDraftRef = React.useRef(props);
    currentDraftRef.current = props;

    const onGenerate = React.useCallback(async () => {
        if (!generatorEnabled || !props.onGenerateCommitMessageSuggestion) return;
        if (props.busy || generating) return;
        const draftMessage = props.draftMessage;
        const contextKey = props.suggestionContextKey;
        setGenerating(true);
        try {
            const res = await props.onGenerateCommitMessageSuggestion();
            const current = currentDraftRef.current;
            if (!mountedRef.current || current.draftMessage !== draftMessage || current.suggestionContextKey !== contextKey) return;
            if (!res.ok && res.errorCode === 'SCM_COMMIT_MESSAGE_SCOPE_RETIRED') return;
            if (res.ok) {
                setObservation(null);
                current.onDraftMessageChange(normalizeGeneratedCommitMessageSuggestion(res.message));
            } else if (res.runId && res.outcome) {
                setObservation({ contextKey, error: res.error });
            } else {
                setObservation(null);
                Modal.alert(t('common.error'), res.error);
            }
        } catch (error) {
            const current = currentDraftRef.current;
            if (!mountedRef.current || current.draftMessage !== draftMessage || current.suggestionContextKey !== contextKey) return;
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        } finally {
            if (mountedRef.current) setGenerating(false);
        }
    }, [generatorEnabled, generating, props]);

    return (
        <View
            style={variant === 'card'
                ? { paddingHorizontal: 12, paddingVertical: 8 }
                : { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 }}
        >
            {props.commitSelectionAvailable ? (
                props.selectionModeActive ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                        <Text
                            testID="scm-commit-selection-summary"
                            style={{ flexGrow: 1, fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}
                        >
                            {t('files.sourceControlOperations.selection', { count: props.selectionCount ?? 0 })}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {props.onSelectAllSelection ? (
                                <ToolbarButton
                                    label={t('common.all')}
                                    onPress={props.onSelectAllSelection}
                                />
                            ) : null}

                            {((props.selectionCount ?? 0) > 0 && props.onClearSelection) ? (
                                <ToolbarButton
                                    label={t('files.sourceControlOperations.clear')}
                                    accessibilityLabel={t('files.fileActions.clearSelection')}
                                    onPress={props.onClearSelection}
                                />
                            ) : null}

                            {((props.selectionCount ?? 0) === 0 && props.onExitSelectionMode) ? (
                                <ToolbarButton
                                    testID="scm-commit-exit-selection"
                                    label={t('common.done')}
                                    onPress={props.onExitSelectionMode}
                                />
                            ) : null}
                        </View>
                    </View>
                ) : (
                    <ToolbarButton
                        testID="scm-commit-enter-selection"
                        label={t('files.fileActions.selectFilesToCommit')}
                        icon={<Icon name="check-circle" size={14} color={props.theme.colors.text.secondary} />}
                        onPress={props.onEnterSelectionMode}
                        style={{ alignSelf: 'flex-start', marginBottom: 10 }}
                    />
                )
            ) : null}
            {props.status && !props.busy ? (
                <Text style={{ marginBottom: 8, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.status}
                </Text>
            ) : null}
            {observation?.contextKey === props.suggestionContextKey && observation ? (
                <View>
                    <Text testID="scm-commit-suggestion-status">{observation.error}</Text>
                    {props.onCancelCommitMessageSuggestion ? (
                        <ToolbarButton testID="scm-commit-suggestion-cancel" label={t('common.cancel')}
                            onPress={() => {
                                void props.onCancelCommitMessageSuggestion?.().catch((error: unknown) => {
                                    if (mountedRef.current && currentDraftRef.current.suggestionContextKey === props.suggestionContextKey) {
                                        Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
                                    }
                                });
                            }} />
                    ) : null}
                </View>
            ) : null}
            {/* One field (lab p-changes GIT / p-overview Local changes): the message, and under it the
                suggestion, what is selected and Commit, inside the same border. */}
            <View
                style={{
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: props.theme.colors.border.default,
                    backgroundColor: props.theme.colors.surface.base,
                    paddingTop: 9,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    paddingRight: 10,
                }}
            >
                <TextInput
                    testID="scm-commit-message"
                    value={props.draftMessage}
                    onChangeText={props.onDraftMessageChange}
                    editable={!props.busy}
                    multiline
                    placeholder={props.placeholder ?? t('files.commitMessageEditor.placeholder')}
                    placeholderTextColor={props.theme.colors.text.secondary}
                    style={{
                        fontSize: 13,
                        lineHeight: 19,
                        color: props.theme.colors.text.primary,
                        minHeight: 19,
                        maxHeight: 96,
                        padding: 0,
                        textAlignVertical: 'top' as any,
                    }}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                    {generatorEnabled ? (
                        <IconButton
                            variant="plain"
                            size={24}
                            accessibilityLabel={t('files.commitMessageEditor.generate')}
                            tooltip={t('files.commitMessageEditor.generate')}
                            disabled={props.busy || generating}
                            onPress={onGenerate}
                            icon={generating
                                ? <ActivitySpinner
                                    size={iconMatchedSpinnerSize(COMPOSER_GLYPH_SIZE_PX)}
                                    color={props.theme.colors.text.secondary}
                                />
                                : <Icon
                                    name="sparkle"
                                    size={COMPOSER_GLYPH_SIZE_PX}
                                    color={props.theme.colors.text.secondary}
                                />}
                        />
                    ) : null}
                    {props.selectionSummary ? (
                        <Text
                            testID="scm-commit-selection-lines"
                            numberOfLines={1}
                            style={{ flexShrink: 1, fontSize: 12, color: props.theme.colors.text.tertiary, ...Typography.default(), ...Typography.tabular() }}
                        >
                            {t('files.commitMessageEditor.selectionMeta', {
                                count: props.selectionSummary.fileCount,
                                added: props.selectionSummary.linesAdded,
                                removed: props.selectionSummary.linesRemoved,
                            })}
                        </Text>
                    ) : null}
                    <View style={{ flex: 1 }} />
                    {props.pushShortcut ? (
                        <IconButton
                            variant="plain"
                            size={28}
                            accessibilityLabel={props.pushShortcut.label}
                            tooltip={props.pushShortcut.label}
                            disabled={props.pushShortcut.disabled}
                            onPress={props.pushShortcut.onPress}
                            testID="scm-commit-adjacent-push"
                            icon={props.pushShortcut.busy
                                ? <ActivitySpinner
                                    size={iconMatchedSpinnerSize(COMPOSER_GLYPH_SIZE_PX)}
                                    color={props.theme.colors.text.secondary}
                                />
                                : <Icon
                                    name="arrow-circle-up"
                                    size={COMPOSER_GLYPH_SIZE_PX}
                                    color={props.theme.colors.text.secondary}
                                />}
                        />
                    ) : null}
                    <ToolbarButton
                        testID="scm-commit-submit"
                        tone="primary"
                        label={props.commitActionLabel}
                        accessibilityLabel={props.commitActionLabel}
                        disabled={commitDisabled}
                        busy={props.busy}
                        // Commit progress stays inside the button rather than as a status line.
                        icon={props.busy
                            ? <ActivitySpinner size={iconMatchedSpinnerSize(COMPOSER_GLYPH_SIZE_PX)} color={props.theme.colors.text.secondary} />
                            : undefined}
                        onPress={() => props.onCommitFromMessage(trimmedMessage)}
                    />
                </View>
            </View>

            {!props.commitAllowed && props.commitBlockedMessage ? (
                <Text style={{ marginTop: 8, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.commitBlockedMessage}
                </Text>
            ) : null}
        </View>
    );
});
