import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { TriageSaveActionDefaultsInputV1Schema, readTriageSavedActionDefaultProfileIdV1, TRIAGE_SAVE_ACTION_DEFAULTS_ACTION_REF_V1, TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 } from '@happier-dev/triage-protocol/v1';
import { projectLaunchProfileAuthoringPreferencesV1 } from '@happier-dev/protocol/profiles/v2/schema';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { getSessionDraftSnapshot, subscribeSessionDraft, writeSessionDraftLocalSupplement } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

type ActionDefault = NonNullable<NewSessionDraft['actionDefault']>;

/** This leaf subscribes to action metadata in the scoped composer draft. */
export function NewSessionActionDefaults(props: Readonly<{
    scope: ServerAccountScope;
    draftId: string;
    execute: (actionId: 'action.invoke', input: unknown) => Promise<unknown>;
    getCurrentDraft: () => Readonly<NewSessionDraft>;
    onProfileSaved: (profileId: string) => void;
}>) {
    const { scope, draftId, execute, getCurrentDraft, onProfileSaved } = props;
    const address = React.useMemo(() => ({ kind: 'newSession' as const, draftId }), [draftId]);
    const subscribe = React.useCallback((listener: () => void) => subscribeSessionDraft(scope, address, listener), [address, scope]);
    const getSnapshot = React.useCallback(() => getSessionDraftSnapshot(scope, address)?.localSupplement.newSessionLocalState?.actionDefault ?? null, [address, scope]);
    const actionDefault = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [feedback, setFeedback] = React.useState<string | null>(null);
    const update = React.useCallback((patch: Partial<Pick<ActionDefault, 'label' | 'launchMode'>>) => {
        const localState = getSessionDraftSnapshot(scope, address)?.localSupplement.newSessionLocalState;
        if (!localState?.actionDefault) return;
        writeSessionDraftLocalSupplement({ scope, address, patch: {
            newSessionLocalState: { ...localState, actionDefault: { ...localState.actionDefault, ...patch } },
        } });
        setFeedback(null);
    }, [address, scope]);
    const save = React.useCallback(async () => {
        setFeedback(null);
        const notAppliedMessage = t('newSession.actionDefault.failed');
        try {
            const actionDefault = getSnapshot();
            if (!actionDefault) throw new Error(t('newSession.actionDefault.failed'));
            const draft = getCurrentDraft();
            const preferences = projectLaunchProfileAuthoringPreferencesV1({
                executionTarget: draft.executionTarget,
                directoryIntent: draft.directoryKind === 'managed' ? { kind: 'managed' }
                    : draft.selectedPath ? { kind: 'path', path: draft.selectedPath } : undefined,
                checkoutCreationDraft: draft.checkoutCreationDraft,
                managedCreationSelection: draft.managedMachineSelection?.selection ?? draft.managedMachineAcquisition?.selection,
            });
            if (preferences.status === 'unsupported') {
                setFeedback(t('newSession.actionDefault.stablePlacementRequired'));
                return;
            }
            const input = TriageSaveActionDefaultsInputV1Schema.parse({ v: 1, kind: 'saveDefaults',
                actionId: actionDefault.configuredActionId, label: actionDefault.label,
                promptText: draft.input, profileId: draft.selectedProfileId, placement: preferences.placement,
                checkout: preferences.checkout,
                launchMode: actionDefault.launchMode });
            const result = await execute('action.invoke', { action: TRIAGE_SAVE_ACTION_DEFAULTS_ACTION_REF_V1, input });
            if (result && typeof result === 'object' && 'status' in result && result.status === 'applied') {
                const savedProfileId = readTriageSavedActionDefaultProfileIdV1(result, actionDefault.configuredActionId);
                if (savedProfileId !== undefined) onProfileSaved(savedProfileId);
                setFeedback(t('newSession.actionDefault.saved'));
            } else {
                const reason = result && typeof result === 'object' && 'reason' in result && typeof result.reason === 'string' ? result.reason : null;
                setFeedback(reason === TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 ? t('newSession.actionDefault.workspaceMode')
                    : resolveActionExecutionErrorMessage({ code: reason }, notAppliedMessage, { notAppliedMessage }));
            }
        } catch (error) {
            setFeedback(resolveActionExecutionErrorMessage(error, notAppliedMessage, { notAppliedMessage }));
        }
    }, [execute, getCurrentDraft, getSnapshot, onProfileSaved]);
    // The save capability belongs to the Triage protocol; other seed producers remain ordinary drafts.
    if (actionDefault?.pluginId !== TRIAGE_SAVE_ACTION_DEFAULTS_ACTION_REF_V1.pluginId) return null;
    return <ComposerAuxiliaryFrame>
        <View style={styles.content}>
            <Text variant="meta">{t('newSession.actionDefault.name')}</Text>
            <FieldTextInput testID="new-session-action-default-name" value={actionDefault.label}
                accessibilityLabel={t('newSession.actionDefault.name')} onChangeText={label => update({ label })} />
            <Text variant="meta">{t('newSession.actionDefault.launchMode')}</Text>
            <SegmentedTabBar<ActionDefault['launchMode']> tabs={[
                { id: 'review', label: t('newSession.actionDefault.review') },
                { id: 'start', label: t('newSession.actionDefault.start') },
            ]} activeTabId={actionDefault.launchMode} onSelectTab={launchMode => update({ launchMode })}
                testIDPrefix="new-session-action-default-launch" />
            <RoundButton testID="new-session-action-default-save" title={t('newSession.actionDefault.save')}
                titleNumberOfLines="complete" size="small" display="secondary" action={save}
                disabled={!actionDefault.label.trim()} disabledReason={t('newSession.actionDefault.nameRequired')} />
            {feedback ? <Text testID="new-session-action-default-feedback" variant="meta" accessibilityLiveRegion="polite">{feedback}</Text> : null}
        </View>
    </ComposerAuxiliaryFrame>;
}

const styles = StyleSheet.create(theme => ({
    content: { gap: theme.space.s8, paddingVertical: theme.space.s8 },
}));
