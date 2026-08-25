import { describe, expect, it } from 'vitest';

import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol';
import { readAdmittedHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime';

import { SESSION_DRAFT_VALUE_FIELD_CATALOG } from '../../../sync/domains/input/draftValues/sessionDraftValueFieldCatalog';

import type { PendingMessageComposerEditState } from './pendingMessageComposerEditSnapshot';
import {
    buildPendingMessageComposerEditStructuredInput,
    decidePendingMessageComposerRotation,
    derivePendingMessageComposerSuccessorEditState,
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

    it('refuses a write-back whose staged media the Pending consumer cannot admit', () => {
        // The premise this case used to encode — that a Pending row is re-sent
        // verbatim through the send RPC, so the daemon's SessionMedia finalizer
        // later resolves the claim — is false. Materialization delivers the
        // stored envelope straight to the Agent queue, which reads it with the
        // canonical admitted reader below. Persisting an unfinalized staged
        // claim therefore made the queue reject the whole prompt before the
        // provider: the user's edited message silently never ran. Refusing the
        // save keeps the draft and reports the failure instead.
        expect(readAdmittedHappierStructuredInputV1FromMeta({
            [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
                v: 1,
                composerAttachments: [stagedMediaAttachment],
            },
        })).toEqual({ status: 'invalid' });

        expect(buildPendingMessageComposerEditStructuredInput({
            text: 'Queued edit text',
            mentions: [],
            attachments: [stagedMediaAttachment],
        })).toEqual({ status: 'unavailable' });
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

describe('pending message composer successor rejoin', () => {
    it('publishes the successor owner\'s canonical revision instead of the retired owner\'s', () => {
        const retiredDocument = {
            text: 'edited text',
            mentions: [],
            attachments: [],
            revision: 7,
        };
        const current = {
            pendingId: 'pending-1',
            localId: 'pending-1',
            holdId: 'hold-1',
            accountScope: null,
            accountLifetime: null,
            document: retiredDocument,
            admittedDocument: { ...retiredDocument, text: 'original text', revision: 0 },
        };
        const { edit: next, owner: successorOwner } = derivePendingMessageComposerSuccessorEditState({
            current,
            sessionId: 'session-1',
            successorLocalId: 'pending-2',
            admitted: { text: 'edited text', mentions: [], attachments: [] },
            readMountedEditLocalId: () => 'pending-2',
        });

        expect(next.localId).toBe('pending-2');
        expect(next.pendingId).toBe('pending-2');
        expect(next.document.revision).toBe(successorOwner.read().revision);
        expect(next.admittedDocument.revision).toBe(successorOwner.read().revision);
        expect(next.document.text).toBe('edited text');
        // The retired counter must not survive the rotation in either document.
        expect(next.document.revision).not.toBe(retiredDocument.revision);
    });

    it('keeps tracking the successor owner after it advances', () => {
        const current = {
            pendingId: 'pending-1',
            localId: 'pending-1',
            holdId: 'hold-1',
            accountScope: null,
            accountLifetime: null,
            document: { text: 'a', mentions: [], attachments: [], revision: 4 },
            admittedDocument: { text: 'a', mentions: [], attachments: [], revision: 4 },
        };
        const { owner: successorOwner } = derivePendingMessageComposerSuccessorEditState({
            current,
            sessionId: 'session-1',
            successorLocalId: 'pending-2',
            admitted: { text: 'a', mentions: [], attachments: [] },
            readMountedEditLocalId: () => 'pending-2',
        });
        const advanced = successorOwner.replaceDocument({
            text: 'b',
            structuredInputMentions: [],
            composerAttachments: [],
        });

        const rederived = derivePendingMessageComposerSuccessorEditState({
            current: { ...current, document: { ...current.document, text: 'b' } },
            sessionId: 'session-1',
            successorLocalId: 'pending-2',
            admitted: { text: 'a', mentions: [], attachments: [] },
            readMountedEditLocalId: () => 'pending-2',
        });

        expect(advanced).toBeGreaterThan(0);
        expect(successorOwner.read().revision).toBe(advanced);
        expect(rederived.edit.document.text).toBe('b');
    });

    it('refuses a successor mutation once the Account scope that opened the edit is replaced', () => {
        let scopeCurrent = true;
        const current = {
            pendingId: 'pending-1',
            localId: 'pending-1',
            holdId: 'hold-1',
            accountScope: null,
            accountLifetime: {
                scope: null,
                isCurrent: () => scopeCurrent,
            } as unknown as PendingMessageComposerEditState['accountLifetime'],
            document: { text: 'a', mentions: [], attachments: [], revision: 0 },
            admittedDocument: { text: 'a', mentions: [], attachments: [], revision: 0 },
        };

        const { owner } = derivePendingMessageComposerSuccessorEditState({
            current,
            sessionId: 'session-1',
            successorLocalId: 'pending-2',
            admitted: { text: 'a', mentions: [], attachments: [] },
            readMountedEditLocalId: () => 'pending-2',
        });

        // Positive control: while the scope stands, the successor accepts a write.
        expect(owner.apply(0, { text: 'b', references: [], attachments: [] }))
            .toMatchObject({ status: 'applied' });

        scopeCurrent = false;

        // The retired owner refused a write from a replaced Account scope; the
        // successor the rotation installs must refuse it identically.
        expect(owner.apply(owner.read().revision, { text: 'c', references: [], attachments: [] }))
            .toEqual({ status: 'composerUnavailable' });
    });
});

describe('pending message composer rotation decision', () => {
    function allocator(ids: readonly string[]): () => string {
        let index = 0;
        return () => {
            const next = ids[index];
            index += 1;
            if (next === undefined) throw new Error('rotation allocated more identities than expected');
            return next;
        };
    }

    it('rotates a changed prepared-attachment payload onto a fresh identity', () => {
        const decision = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F1',
            requiresPreparation: true,
            exposed: null,
            allocateLocalId: allocator(['pending-2']),
        });

        expect(decision.replacementLocalId).toBe('pending-2');
        expect(decision.exposed).toEqual({ localId: 'pending-2', fingerprint: 'F1' });
    });

    it('rotates again when a later text-only edit changes the payload under an exposed successor', () => {
        const first = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F1',
            requiresPreparation: true,
            exposed: null,
            allocateLocalId: allocator(['pending-2']),
        });
        // The successor has been rejoined, so the open edit now names it.
        const second = decidePendingMessageComposerRotation({
            pendingId: 'pending-2',
            fingerprint: 'F2',
            requiresPreparation: false,
            exposed: first.exposed,
            allocateLocalId: allocator(['pending-3']),
        });

        expect(second.replacementLocalId).toBe('pending-3');
        expect(second.exposed).toEqual({ localId: 'pending-3', fingerprint: 'F2' });
    });

    it('keeps an exposed identity when the exact same payload is resubmitted', () => {
        const first = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F1',
            requiresPreparation: true,
            exposed: null,
            allocateLocalId: allocator(['pending-2']),
        });
        // Response lost: the edit still names the predecessor.
        const retry = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F1',
            requiresPreparation: true,
            exposed: first.exposed,
            allocateLocalId: allocator([]),
        });
        // Rejoined: the edit names the successor and nothing changed.
        const idle = decidePendingMessageComposerRotation({
            pendingId: 'pending-2',
            fingerprint: 'F1',
            requiresPreparation: true,
            exposed: first.exposed,
            allocateLocalId: allocator([]),
        });

        expect(retry.replacementLocalId).toBe('pending-2');
        expect(idle.replacementLocalId).toBeUndefined();
        expect(idle.exposed).toEqual({ localId: 'pending-2', fingerprint: 'F1' });
    });

    it('leaves a never-exposed row unrotated for an ordinary text-only edit', () => {
        const decision = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F1',
            requiresPreparation: false,
            exposed: null,
            allocateLocalId: allocator([]),
        });

        expect(decision.replacementLocalId).toBeUndefined();
        expect(decision.exposed).toBeNull();
    });

    it('rotates a changed non-preparing payload while the edit still names the predecessor', () => {
        const first = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F1',
            requiresPreparation: true,
            exposed: null,
            allocateLocalId: allocator(['pending-2']),
        });
        // The response was lost, so the mounted edit still names `pending-1`
        // while `pending-2` has already been exposed for `F1`.
        const changed = decidePendingMessageComposerRotation({
            pendingId: 'pending-1',
            fingerprint: 'F2',
            requiresPreparation: false,
            exposed: first.exposed,
            allocateLocalId: allocator(['pending-3']),
        });

        expect(changed.replacementLocalId).toBe('pending-3');
        expect(changed.exposed).toEqual({ localId: 'pending-3', fingerprint: 'F2' });
    });
});
