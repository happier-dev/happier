import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolCall } from '@happier-dev/session-core/messages';

import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { ToolFullView } from '@/components/tools/shell/views/ToolFullView';
import { PageHeader } from '@/components/ui/layout/PageHeader';

const SESSION_ID = 'specimen-session';

/** The recorded shapes of two Happier Action tool calls (Codex `action_execute`), read by the real details page. */
const CALLS: Readonly<Record<string, Readonly<{ input: unknown; result: unknown }>>> = {
    archive: {
        input: { actionId: 'session.archive', input: { sessionId: 'session-archived-1' } },
        result: { content: [{ type: 'text', text: '{"success":true,"sessionId":"session-archived-1","archivedAt":1792557232467}' }] },
    },
    spawn: {
        input: {
            actionId: 'session.spawn_new',
            input: {
                creationKey: 'auth-helper-20261030-1',
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                directory: { kind: 'path', path: '/home/ana/code/shop-api' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                title: 'Authorization check helper',
            },
        },
        result: { content: [{ type: 'text', text: JSON.stringify({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
            operation: { serverId: 'server-1', machineId: 'machine-1', operationId: 'operation-1' } }) }] },
    },
    // An Agent's template Copy as recorded live (SMOKE-CLOSE replay7): the call completes by handing off to an approval.
    copy: {
        input: {
            actionId: 'template.instantiate',
            input: {
                source: { kind: 'artifact', serverId: 'server-1', artifactId: '00749bf1-5af6-4820-b331-618adcd7ac55' },
                expectedVersion: '1.2.0',
                creation: { directory: { kind: 'path', path: '~/code/happier' } },
                name: 'Release captain',
            },
        },
        result: { content: [{ type: 'text', text: JSON.stringify({ kind: 'approval_request_created',
            artifactId: 'a3680fd5-e8ed-881a-a235-95644f44cdc9', actionId: 'template.instantiate' }) }] },
    },
};

/** Dev-only: the tool-call details page over a completed Action call (`call` = archive | spawn | copy). */
export function ToolDetailsSpecimen(props: Readonly<{ call: string }>) {
    const call = CALLS[props.call] ?? CALLS.archive!;
    const id = `specimen-${props.call}`;
    const tool = React.useMemo(() => ({
        id, name: 'mcp__happier__action_execute', state: 'completed', input: call.input, result: call.result,
        createdAt: 0, startedAt: 0, completedAt: 0, description: null,
    }) as unknown as ToolCall, [call, id]);
    return (
        <View style={styles.page}>
            <AppSessionTranscriptSourceProvider sessionId={SESSION_ID} readOnly navigation="none">
                <ToolFullView tool={tool} owningMessageId={id} sessionId={SESSION_ID}
                    header={<PageHeader title={props.call === 'spawn' ? 'Create session' : props.call === 'copy' ? 'Make a copy of a Bot template' : 'Archive session'} alwaysShowTitle />} />
            </AppSessionTranscriptSourceProvider>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.surface.base },
}));
