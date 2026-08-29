import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AutomationTriggerEditor } from '@/components/automations/editor/AutomationPluralEditorScreen';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { readExactActiveParentTurn } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import {
    createAutomationEditorAutomationId,
    type AutomationTriggerEditorValue,
} from '@/sync/domains/automations/automationEditorDraft';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { isAutomationSessionCandidate } from '@/sync/domains/automations/isAutomationSessionCandidate';
import { storage, useSessions, useSettings } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getSessionName } from '@/utils/sessions/sessionUtils';

type Props = Readonly<{
    value: NewSessionAutomationDraft;
    onChange: (next: NewSessionAutomationDraft) => void;
    machineId?: string | null;
    targetServerId?: string | null;
}>;

const styles = StyleSheet.create((theme) => ({
    root: { width: '100%', backgroundColor: theme.colors.background.canvas, paddingVertical: 12 },
}));

type InlineAutomationTriggerEditorValue = AutomationTriggerEditorValue & Readonly<{
    pendingAutomationId: string;
}>;

function toEditorValue(value: NewSessionAutomationDraft): InlineAutomationTriggerEditorValue {
    return {
        pendingAutomationId: value.pendingAutomationId ?? createAutomationEditorAutomationId(),
        name: value.name,
        description: value.description || null,
        enabled: value.enabled,
        triggers: value.triggers.map(({ clientId, definition }) => ({ clientId, persisted: null, definition })),
        removedTriggers: [],
    };
}

function fromEditorValue(value: InlineAutomationTriggerEditorValue): NewSessionAutomationDraft {
    return {
        pendingAutomationId: value.pendingAutomationId,
        enabled: value.enabled,
        name: value.name,
        description: value.description ?? '',
        triggers: value.triggers.flatMap(({ clientId, definition }) => definition ? [{ clientId, definition }] : []),
    };
}

/** One plural editor serves inline New Session authoring as well as full screens. */
export function AutomationSettingsPopoverContent(props: Props) {
    const value = React.useMemo(() => toEditorValue(props.value), [props.value]);
    const sessions = useSessions() ?? [];
    const settings = useSettings();
    const sessionOptions = React.useMemo(() => sessions
        .filter((session) => (
            (!props.targetServerId || session.serverId === props.targetServerId)
            && isAutomationSessionCandidate(session, settings)
        ))
        .map((session) => ({
        sessionId: session.id,
        label: getSessionName(session),
        currentParentTurnId: readExactActiveParentTurn(session)?.sourceTurnId ?? null,
    })), [props.targetServerId, sessions, settings]);
    return (
        <View style={styles.root}>
            <AutomationTriggerEditor
                value={value}
                onChange={(next) => props.onChange(fromEditorValue({
                    ...next,
                    pendingAutomationId: value.pendingAutomationId,
                }))}
                sessionOptions={sessionOptions}
                resolveCurrentSessionTurn={(sessionId) => {
                    const candidate = storage.getState().sessions[sessionId];
                    if (!candidate || !isAutomationSessionCandidate(candidate, storage.getState().settings)) return null;
                    const exact = readExactActiveParentTurn(candidate);
                    return exact ? { sourceSessionId: exact.sourceSessionId, sourceTurnId: exact.sourceTurnId } : null;
                }}
                onSessionSelectionStale={() => { void sync.refreshSessions(); }}
                renderPluginEventEditor={(editorProps) => (
                    <PluginEventAutomationEditor
                        key={editorProps.clientId}
                        automationId={value.pendingAutomationId}
                        clientId={editorProps.clientId}
                        value={editorProps.value}
                        seed={null}
                        authoringMachineId={props.machineId ?? null}
                        serverId={props.targetServerId ?? null}
                        onComplete={editorProps.onComplete}
                        onCancel={editorProps.onCancel}
                    />
                )}
            />
        </View>
    );
}
