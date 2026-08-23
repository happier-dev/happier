import { describe, expect, it } from 'vitest';

import { SESSION_DRAFT_VALUE_FIELD_CATALOG } from '../../../sync/domains/input/draftValues/sessionDraftValueFieldCatalog';

import {
    buildPendingMessageComposerEditStructuredInput,
    hydratePendingMessageComposerAttachmentDrafts,
    isEmptyPendingMessageComposerSemanticDraftSnapshot,
    readPendingMessageComposerSemanticDraftFieldsToRestore,
    type PendingMessageComposerSemanticDraftMutationRevisions,
    type PendingMessageComposerSemanticDraftSnapshot,
} from './pendingMessageComposerEditSnapshot';

const stagedMediaAttachment = {
    v: 1,
    instanceId: 'issue-42',
    attachment: { pluginId: 'acme.issues', localId: 'issue' },
    key: '42',
    value: { issueId: 42 },
    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
    content: {
        kind: 'stagedMedia',
        handle: {
            v: 1,
            id: 'stage-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'acme.issues', localId: 'issue' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'screenshot.png',
            sizeBytes: 1234,
            sha256: 'a'.repeat(64),
        },
    },
} as const;

function createSnapshotWithValue(fieldId: string): PendingMessageComposerSemanticDraftSnapshot {
    return Object.fromEntries(Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG).map((key) => [
        key,
        key === fieldId ? null : undefined,
    ])) as unknown as PendingMessageComposerSemanticDraftSnapshot;
}

describe('pending message composer semantic draft snapshot', () => {
    it('hydrates only contentless admitted attachment inputs without inventing draft content handles', () => {
        expect(hydratePendingMessageComposerAttachmentDrafts({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: 'issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                }],
            },
        })).toEqual({
            status: 'ready',
            attachments: [{
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            }],
        });
    });

    it('writes back a contentless attachment the Pending row can persist', () => {
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        expect(buildPendingMessageComposerEditStructuredInput({
            text: 'Queued edit text',
            mentions: [],
            attachments: [attachment],
        })).toEqual({
            status: 'ready',
            structuredInput: { v: 1, composerAttachments: [attachment] },
        });
    });

    it('writes back an attachment that still owns its transfer-staged claim', () => {
        // A Pending row is Message ingress: it is re-sent verbatim through the send RPC, so
        // the daemon's SessionMedia finalizer — not this write-back — turns a staged claim
        // into a durable reference. Refusing it here made a prepared media attachment
        // impossible to save and stranded the media the preparation had already staged.
        expect(buildPendingMessageComposerEditStructuredInput({
            text: 'Queued edit text',
            mentions: [],
            attachments: [stagedMediaAttachment],
        })).toEqual({
            status: 'ready',
            structuredInput: { v: 1, composerAttachments: [stagedMediaAttachment] },
        });
    });

    it('refuses a write-back whose attachment cannot be read as Pending ingress', () => {
        expect(buildPendingMessageComposerEditStructuredInput({
            text: 'Queued edit text',
            mentions: [],
            attachments: [{
                ...stagedMediaAttachment,
                content: {
                    kind: 'stagedMedia',
                    handle: { ...stagedMediaAttachment.content.handle, mimeType: 'application/pdf' },
                },
            } as unknown as typeof stagedMediaAttachment],
        })).toEqual({ status: 'unavailable' });
    });

    it('reopens a queued media message instead of refusing the edit outright', () => {
        expect(hydratePendingMessageComposerAttachmentDrafts({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [stagedMediaAttachment],
            },
        })).toEqual({
            status: 'ready',
            attachments: [stagedMediaAttachment],
        });
    });

    it('keeps a media-bearing admitted attachment unavailable rather than dropping its media id or inventing a content handle', () => {
        expect(hydratePendingMessageComposerAttachmentDrafts({
            happierStructuredInputV1: {
                v: 1,
                composerAttachments: [{
                    v: 1,
                    instanceId: 'issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                    content: { kind: 'sessionMedia', mediaId: 'media-42' },
                }],
            },
        })).toEqual({ status: 'unavailable' });
    });

    it('hydrates an admitted reference beside contentless attachments for the pending composer owner', () => {
        const mention = {
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
            start: 0,
            end: 13,
        } as const;
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;

        expect(hydratePendingMessageComposerAttachmentDrafts({
            happierStructuredInputV1: {
                v: 1,
                mentions: [mention],
                composerAttachments: [attachment],
            },
        }, '@src/index.ts')).toEqual({
            status: 'ready',
            mentions: [mention],
            attachments: [attachment],
        });
    });

    it('treats every field registered by the draft catalog as semantic draft state', () => {
        for (const fieldId of Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG)) {
            expect(isEmptyPendingMessageComposerSemanticDraftSnapshot(
                createSnapshotWithValue(fieldId),
            )).toBe(false);
        }
    });

    it('restores only prior fields that stayed empty while the queued edit was active', () => {
        const fieldIds = Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG) as Array<
            keyof typeof SESSION_DRAFT_VALUE_FIELD_CATALOG
        >;
        const previous = {
            ...createSnapshotWithValue('routing.recipient'),
            'routing.recipient': { kind: 'execution_run', runId: 'run-a' },
            'routing.executionRunDelivery': 'interrupt',
        } as PendingMessageComposerSemanticDraftSnapshot;
        const current = {
            ...createSnapshotWithValue('structuredInput.mentions'),
            'routing.executionRunDelivery': 'prompt',
        } as PendingMessageComposerSemanticDraftSnapshot;

        expect(readPendingMessageComposerSemanticDraftFieldsToRestore(
            previous,
            current,
            fieldIds,
        )).toEqual(['routing.recipient']);
    });

    it('does not restore a prior field after an explicit clear during the queued edit', () => {
        const fieldIds = Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG) as Array<
            keyof typeof SESSION_DRAFT_VALUE_FIELD_CATALOG
        >;
        const previous = {
            ...createSnapshotWithValue('routing.recipient'),
            'routing.recipient': { kind: 'execution_run', runId: 'run-a' },
        } as PendingMessageComposerSemanticDraftSnapshot;
        const current = createSnapshotWithValue('structuredInput.mentions');
        const revisionsAtEditClear = Object.fromEntries(fieldIds.map((fieldId) => [fieldId, 1])) as PendingMessageComposerSemanticDraftMutationRevisions;
        const revisionsAfterExplicitClear = {
            ...revisionsAtEditClear,
            'routing.recipient': 2,
        } satisfies PendingMessageComposerSemanticDraftMutationRevisions;

        expect(readPendingMessageComposerSemanticDraftFieldsToRestore(
            previous,
            current,
            fieldIds,
            revisionsAtEditClear,
            revisionsAfterExplicitClear,
        )).toEqual([]);
    });

    it('restores the prior generic attachments when an unchanged contentless pending edit is abandoned', () => {
        const fieldIds = Object.keys(SESSION_DRAFT_VALUE_FIELD_CATALOG) as Array<
            keyof typeof SESSION_DRAFT_VALUE_FIELD_CATALOG
        >;
        const priorAttachments = [{
            v: 1,
            instanceId: 'prior-issue',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'prior-42',
            value: { issueId: 42 },
            presentation: { label: 'Prior issue', typeLabel: 'Issue' },
        }];
        const loadedPendingAttachments = [{
            v: 1,
            instanceId: 'pending-issue',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'pending-43',
            value: { issueId: 43 },
            presentation: { label: 'Pending issue', typeLabel: 'Issue' },
        }];
        const previous = {
            ...createSnapshotWithValue(''),
            'structuredInput.composerAttachments': priorAttachments,
        } as PendingMessageComposerSemanticDraftSnapshot;
        const current = {
            ...createSnapshotWithValue(''),
            'structuredInput.composerAttachments': loadedPendingAttachments,
        } as PendingMessageComposerSemanticDraftSnapshot;
        const loaded = {
            ...createSnapshotWithValue(''),
            'structuredInput.composerAttachments': loadedPendingAttachments,
        } as PendingMessageComposerSemanticDraftSnapshot;
        const revisions = Object.fromEntries(fieldIds.map((fieldId) => [fieldId, 1])) as PendingMessageComposerSemanticDraftMutationRevisions;

        expect(readPendingMessageComposerSemanticDraftFieldsToRestore(
            previous,
            current,
            fieldIds,
            revisions,
            revisions,
            loaded,
        )).toEqual(['structuredInput.composerAttachments']);
    });

});
