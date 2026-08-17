import { describe, expect, it } from 'vitest';

import { resolveMessageComposerAttachments } from './messageComposerAttachments';

describe('message composer attachment transcript projection', () => {
    it('retains every persisted attachment presentation without exposing its value', () => {
        const attachments = resolveMessageComposerAttachments({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [
                    {
                        v: 1,
                        instanceId: 'issue-42',
                        attachment: { pluginId: 'acme.issues', localId: 'issue' },
                        key: '42',
                        value: { issueId: 42 },
                        presentation: {
                            typeLabel: 'Issue',
                            label: 'Issue #42',
                            description: 'Production error',
                            icon: 'error',
                        },
                    },
                    {
                        v: 1,
                        instanceId: 'run-7',
                        attachment: { pluginId: 'acme.deployments', localId: 'run' },
                        key: '7',
                        value: { runId: 7 },
                        presentation: {
                            typeLabel: 'Deployment',
                            label: 'Deploy #7',
                            tone: 'warning',
                        },
                    },
                ],
            },
        });

        expect(attachments).toEqual([
            {
                instanceId: 'issue-42',
                typeLabel: 'Issue',
                label: 'Issue #42',
                description: 'Production error',
                icon: 'error',
                tone: null,
            },
            {
                instanceId: 'run-7',
                typeLabel: 'Deployment',
                label: 'Deploy #7',
                description: null,
                icon: null,
                tone: 'warning',
            },
        ]);
        expect(attachments[0]).not.toHaveProperty('value');
        expect(attachments[0]).not.toHaveProperty('attachment');
    });

    it('fails closed when persisted attachments are malformed', () => {
        expect(resolveMessageComposerAttachments({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{ instanceId: 'not-an-attachment' }],
            },
        })).toEqual([]);
    });
});
