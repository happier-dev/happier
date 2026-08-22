import { describe, expect, it } from 'vitest';
import type {
    ComposerAttachmentInputV1,
    PluginComposerAttachmentContributionV1,
} from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('resolveExecutablePluginRuntimeRegistry Composer attachment declarations', () => {
    it('carries the authoritative title, cardinality, and draft/prepared schemas into runtime admission', async () => {
        const pluginId = 'acme.composer-attachments';
        const attachment = Object.freeze({ pluginId, localId: 'issue' });
        const definition = {
            id: attachment.localId,
            title: {
                key: 'attachment.issue.title',
                fallback: 'Issue context',
            },
            icon: 'error',
            cardinality: 'one',
            valueSchema: {
                type: 'object',
                properties: { issueId: { type: 'string' } },
                required: ['issueId'],
                additionalProperties: false,
            },
            preparedValueSchema: {
                type: 'object',
                properties: {
                    issueId: { type: 'string' },
                    prepared: { const: true },
                },
                required: ['issueId', 'prepared'],
                additionalProperties: false,
            },
            runtime: { prepareForSend: true },
        } satisfies PluginComposerAttachmentContributionV1;
        const contributes = createResolvedContributionRegistry({
            composerAttachments: [Object.freeze({
                provenance: 'external',
                source: Object.freeze({ kind: 'path' }),
                pluginId,
                pluginVersion: '1.0.0',
                identity: attachment,
                manifestPath: '/plugins/acme.composer-attachments/.happier-plugin/plugin.json',
                definition,
            })],
            activationTargets: [],
        });
        const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            contributes,
            generation: 7,
        });
        const draft = {
            v: 1,
            instanceId: 'issue-1',
            attachment,
            key: 'issue-42',
            value: { issueId: '42' },
            presentation: {
                label: 'Issue #42',
                typeLabel: 'Forged attachment title',
            },
        } as const satisfies ComposerAttachmentInputV1;

        try {
            const registry = runtimeRegistry.composerAttachments;
            expect(registry).toBeDefined();
            if (!registry) return;

            expect(registry.admit({
                phase: 'draft',
                attachments: [draft],
            })).toEqual([{
                ...draft,
                presentation: {
                    label: 'Issue #42',
                    typeLabel: 'Issue context',
                },
            }]);
            expect(() => registry.admit({
                phase: 'draft',
                attachments: [{ ...draft, value: { issueId: 42 } }],
            })).toThrow(expect.objectContaining({
                code: 'composer_attachment_value_invalid',
            }));
            expect(() => registry.admit({
                phase: 'draft',
                attachments: [
                    draft,
                    { ...draft, instanceId: 'issue-2', key: 'issue-43' },
                ],
            })).toThrow(expect.objectContaining({
                code: 'composer_attachment_cardinality_invalid',
            }));
            expect(() => registry.admit({
                phase: 'prepared',
                attachments: [draft],
            })).toThrow(expect.objectContaining({
                code: 'composer_attachment_value_invalid',
            }));
            expect(registry.admit({
                phase: 'prepared',
                attachments: [{
                    ...draft,
                    value: { issueId: '42', prepared: true },
                }],
            })).toEqual([{
                ...draft,
                value: { issueId: '42', prepared: true },
                presentation: {
                    label: 'Issue #42',
                    typeLabel: 'Issue context',
                },
            }]);
        } finally {
            await runtimeRegistry.dispose();
        }
    });
});
