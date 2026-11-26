import { definePlugin, PluginError, type PluginClientApi } from '@happier-dev/plugin-sdk';
import { defineProtocolJsonValue, defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { Button, FactStrip, Stack, Text, useExecutePluginAction } from '@happier-dev/plugin-ui';

const pluginId = 'example.session-links';
const linkedSession = { serverId: 'example-home', sessionId: 'session-42' };
const readLinkedSession = 'read-linked-session';
const sessionId = defineProtocolString({ minLength: 1 });
const linkInput = defineProtocolObject({ sessionId }, { policy: 'closed' });
const linkResult = defineProtocolObject({ kind: defineProtocolLiteral('linked'), session: ActionSessionAddressV1Schema }, { policy: 'closed' });
const failureInput = defineProtocolObject({ kind: defineProtocolLiteral('readLinkedSession'), context: defineProtocolJsonValue() }, { policy: 'closed' });
const failureResult = defineProtocolObject({ kind: defineProtocolLiteral('linkedSession'), session: ActionSessionAddressV1Schema.nullable() }, { policy: 'closed' });

export const sessionLinkPlugin = definePlugin({
    id: pluginId,
    version: '1.0.0',
    inputTypes: {
        'linkable-session': {
            title: 'Session to link',
            semantic: 'linkable-session',
            valueSchema: sessionId.jsonSchema,
            options: { resource: 'linkable-sessions' },
        },
    },
    resources: {
        'linkable-sessions': {
            source: 'dynamic',
            kind: 'config',
            scope: 'global',
            contentType: 'application/json',
            runtime: {
                read: ({ query }) => JSON.stringify({
                    options: [{ value: linkedSession.sessionId, label: 'Design review' }].filter(({ label }) =>
                        label.toLowerCase().includes(query?.query?.toLowerCase() ?? '')),
                }),
                observe: () => ({ dispose() {} }),
            },
        },
    },
    actions: {
        'link-session': {
            title: 'Link Session',
            surfaces: ['ui'],
            inputHints: { fields: [{
                path: 'sessionId', title: 'Session', widget: 'select', required: true,
                inputType: { pluginId, localId: 'linkable-session' },
            }] },
            inputSchema: linkInput,
            resultSchema: linkResult,
            run: ({ sessionId }) => {
                if (sessionId !== linkedSession.sessionId) {
                    throw new PluginError({
                        code: 'example_session_link_unavailable',
                        message: 'This Session can no longer be linked.',
                    });
                }
                return { kind: 'linked', session: linkedSession };
            },
        },
        [readLinkedSession]: {
            title: 'Read the linked Session',
            surfaces: ['ui'],
            execution: { target: 'client', client: { artifactId: 'failure-actions', exportName: 'activateFailureActions' }, platforms: ['web'] },
            inputSchema: failureInput,
            resultSchema: failureResult,
        },
    },
    ui: {
        renderers: [{ id: 'links-content', kind: 'declarative', root: { kind: 'text', text: 'Session links' } }],
        views: [{
            id: 'links', renderer: 'links-content', container: 'appPage', target: { kind: 'app' }, title: 'Session links',
            failureActions: { action: readLinkedSession },
        }],
    },
});

// This fixture exercises the linked-Session read of the native failure surface.
export function activateFailureActions(api: PluginClientApi): void {
    api.actions.register(readLinkedSession, input => {
        const { context } = failureInput.parse(input);
        return failureResult.parse({ kind: 'linkedSession', session: context === 'example-notice' ? linkedSession : null });
    });
}

export function useAuthoredSessionLink() {
    const controller = useExecutePluginAction(sessionLinkPlugin.actionContracts['link-session']);
    if (false) {
        // @ts-expect-error The contributed Action accepts a Session ID, not a title.
        void controller.execute({ title: 'Design review' });
    }
    return controller;
}

export function LinkedSessionFacts({ selectedSessionId }: Readonly<{ selectedSessionId: string }>) {
    const { execute, execution } = useAuthoredSessionLink();
    return <Stack>
        <Button title="Link Session" onPress={() => execute({ sessionId: selectedSessionId })} />
        {execution.status === 'success' && <FactStrip facts={[
            { key: 'session', label: 'Linked Session', value: execution.result.session.sessionId },
        ]} />}
        {execution.status === 'error' && <Text value={execution.code === 'example_session_link_unavailable'
            ? 'Choose another Session to link.' : execution.message} />}
    </Stack>;
}
