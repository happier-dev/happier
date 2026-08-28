import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AutomationPluralEditorScreen } from '@/components/automations/editor/AutomationPluralEditorScreen';
import { PluginEventAutomationEditor } from '@/components/automations/editor/PluginEventAutomationEditor';
import { readExactActiveParentTurn } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import {
    createAutomationEditorAutomationId,
    type AutomationEditorDraft,
} from '@/sync/domains/automations/automationEditorDraft';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import { storage, useSessions } from '@/sync/domains/state/storage';
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

function toEditorDraft(value: NewSessionAutomationDraft): AutomationEditorDraft & Readonly<{ pendingAutomationId: string }> {
    return {
        automationId: null,
        pendingAutomationId: value.pendingAutomationId ?? createAutomationEditorAutomationId(),
        expectedTemplateVersion: null,
        name: value.name,
        description: value.description || null,
        enabled: value.enabled,
        // The inline editor never persists this placeholder. The submit owner
        // replaces it with the strict plain/E2EE Session recipe.
        executionRecipe: {
            v: 1,
            templateVersion: 1,
            template: { t: 'plain', v: { v: 1, prompt: '' } },
            triggerEvidence: null,
            target: { kind: 'existingSession', sessionId: 'inline-authoring-placeholder' },
        },
        assignments: [],
        triggers: value.triggers.map(({ clientId, definition }) => ({ clientId, persisted: null, definition })),
        removedTriggers: [],
    };
}

function fromEditorDraft(value: AutomationEditorDraft): NewSessionAutomationDraft {
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
    const value = React.useMemo(() => toEditorDraft(props.value), [props.value]);
    const sessions = useSessions() ?? [];
    const sessionOptions = React.useMemo(() => sessions
        .filter((session) => !props.targetServerId || session.serverId === props.targetServerId)
        .map((session) => ({
        sessionId: session.id,
        label: getSessionName(session),
        currentParentTurnId: readExactActiveParentTurn(session)?.sourceTurnId ?? null,
    })), [props.targetServerId, sessions]);
    return (
        <View style={styles.root}>
            <AutomationPluralEditorScreen
                variant="embedded"
                value={value}
                onChange={(next) => props.onChange(fromEditorDraft(next))}
                sessionOptions={sessionOptions}
                resolveCurrentSessionTurn={(sessionId) => {
                    const exact = readExactActiveParentTurn(storage.getState().sessions[sessionId]);
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
