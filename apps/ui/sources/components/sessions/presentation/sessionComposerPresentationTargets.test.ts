import type {
    ComposerStagedMediaContentV1,
    ComposerSnapshotV1,
    ComposerTransactionV1,
    ComposerTransactionResultV1,
    PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    readSessionDraftValue,
    resetSessionDraftValueCachesForTests,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import { storage } from '@/sync/domains/state/storage';
import { loadSessionDrafts, saveSessionDrafts } from '@/sync/domains/state/sessionPersistence';
import type { releaseComposerContent } from '@/sync/domains/transfers/runtime/transferRuntime';

const persistentValues = vi.hoisted(() => new Map<string, string>());
const activeScopeState = vi.hoisted(() => ({
    value: null as Readonly<{ serverId: string; accountId: string }> | null,
}));
const releaseComposerContentSpy = vi.hoisted(() => (
    vi.fn<typeof releaseComposerContent>(async () => ({ success: true } as const))
));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistentValues.get(key);
        }

        set(key: string, value: string) {
            persistentValues.set(key, value);
        }

        delete(key: string) {
            persistentValues.delete(key);
        }
    }

    return { MMKV };
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => activeScopeState.value,
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    releaseComposerContent: releaseComposerContentSpy,
}));

import {
    applyComposerPresentationTransaction,
    createComposerPresentationTransactionApplier,
    notifyComposerPresentationTargetChanged,
    readComposerPresentationSnapshot,
    readComposerPresentationTarget,
    readSessionComposerPresentationTarget,
    registerComposerPresentationTarget,
    subscribeComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from './sessionComposerPresentationTargets';
import { applyCurrentSessionPresentationCommand } from './applyCurrentSessionPresentationCommand';

function createAttachmentProjectionEntry(input: Readonly<{
    pluginId: string;
    localId: string;
    typeLabel: string;
    immutableGenerationId?: string;
    cardinality?: 'one' | 'many';
}>): PluginProjectedComposerAttachmentEntryV1 {
    return {
        id: `${input.pluginId}/${input.localId}`,
        pluginId: input.pluginId,
        identity: { pluginId: input.pluginId, localId: input.localId },
        immutableGenerationId: input.immutableGenerationId ?? `${input.pluginId}-generation`,
        definition: {
            id: input.localId,
            title: input.typeLabel,
            icon: 'file',
            cardinality: input.cardinality ?? 'many',
            valueSchema: { type: 'object' },
        },
    };
}

function createAttachmentTransactionApplier(
    ...entries: readonly PluginProjectedComposerAttachmentEntryV1[]
) {
    return createComposerPresentationTransactionApplier({
        composerAttachmentsById: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    });
}

function admittedContributor(input: Readonly<{
    pluginId: string;
    immutableGenerationId?: string;
}>) {
    return {
        identity: { pluginId: input.pluginId, localId: 'control' },
        immutableGenerationId: input.immutableGenerationId ?? `${input.pluginId}-generation`,
    };
}

function createStagedMediaContent(): ComposerStagedMediaContentV1 {
    return {
        kind: 'stagedMedia',
        handle: {
            v: 1,
            id: 'stage-42',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'acme.issues', localId: 'issue' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'issue-42.png',
            sizeBytes: 12,
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
    };
}

function createSnapshot(overrides: Partial<ComposerSnapshotV1> = {}): ComposerSnapshotV1 {
    return {
        revision: 1,
        ref: { kind: 'session', sessionId: 'session-1' },
        text: '',
        references: [],
        attachments: [],
        layout: 'wrap',
        capabilities: {
            text: true,
            references: true,
            attachments: true,
            submit: true,
        },
        state: {
            focused: false,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        },
        ...overrides,
    };
}

function createDocumentTarget(initial: ComposerSnapshotV1): ComposerPresentationTarget & Readonly<{
    readCurrent: () => ComposerSnapshotV1;
}> {
    let current = initial;
    return {
        readRevision: () => current.revision,
        replace: (text, expectedRevision) => {
            if (current.revision !== expectedRevision) return current.revision;
            current = { ...current, text, revision: current.revision + 1 };
            return current.revision;
        },
        readSnapshot: () => current,
        commitDocument: (input: Readonly<{
            expectedRevision: number;
            mutation: ComposerPresentationDocumentMutation;
        }>): ComposerTransactionResultV1 => {
            if (current.revision !== input.expectedRevision) {
                return { status: 'conflict', currentRevision: current.revision };
            }
            current = {
                ...current,
                ...input.mutation,
                references: [...input.mutation.references],
                attachments: [...input.mutation.attachments],
                revision: current.revision + 1,
            };
            return { status: 'applied', revision: current.revision };
        },
        createAttachmentInstanceId: () => 'host-created-issue-42',
        readCurrent: () => current,
    };
}

describe('composer presentation targets', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()?.();
        releaseComposerContentSpy.mockClear();
    });

    it('keeps distinct live composer scope arms from colliding in the one target registry', () => {
        const sessionTarget = { readRevision: vi.fn(() => 1), replace: vi.fn(() => 1) };
        const pendingTarget = { readRevision: vi.fn(() => 2), replace: vi.fn(() => 2) };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionTarget,
        ));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            pendingTarget,
        ));

        expect(readComposerPresentationTarget({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({ revision: 1, replace: sessionTarget.replace });
        expect(readComposerPresentationTarget({ kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' }))
            .toMatchObject({ revision: 2, replace: pendingTarget.replace });
    });

    it('does not let an obsolete registration cleanup retire the current target', () => {
        const oldTarget = { readRevision: vi.fn(() => 1), replace: vi.fn(() => 1) };
        const currentTarget = { readRevision: vi.fn(() => 2), replace: vi.fn(() => 2) };
        const retireOld = registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            oldTarget,
        );
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            currentTarget,
        ));

        retireOld();

        expect(readComposerPresentationTarget({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({ revision: 2, replace: currentTarget.replace });
    });

    it('adds and removes an exact plugin attachment through one explicitly addressed composer without a control or picker', () => {
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        const added = applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        });

        expect(added).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-42'],
        });
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 'session-1' }))
            .toMatchObject({
                revision: 2,
                attachments: [{
                    instanceId: 'host-created-issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                    availability: { status: 'ready' },
                }],
            });
        expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 'session-1' })?.attachments[0])
            .not.toHaveProperty('content');

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 2,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        })).toEqual({ status: 'applied', revision: 3 });
        expect(target.readCurrent().attachments).toEqual([]);
    });

    it('preserves an opaque staged-media claim through the canonical attachment add and draft snapshot', () => {
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const stagedMedia = createStagedMediaContent();
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: stagedMedia.handle.executionTarget,
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: stagedMedia,
                }],
            },
        })).toMatchObject({ status: 'applied', revision: 2 });

        expect(target.readCurrent().attachments).toMatchObject([{
            instanceId: 'host-created-issue-42',
            content: stagedMedia,
        }]);
    });

    it('retains staged custody when a contentless add upserts the same attachment key', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42, refreshed: true },
                        presentation: { label: 'Issue #42 (refreshed)' },
                    },
                }],
            },
        })).toMatchObject({ status: 'applied', revision: 2 });

        expect(target.readCurrent().attachments).toMatchObject([{
            instanceId: 'host-created-issue-42',
            value: { issueId: 42, refreshed: true },
            content: stagedMedia,
        }]);
        await Promise.resolve();
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
    });

    it('releases removed staged media only after the canonical document transaction commits', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 1,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        })).toEqual({ status: 'applied', revision: 2 });
        expect(target.readCurrent().attachments).toEqual([]);

        await Promise.resolve();
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle);
    });

    it('releases only the replaced staged claim after an authoritative attachment upsert', async () => {
        const stagedMedia = createStagedMediaContent();
        const replacement: ComposerStagedMediaContentV1 = {
            kind: 'stagedMedia',
            handle: {
                ...stagedMedia.handle,
                id: 'stage-43',
                name: 'issue-43.png',
            },
        };
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
                content: stagedMedia,
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            executionTarget: replacement.handle.executionTarget,
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 43 },
                        presentation: { label: 'Issue #43' },
                    },
                    content: replacement,
                }],
            },
        })).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-issue-42'],
        });

        await Promise.resolve();
        expect(target.readCurrent().attachments).toMatchObject([{ content: replacement }]);
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(stagedMedia.handle);
        expect(releaseComposerContentSpy).not.toHaveBeenCalledWith(replacement.handle);
    });

    it('does not release a staged claim when the document owner rejects the transaction', async () => {
        const stagedMedia = createStagedMediaContent();
        const target = {
            ...createDocumentTarget(createSnapshot({
                attachments: [{
                    v: 1,
                    instanceId: 'host-created-issue-42',
                    attachment: { pluginId: 'acme.issues', localId: 'issue' },
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                    availability: { status: 'ready' },
                    content: stagedMedia,
                }],
            })),
            commitDocument: (): ComposerTransactionResultV1 => ({ status: 'conflict', currentRevision: 2 }),
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 1,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        })).toEqual({ status: 'conflict', currentRevision: 2 });

        await Promise.resolve();
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
    });

    it('applies all host-authorized attachment additions atomically while rejecting a foreign or missing local id', () => {
        const issueEntry = createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        });
        const labelEntry = createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'label',
            typeLabel: 'Label',
        });
        let nextInstance = 0;
        const target = {
            ...createDocumentTarget(createSnapshot()),
            createAttachmentInstanceId: () => `host-created-${++nextInstance}`,
        };
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(issueEntry, labelEntry);
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'label',
                        value: {
                            key: 'urgent',
                            value: { label: 'urgent' },
                            presentation: { label: 'Urgent' },
                        },
                    },
                ],
            },
        })).toEqual({
            status: 'applied',
            revision: 2,
            attachmentInstanceIds: ['host-created-1', 'host-created-2'],
        });
        expect(target.readCurrent().attachments).toMatchObject([
            { attachment: issueEntry.identity, key: '42' },
            { attachment: labelEntry.identity, key: 'urgent' },
        ]);

        const rejectedTarget = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-2' },
            rejectedTarget,
        ));
        const rejectedApplier = createAttachmentTransactionApplier(issueEntry);
        expect(rejectedApplier.apply({
            ref: { kind: 'session', sessionId: 'session-2' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'foreign-plugin-attachment',
                        value: {
                            key: 'foreign',
                            value: { foreign: true },
                            presentation: { label: 'Foreign' },
                        },
                    },
                ],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 1,
            reason: 'attachment_authority_mismatch',
        });
        expect(rejectedTarget.readCurrent()).toMatchObject({ revision: 1, attachments: [] });

        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-2' },
            admittedContributor: admittedContributor({
                pluginId: 'acme.issues',
                immutableGenerationId: 'retired-generation',
            }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'attachment_authority_mismatch',
        });
        expect(rejectedTarget.readCurrent()).toMatchObject({ revision: 1, attachments: [] });
    });

    it('rejects an attachment local-id forged outside the exact caller contribution without changing the document', () => {
        const target = createDocumentTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'review',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            },
        })).toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'attachment_authority_mismatch',
        });
        expect(target.readCurrent()).toMatchObject({ revision: 1, attachments: [] });
    });

    it('resolves a media attachment owner only from the exact admitted attachment authority', () => {
        const applier = createAttachmentTransactionApplier(
            createAttachmentProjectionEntry({
                pluginId: 'acme.issues',
                localId: 'issue',
                typeLabel: 'Issue',
            }),
            createAttachmentProjectionEntry({
                pluginId: 'acme.issues',
                localId: 'review',
                typeLabel: 'Review',
            }),
        );

        expect(applier.resolveAttachmentIdentity({
            attachmentLocalId: 'issue',
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
        })).toEqual({ pluginId: 'acme.issues', localId: 'issue' });
        expect(applier.resolveAttachmentIdentity({
            attachmentLocalId: 'missing',
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
        })).toBeNull();
        expect(applier.resolveAttachmentIdentity({
            attachmentLocalId: 'issue',
            admittedContributor: admittedContributor({
                pluginId: 'acme.issues',
                immutableGenerationId: 'retired-generation',
            }),
        })).toBeNull();
    });

    it('keeps a one-cardinality attachment at one host-owned instance when a caller changes its key', () => {
        const target = createDocumentTarget(createSnapshot({
            attachments: [{
                v: 1,
                instanceId: 'host-created-issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
                availability: { status: 'ready' },
            }],
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
            cardinality: 'one',
        }));
        expect(applier.apply({
            ref: { kind: 'session', sessionId: 'session-1' },
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: 1,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '77',
                        value: { issueId: 77 },
                        presentation: { label: 'Issue #77' },
                    },
                }],
            },
        })).toMatchObject({ status: 'applied', revision: 2 });
        expect(target.readCurrent().attachments).toEqual([{
            v: 1,
            instanceId: 'host-created-issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '77',
            value: { issueId: 77 },
            presentation: { label: 'Issue #77', typeLabel: 'Issue' },
            availability: { status: 'ready' },
        }]);
    });

    it('rejects a stale transaction before any operation is committed', () => {
        const target = createDocumentTarget(createSnapshot({ text: 'before', revision: 4 }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            target,
        ));

        expect(applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: {
                expectedRevision: 3,
                operations: [{ kind: 'text.set', text: 'after' }],
            },
        })).toEqual({ status: 'conflict', currentRevision: 4 });
        expect(target.readCurrent()).toMatchObject({ revision: 4, text: 'before' });
    });

    it('observes only its exact composer scope and stops after disposal', () => {
        const sessionTarget = createDocumentTarget(createSnapshot());
        const pendingTarget = createDocumentTarget(createSnapshot({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionTarget,
        ));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            pendingTarget,
        ));
        const listener = vi.fn();
        const dispose = subscribeComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            listener,
        );

        applyComposerPresentationTransaction({
            ref: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' },
            transaction: { expectedRevision: 1, operations: [{ kind: 'text.set', text: 'pending' }] },
        });
        expect(listener).not.toHaveBeenCalled();

        applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: { expectedRevision: 1, operations: [{ kind: 'text.set', text: 'main' }] },
        });
        expect(listener).toHaveBeenCalledTimes(1);

        dispose();
        applyComposerPresentationTransaction({
            ref: { kind: 'session', sessionId: 'session-1' },
            transaction: { expectedRevision: 2, operations: [{ kind: 'text.set', text: 'later' }] },
        });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies only the exact live scope when an incumbent adapter changes outside a transaction', () => {
        const sessionTarget = createDocumentTarget(createSnapshot());
        const participantTarget = createDocumentTarget(createSnapshot({
            ref: { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
        }));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionTarget,
        ));
        cleanups.push(registerComposerPresentationTarget(
            { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
            participantTarget,
        ));
        const sessionListener = vi.fn();
        const participantListener = vi.fn();
        const disposeSession = subscribeComposerPresentationTarget(
            { kind: 'session', sessionId: 'session-1' },
            sessionListener,
        );
        const disposeParticipant = subscribeComposerPresentationTarget(
            { kind: 'participantMessage', sessionId: 'session-1', instanceId: 'participant-1' },
            participantListener,
        );

        notifyComposerPresentationTargetChanged({
            kind: 'participantMessage',
            sessionId: 'session-1',
            instanceId: 'participant-1',
        });
        expect(sessionListener).not.toHaveBeenCalled();
        expect(participantListener).toHaveBeenCalledTimes(1);

        disposeSession();
        disposeParticipant();
    });
});

const persistentSessionScope: ServerAccountScope = {
    serverId: 'server-persistent',
    accountId: 'account-persistent',
};

function activatePersistentSessionDraft(sessionId: string, text: string): void {
    persistentValues.clear();
    resetSessionDraftValueCachesForTests();
    activeScopeState.value = persistentSessionScope;
    storage.getState().clearSessionLocalStateScope();
    saveSessionDrafts({ [sessionId]: text }, persistentSessionScope);
    storage.getState().activateSessionLocalStateScope(persistentSessionScope);
    storage.setState((state) => ({
        ...state,
        deletedSessionIds: {},
    }));
}

function readPersistentSessionSnapshot(sessionId: string): ComposerSnapshotV1 {
    const snapshot = readComposerPresentationSnapshot({ kind: 'session', sessionId });
    if (!snapshot) throw new Error('Expected the current-account persistent Session fallback');
    return snapshot;
}

describe('persistent Session composer fallback', () => {
    afterEach(() => {
        activeScopeState.value = null;
        storage.getState().clearSessionLocalStateScope();
        persistentValues.clear();
        resetSessionDraftValueCachesForTests();
    });

    it('reads, observes, and atomically applies an exact unmounted Session draft', () => {
        const sessionId = 'session-persistent-1';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const initial = readPersistentSessionSnapshot(sessionId);
        const observed = vi.fn();
        const dispose = subscribeComposerPresentationTarget(ref, observed);
        const applier = createAttachmentTransactionApplier(createAttachmentProjectionEntry({
            pluginId: 'acme.issues',
            localId: 'issue',
            typeLabel: 'Issue',
        }));

        const result = applier.apply({
            ref,
            admittedContributor: admittedContributor({ pluginId: 'acme.issues' }),
            transaction: {
                expectedRevision: initial.revision,
                operations: [
                    { kind: 'text.set', text: '@issue-42' },
                    {
                        kind: 'reference.insert',
                        reference: {
                            kind: 'acme.issue',
                            ref: 'issue:42',
                            token: '@issue-42',
                            label: 'Issue #42',
                            start: 0,
                            end: 9,
                        },
                    },
                    {
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                    },
                ],
            },
        });

        expect(result).toMatchObject({
            status: 'applied',
            revision: initial.revision + 1,
            attachmentInstanceIds: [expect.any(String)],
        });
        expect(loadSessionDrafts(persistentSessionScope)[sessionId]).toBe('@issue-42');
        expect(readSessionDraftValue(
            persistentSessionScope,
            sessionId,
            'structuredInput.mentions',
        )).toEqual([{
            kind: 'acme.issue',
            ref: 'issue:42',
            tokenText: '@issue-42',
            label: 'Issue #42',
        }]);
        expect(readSessionDraftValue(
            persistentSessionScope,
            sessionId,
            'structuredInput.composerAttachments',
        )).toMatchObject([{
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
        }]);
        expect(observed).toHaveBeenCalledTimes(1);
        dispose();
    });

    it('persists a replacement label when a transaction removes and reinserts the same reference identity', () => {
        const sessionId = 'session-persistent-reference-label';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, '@issue-42');

        const initial = readPersistentSessionSnapshot(sessionId);
        expect(applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: initial.revision,
                operations: [{
                    kind: 'reference.insert',
                    reference: {
                        kind: 'acme.issue',
                        ref: 'issue:42',
                        token: '@issue-42',
                        label: 'Issue #42',
                        start: 0,
                        end: 9,
                    },
                }],
            },
        }).status).toBe('applied');

        const seeded = readPersistentSessionSnapshot(sessionId);
        expect(applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: seeded.revision,
                operations: [
                    {
                        kind: 'reference.remove',
                        reference: { ref: 'issue:42', start: 0, end: 9 },
                    },
                    {
                        kind: 'reference.insert',
                        reference: {
                            kind: 'acme.issue',
                            ref: 'issue:42',
                            token: '@issue-42',
                            label: 'Renamed issue',
                            start: 0,
                            end: 9,
                        },
                    },
                ],
            },
        }).status).toBe('applied');

        expect(readSessionDraftValue(
            persistentSessionScope,
            sessionId,
            'structuredInput.mentions',
        )).toEqual([{
            kind: 'acme.issue',
            ref: 'issue:42',
            tokenText: '@issue-42',
            label: 'Renamed issue',
        }]);
        expect(readPersistentSessionSnapshot(sessionId).references).toEqual([
            expect.objectContaining({ ref: 'issue:42', label: 'Renamed issue' }),
        ]);
    });

    it('keeps the one Session revision continuous across mounted and unmounted access', () => {
        const sessionId = 'session-persistent-2';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        storage.getState().updateSessionDraft(sessionId, 'after');
        const persisted = readPersistentSessionSnapshot(sessionId);
        const unregister = registerComposerPresentationTarget(ref, createDocumentTarget({
            ...persisted,
            text: 'mounted text',
        }));

        expect(readComposerPresentationSnapshot(ref)?.revision).toBe(persisted.revision);
        unregister();

        expect(readPersistentSessionSnapshot(sessionId)).toMatchObject({
            revision: persisted.revision,
            text: 'after',
        });
    });

    it('notifies exact fallback observers for external persisted text writes and rejects their stale revision', () => {
        const sessionId = 'session-persistent-3';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const initial = readPersistentSessionSnapshot(sessionId);
        const observed = vi.fn();
        const dispose = subscribeComposerPresentationTarget(ref, observed);
        storage.getState().updateSessionDraft(sessionId, 'outside');

        const current = readPersistentSessionSnapshot(sessionId);
        expect(current).toMatchObject({
            revision: initial.revision + 1,
            text: 'outside',
        });
        expect(observed).toHaveBeenCalledTimes(1);
        expect(applyComposerPresentationTransaction({
            ref,
            transaction: {
                expectedRevision: initial.revision,
                operations: [{ kind: 'text.set', text: 'stale' }],
            },
        })).toEqual({ status: 'conflict', currentRevision: current.revision });
        dispose();
    });

    it('does not carry a fallback draft across Account replacement and retires it on known Session deletion', () => {
        const sessionId = 'session-persistent-4';
        const ref = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const observed = vi.fn();
        const dispose = subscribeComposerPresentationTarget(ref, observed);
        const replacementScope: ServerAccountScope = {
            serverId: 'server-persistent',
            accountId: 'account-replacement',
        };
        activeScopeState.value = replacementScope;
        storage.setState((state) => ({
            ...state,
            sessionLocalStateScope: replacementScope,
        }));

        // A fresh exact read follows the newly active Account, but never leaks
        // the former Account's persisted draft through the same Session id.
        expect(readComposerPresentationSnapshot(ref)).toMatchObject({
            revision: 0,
            text: '',
        });
        expect(observed).toHaveBeenCalledTimes(1);

        activeScopeState.value = persistentSessionScope;
        storage.getState().activateSessionLocalStateScope(persistentSessionScope);
        expect(readPersistentSessionSnapshot(sessionId)).toMatchObject({ text: 'before' });
        expect(observed).toHaveBeenCalledTimes(2);
        storage.setState((state) => ({
            ...state,
            deletedSessionIds: { ...state.deletedSessionIds, [sessionId]: true },
        }));

        expect(readComposerPresentationSnapshot(ref)).toBeNull();
        expect(observed).toHaveBeenCalledTimes(3);
        dispose();
    });

    it('keeps a pending-message registration separate from the persistent Session fallback', () => {
        const sessionId = 'session-persistent-5';
        const sessionRef = { kind: 'session', sessionId } as const;
        activatePersistentSessionDraft(sessionId, 'before');

        const unregister = registerComposerPresentationTarget(
            { kind: 'pendingMessage', sessionId, localId: 'pending-1' },
            createDocumentTarget(createSnapshot({
                ref: { kind: 'pendingMessage', sessionId, localId: 'pending-1' },
                text: 'pending',
            })),
        );
        try {
            expect(readComposerPresentationSnapshot(sessionRef)).toMatchObject({ text: 'before' });
            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId,
                localId: 'pending-1',
            })).toMatchObject({ text: 'pending' });
        } finally {
            unregister();
        }
    });

    it('does not let a daemon replacement fall back to persistent Session text when only a pending editor is registered', () => {
        const sessionId = 'session-persistent-daemon-visual-scope';
        const sessionRef = { kind: 'session', sessionId } as const;
        const pendingRef = { kind: 'pendingMessage', sessionId, localId: 'pending-1' } as const;
        activatePersistentSessionDraft(sessionId, 'persistent before');
        const persistent = readPersistentSessionSnapshot(sessionId);
        const pendingTarget = createDocumentTarget(createSnapshot({
            ref: pendingRef,
            text: 'pending before',
            revision: persistent.revision,
        }));
        const unregister = registerComposerPresentationTarget(pendingRef, pendingTarget);
        const genericApply = vi.fn((transaction: ComposerTransactionV1) => applyComposerPresentationTransaction({
            ref: sessionRef,
            transaction,
        }));
        const visualSessionTarget = readSessionComposerPresentationTarget(sessionId);
        try {
            expect(visualSessionTarget).toBeNull();
            const application = applyCurrentSessionPresentationCommand({
                sessionId,
                hostNonce: 'host-1',
                clientId: 'client-1',
                focusedSessionId: sessionId,
                state: {
                    v: 1,
                    hostNonce: 'host-1',
                    revision: 1,
                    statuses: [],
                    widgets: [],
                    command: {
                        id: 'command-1',
                        clientId: 'client-1',
                        kind: 'composer.replace',
                        transaction: {
                            expectedRevision: persistent.revision,
                            operations: [{ kind: 'text.set', text: 'daemon replacement' }],
                        },
                    },
                },
                notify: vi.fn(),
                // The daemon bridge receives only a mounted Session target. The
                // generic callback models exact offscreen `get(sessionRef)`,
                // which must remain unavailable to this command path.
                composer: visualSessionTarget && {
                    revision: visualSessionTarget.revision,
                    apply: genericApply,
                },
            });

            expect(application).toEqual({
                ack: {
                    hostNonce: 'host-1',
                    clientId: 'client-1',
                    commandId: 'command-1',
                    result: { status: 'composerUnavailable' },
                },
            });
            expect(genericApply).not.toHaveBeenCalled();
            expect(loadSessionDrafts(persistentSessionScope)[sessionId]).toBe('persistent before');
            expect(pendingTarget.readCurrent()).toMatchObject({
                revision: persistent.revision,
                text: 'pending before',
            });
        } finally {
            unregister();
        }
    });
});
