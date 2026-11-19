import { defineComposerAttachment, definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const value = defineProtocolObject({ issue: defineProtocolString() }, { policy: 'closed' });
const plugin = definePlugin({
    id: 'acme.account-composer',
    version: '1.0.0',
    entrypoints: { daemon: './daemon.mjs' },
    actions: {
        send: {
            title: 'Send issue to Session',
            surfaces: ['cli'],
            dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            inputSchema: defineProtocolObject({ sessionId: defineProtocolString(), mode: defineProtocolString() }, { policy: 'closed' }),
            run: (input, context) => context.services.actions.execute('session.message.send', {
                sessionId: input.sessionId,
                message: 'Review this issue',
                idempotencyKey: input.mode,
                ...(input.mode === 'plain' ? {} : {
                    attachments: [{ attachmentLocalId: 'issue', value: {
                        key: input.mode,
                        value: { issue: input.mode },
                        presentation: { label: 'Issue 42' },
                    } }],
                }),
            }),
        },
    },
    composer: {
        attachments: {
            issue: defineComposerAttachment({
                title: 'Issue',
                icon: 'error',
                cardinality: 'one',
                value,
                preparedValue: value,
                runtime: {
                    async prepareForSend(request) {
                        return { attachments: request.attachments.map(({ instanceId, value }) => value.issue === 'blocked'
                            ? { instanceId, status: 'blocked', retryable: false }
                            : { instanceId, status: 'ready', value: { issue: 'prepared on daemon' } }) };
                    },
                },
            }),
        },
    },
});

export const manifest = plugin.manifest;
export const activate = plugin.activate;
export const activateAccount = plugin.activateAccount;
