import {
    buildComposerReferenceMentionPayloadV1,
    PluginProjectionV2Schema,
    readComposerReferenceMentionV1,
    readHappierStructuredInputV1FromMeta,
    type ComposerAttachmentDraftV1,
    type ComposerSnapshotV1,
    type ComposerStagedMediaContentV1,
    type PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import type { ComposerStructuredInputMention } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

import {
    composerAttachmentDraftToView,
    composerAttachmentViewToDraft,
    composerReferencesFromStructuredMentions,
    composerStructuredMentionsFromReferences,
} from './composerScopeAdapters';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

const issueAttachmentCatalogEntry = {
    id: 'acme.issues/issue',
    pluginId: 'acme.issues',
    identity: { pluginId: 'acme.issues', localId: 'issue' },
    immutableGenerationId: 'issues-generation-1',
    definition: {
        id: 'issue',
        title: 'Issue',
        icon: 'file',
        cardinality: 'many',
        valueSchema: {
            type: 'object',
            required: ['issueId'],
            properties: {
                issueId: { type: 'integer' },
            },
            additionalProperties: false,
        },
    },
} satisfies PluginProjectedComposerAttachmentEntryV1;

function composerAttachmentProjection(
    entry: PluginProjectedComposerAttachmentEntryV1,
    generation: number,
) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            composerAttachments: {
                family: 'composerAttachments',
                entriesById: { [entry.id]: entry },
            },
        },
        diagnostics: [],
    });
}

function composerAttachmentCatalog(
    entry: PluginProjectedComposerAttachmentEntryV1,
    generation = 1,
) {
    return {
        entriesById: normalizePluginUiProjection(
            composerAttachmentProjection(entry, generation),
        ).composerAttachmentsById,
    };
}

describe('composer scope adapters', () => {
    it('compiles one current attachment schema once across repeated snapshot projections, then recompiles once for a replacement catalog', async () => {
        vi.resetModules();
        const protocol = await import('@happier-dev/protocol');
        const compile = vi.spyOn(protocol, 'compilePluginJsonSchema');
        const [{ composerAttachmentDraftToView: projectAttachment }, { normalizePluginUiProjection }] = await Promise.all([
            import('./composerScopeAdapters'),
            import('@/sync/domains/plugins/ui/projection'),
        ]);
        const draft: ComposerAttachmentDraftV1 = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };

        try {
            const currentCatalog = {
                entriesById: normalizePluginUiProjection(
                    composerAttachmentProjection(issueAttachmentCatalogEntry, 1),
                ).composerAttachmentsById,
            };

            // Exact Composer observers reread snapshots after text-only revisions;
            // changing only a draft value must reuse the same admitted validator too.
            expect(projectAttachment(draft, currentCatalog).availability).toEqual({ status: 'ready' });
            expect(projectAttachment({ ...draft, value: { issueId: 43 } }, currentCatalog).availability)
                .toEqual({ status: 'ready' });
            expect(projectAttachment({ ...draft, value: { issueId: 'not-a-number' } }, currentCatalog).availability)
                .toEqual({ status: 'invalid' });
            expect(compile).toHaveBeenCalledTimes(1);

            const replacement = {
                ...issueAttachmentCatalogEntry,
                immutableGenerationId: 'issues-generation-2',
                definition: {
                    ...issueAttachmentCatalogEntry.definition,
                    valueSchema: {
                        type: 'object',
                        required: ['issueRef'],
                        properties: { issueRef: { type: 'string' } },
                        additionalProperties: false,
                    },
                },
            } satisfies PluginProjectedComposerAttachmentEntryV1;
            const replacementCatalog = {
                entriesById: normalizePluginUiProjection(
                    composerAttachmentProjection(replacement, 2),
                ).composerAttachmentsById,
            };

            expect(projectAttachment(draft, replacementCatalog).availability).toEqual({ status: 'invalid' });
            expect(projectAttachment(draft, { entriesById: {} }).availability).toEqual({ status: 'unavailable' });
            expect(compile).toHaveBeenCalledTimes(2);
        } finally {
            compile.mockRestore();
        }
    });

    it('projects a persisted contentless plugin attachment through the document view', () => {
        const draft: ComposerAttachmentDraftV1 = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };

        const view = composerAttachmentDraftToView(
            draft,
            composerAttachmentCatalog(issueAttachmentCatalogEntry),
        );

        expect(view).toMatchObject({
            ...draft,
            availability: { status: 'ready' },
        });
        expect(view).not.toHaveProperty('content');
        expect(composerAttachmentViewToDraft(view)).toEqual(draft);
    });

    it('round-trips an opaque staged-media handle through the canonical Composer draft adapter', () => {
        const content = {
            kind: 'stagedMedia',
            handle: {
                v: 1,
                id: 'stage-1',
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                owner: { pluginId: 'acme.issues', localId: 'issue' },
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'issue.png',
                sizeBytes: 42,
                sha256: 'a'.repeat(64),
            },
        } satisfies ComposerStagedMediaContentV1;
        const draft = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            content,
        } satisfies ComposerAttachmentDraftV1;

        const view = composerAttachmentDraftToView(
            draft,
            composerAttachmentCatalog(issueAttachmentCatalogEntry),
        );

        expect(view).toMatchObject({
            content,
            availability: { status: 'ready' },
        });
        expect(composerAttachmentViewToDraft(view)).toEqual(draft);
    });

    it('derives persisted attachment availability from the exact current catalog generation without persisting that generation', () => {
        const draft: ComposerAttachmentDraftV1 = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };
        const catalog = (entry: PluginProjectedComposerAttachmentEntryV1) => composerAttachmentCatalog(entry);

        expect(composerAttachmentDraftToView(draft, catalog(issueAttachmentCatalogEntry))).toMatchObject({
            instanceId: draft.instanceId,
            availability: { status: 'ready' },
        });

        const uninstalled = composerAttachmentDraftToView(draft, { entriesById: {} });
        expect(uninstalled).toMatchObject({
            ...draft,
            availability: { status: 'unavailable' },
        });

        const updatedButCompatible = {
            ...issueAttachmentCatalogEntry,
            immutableGenerationId: 'issues-generation-2',
        } satisfies PluginProjectedComposerAttachmentEntryV1;
        expect(composerAttachmentDraftToView(draft, catalog(updatedButCompatible))).toMatchObject({
            instanceId: draft.instanceId,
            availability: { status: 'ready' },
        });

        const updatedWithIncompatibleValue = {
            ...updatedButCompatible,
            immutableGenerationId: 'issues-generation-3',
            definition: {
                ...updatedButCompatible.definition,
                valueSchema: {
                    type: 'object',
                    required: ['issueRef'],
                    properties: {
                        issueRef: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        } satisfies PluginProjectedComposerAttachmentEntryV1;
        expect(composerAttachmentDraftToView(draft, catalog(updatedWithIncompatibleValue))).toMatchObject({
            ...draft,
            availability: { status: 'invalid' },
        });

        const reinstalled = {
            ...issueAttachmentCatalogEntry,
            immutableGenerationId: 'issues-generation-4',
        } satisfies PluginProjectedComposerAttachmentEntryV1;
        const reinstalledView = composerAttachmentDraftToView(draft, catalog(reinstalled));
        expect(reinstalledView).toMatchObject({
            instanceId: draft.instanceId,
            availability: { status: 'ready' },
        });
        expect(composerAttachmentViewToDraft(reinstalledView)).toEqual(draft);
    });

    it('preserves the incumbent rich mention fields while applying a Composer reference label replacement', () => {
        const existing = [{
            kind: 'vendorPlugin',
            vendorPluginRef: 'plugin://gmail@openai-curated',
            label: 'Gmail',
            backendId: 'gmail',
            tokenText: '@gmail',
        }] satisfies readonly ComposerStructuredInputMention[];
        const originalReferences = composerReferencesFromStructuredMentions({
            text: 'Email @gmail now',
            mentions: existing,
        });
        expect(originalReferences).toEqual([{
            kind: 'happier.vendorPlugin',
            ref: 'vendorPlugin:plugin://gmail@openai-curated',
            token: '@gmail',
            label: 'Gmail',
            start: 6,
            end: 12,
        }]);

        const rebased: ComposerMentionRef = {
            ...originalReferences[0]!,
            label: 'Updated Gmail',
            start: 12,
            end: 18,
        };
        expect(composerStructuredMentionsFromReferences({
            references: [rebased],
            existing,
        })).toEqual([{
            ...existing[0],
            label: 'Updated Gmail',
        }]);
    });

    it('maps a Composer skill label replacement onto displayName without losing catalog identity', () => {
        const existing = [{
            kind: 'skill',
            tokenText: '$review',
            id: 'vendor:codex:codex-native:review',
            name: 'review',
            path: '/skills/review/SKILL.md',
            displayName: 'Review',
            origin: 'vendor',
            projectionRef: 'codex-native:review',
            backendId: 'codex',
            agentId: 'codex-agent',
        }] satisfies readonly ComposerStructuredInputMention[];
        const [reference] = composerReferencesFromStructuredMentions({
            text: '$review',
            mentions: existing,
        });
        if (!reference) throw new Error('expected referenceable skill mention');

        expect(composerStructuredMentionsFromReferences({
            references: [{ ...reference, label: 'Updated review' }],
            existing,
        })).toEqual([{
            ...existing[0],
            displayName: 'Updated review',
        }]);
    });

    it('keeps a newly inserted Protocol reference opaque instead of interpreting another plugin kind locally', () => {
        const references: readonly ComposerMentionRef[] = [{
            kind: 'acme.issue',
            ref: 'issue:42',
            token: '@issue-42',
            label: 'Issue #42',
            start: 0,
            end: 9,
        }];

        expect(composerStructuredMentionsFromReferences({ references, existing: [] })).toEqual([{
            kind: 'acme.issue',
            ref: 'issue:42',
            tokenText: '@issue-42',
            label: 'Issue #42',
        }]);
    });

    it('round-trips a newly materialized provider reference through the structured-input writer', () => {
        const reference = {
            ...buildComposerReferenceMentionPayloadV1({
                reference: { pluginId: 'acme.issues', localId: 'issues' },
                candidate: { id: 'incident-42', label: 'Incident 42' },
            }),
            token: '@incident-42',
            start: 0,
            end: 12,
        } satisfies ComposerMentionRef;
        const mentions = composerStructuredMentionsFromReferences({
            references: [reference],
            existing: [],
        });
        const envelope = readHappierStructuredInputV1FromMeta(buildStructuredInputMetaOverrides({
            mentions,
            text: 'Investigate @incident-42',
        }));
        const [writtenReference] = envelope?.mentions ?? [];

        expect(readComposerReferenceMentionV1(writtenReference)).toEqual({
            reference: { pluginId: 'acme.issues', localId: 'issues' },
            candidateId: 'incident-42',
            label: 'Incident 42',
        });
    });
});
