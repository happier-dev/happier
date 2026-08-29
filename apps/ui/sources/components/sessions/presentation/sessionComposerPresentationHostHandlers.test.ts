import type {
    ComposerContentHandleV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
} from '@happier-dev/protocol';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { pickAndStageComposerMedia } from '@/sync/domains/transfers/ops/pickAndStageComposerMedia';
import type {
    claimComposerContent,
    getComposerMediaContentAvailability,
    inspectComposerContent,
    releaseComposerContent,
} from '@/sync/domains/transfers/runtime/transferRuntime';

const pickAndStageComposerMediaSpy = vi.hoisted(() => (
    vi.fn<typeof pickAndStageComposerMedia>(async () => null)
));
const getComposerMediaContentAvailabilitySpy = vi.hoisted(() => (
    vi.fn<typeof getComposerMediaContentAvailability>(async () => ({
        available: true as const,
        capability: 'composer.mediaContent.v1' as const,
    }))
));
const inspectComposerContentSpy = vi.hoisted(() => (
    vi.fn<typeof inspectComposerContent>(async () => ({
        success: false as const,
        error: 'composer media inspection unavailable',
    }))
));
const releaseComposerContentSpy = vi.hoisted(() => (
    vi.fn<typeof releaseComposerContent>(async () => ({ success: true } as const))
));
const claimComposerContentSpy = vi.hoisted(() => (
    vi.fn<typeof claimComposerContent>(async () => ({ status: 'claimed', newlyAcquired: true } as const))
));

vi.mock('@/sync/domains/transfers/ops/pickAndStageComposerMedia', () => ({
    pickAndStageComposerMedia: pickAndStageComposerMediaSpy,
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    getComposerMediaContentAvailability: getComposerMediaContentAvailabilitySpy,
    inspectComposerContent: inspectComposerContentSpy,
    releaseComposerContent: releaseComposerContentSpy,
    claimComposerContent: claimComposerContentSpy,
}));

import {
    applyComposerPresentationTransaction,
    createComposerPresentationTransactionApplier,
    createComposerPresentationHostHandlers,
    registerComposerPresentationTarget,
    type ComposerPresentationDocumentMutation,
    type ComposerPresentationTarget,
} from './sessionComposerPresentationTargets';

const sessionRef = { kind: 'session', sessionId: 'session-1' } as const;
const otherSessionRef = { kind: 'session', sessionId: 'session-2' } as const;
const composerMediaExecutionTarget = { serverId: 'server-1', machineId: 'machine-1' } as const;
const composerMediaHandle: ComposerContentHandleV1 = {
    v: 1,
    id: 'stage-42',
    executionTarget: composerMediaExecutionTarget,
    owner: { pluginId: 'acme.fixture', localId: 'issue' },
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'issue-42.png',
    sizeBytes: 12,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

function createSnapshot(overrides: Partial<ComposerSnapshotV1> = {}): ComposerSnapshotV1 {
    return {
        revision: 3,
        ref: sessionRef,
        text: 'draft',
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

function request(
    method: PluginUiHostApiRequestEnvelopeV1['method'],
    payload?: unknown,
): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: `request:${method}`,
        surface: {
            pluginId: 'acme.fixture',
            contributionId: 'composer-tools',
            surfaceId: 'composer-tools:mounted',
            placement: 'composerSurface',
            platform: 'web',
            channel: 'internal',
            resourceScope: [],
            diagnostics: [],
        },
        method,
        ...(payload === undefined
            ? {}
            : { payload: payload as PluginUiHostApiRequestEnvelopeV1['payload'] }),
    };
}

function createTarget(initial: ComposerSnapshotV1): ComposerPresentationTarget & Readonly<{
    focus: ReturnType<typeof vi.fn>;
    setDecorations: ReturnType<typeof vi.fn>;
    acquireInputLock: ReturnType<typeof vi.fn>;
}> {
    let snapshot = initial;
    const focus = vi.fn(() => true);
    const setDecorations = vi.fn();
    const acquireInputLock = vi.fn(() => vi.fn());

    return {
        focus,
        setDecorations,
        acquireInputLock,
        readRevision: () => snapshot.revision,
        replace: (text, expectedRevision) => {
            if (snapshot.revision !== expectedRevision) return snapshot.revision;
            snapshot = { ...snapshot, text, revision: snapshot.revision + 1 };
            return snapshot.revision;
        },
        readSnapshot: () => snapshot,
        createAttachmentInstanceId: () => 'host-created-issue-42',
        commitDocument: (input: Readonly<{
            expectedRevision: number;
            mutation: ComposerPresentationDocumentMutation;
        }>): ComposerTransactionResultV1 => {
            if (snapshot.revision !== input.expectedRevision) {
                return { status: 'conflict', currentRevision: snapshot.revision };
            }
            snapshot = {
                ...snapshot,
                ...input.mutation,
                references: [...input.mutation.references],
                attachments: [...input.mutation.attachments],
                revision: snapshot.revision + 1,
            };
            return { status: 'applied', revision: snapshot.revision };
        },
        focusComposer: focus,
        setComposerDecorations: setDecorations,
        acquireComposerInputLock: acquireInputLock,
    };
}

function createIssueAttachmentTransactionApplier() {
    const issue: PluginUiComposerAttachmentProjection = {
        id: 'acme.fixture/issue',
        pluginId: 'acme.fixture',
        identity: { pluginId: 'acme.fixture', localId: 'issue' },
        immutableGenerationId: 'generation-1',
        definition: {
            id: 'issue',
            title: 'Issue',
            icon: 'file',
            cardinality: 'many',
            valueSchema: { type: 'object' },
        },
        valueValidator: () => true,
    };
    return createComposerPresentationTransactionApplier({
        composerAttachmentsById: { [issue.id]: issue },
    });
}

function createHandlers(options: Readonly<{
    isCurrent?: () => boolean;
}> = {}) {
    return createComposerPresentationHostHandlers({
        owner: {
            identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
            immutableGenerationId: 'generation-1',
            surfaceInstanceKey: 'mounted-1',
        },
        ...options,
    });
}

describe('composer presentation host handlers', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()?.();
        pickAndStageComposerMediaSpy.mockClear();
        getComposerMediaContentAvailabilitySpy.mockClear();
        inspectComposerContentSpy.mockClear();
        releaseComposerContentSpy.mockClear();
        claimComposerContentSpy.mockClear();
    });

    it('does not advertise Composer observation without this mount’s snapshot publisher', () => {
        const handlers = createHandlers();

        expect(handlers.watchComposer).toBeUndefined();
        handlers.dispose();
    });

    it('stages, inspects, and releases media only through the exact target and admitted attachment owner', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const signal = new AbortController().signal;
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });
        getComposerMediaContentAvailabilitySpy.mockResolvedValueOnce({
            available: true,
            capability: 'composer.mediaContent.v1',
        });
        pickAndStageComposerMediaSpy.mockResolvedValueOnce(composerMediaHandle);
        inspectComposerContentSpy.mockResolvedValueOnce({
            success: true,
            result: { offset: 0, bytesBase64: 'AQID', eof: true },
        });
        releaseComposerContentSpy.mockResolvedValueOnce({ success: true });

        await expect(handlers.pickComposerMedia!(request('pickComposerMedia', {
            ref: sessionRef,
            request: { attachmentLocalId: 'issue', kinds: ['image'] },
        }), { signal })).resolves.toEqual(composerMediaHandle);
        await expect(handlers.inspectComposerContent!(request('inspectComposerContent', {
            handle: composerMediaHandle,
            request: { offset: 0, maxBytes: 3 },
        }), { signal })).resolves.toEqual({ offset: 0, bytesBase64: 'AQID', eof: true });
        await expect(handlers.releaseComposerContent!(request('releaseComposerContent', {
            handle: composerMediaHandle,
        }), { signal })).resolves.toBeNull();

        expect(pickAndStageComposerMediaSpy).toHaveBeenCalledWith({
            executionTarget: composerMediaExecutionTarget,
            owner: { pluginId: 'acme.fixture', localId: 'issue' },
            kinds: ['image'],
            signal,
        });
        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledWith({
            executionTarget: composerMediaExecutionTarget,
            signal,
        });
        expect(inspectComposerContentSpy).toHaveBeenCalledWith(
            composerMediaHandle,
            { offset: 0, maxBytes: 3 },
            { signal },
        );
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, { signal });
        handlers.dispose();
    });

    it('rejects foreign-owner and stale-target staged handles before the shared attachment transaction commits or releases', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        for (const handle of [
            {
                ...composerMediaHandle,
                owner: { pluginId: 'acme.foreign', localId: 'issue' },
            },
            {
                ...composerMediaHandle,
                executionTarget: { serverId: 'server-stale', machineId: 'machine-1' },
            },
        ]) {
            await expect(handlers.applyComposer!(request('applyComposer', {
                ref: sessionRef,
                transaction: {
                    expectedRevision: 3,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: 'issue',
                        value: {
                            key: '42',
                            value: { issueId: 42 },
                            presentation: { label: 'Issue #42' },
                        },
                        content: { kind: 'stagedMedia', handle },
                    }],
                },
            }))).resolves.toEqual({
                status: 'invalidOperation',
                operationIndex: 0,
                reason: 'staged_media_handle_mismatch',
            });
            expect(handlers.readComposer!(request('readComposer', { ref: sessionRef }))).toMatchObject({
                status: 'ready',
                snapshot: { revision: 3, attachments: [] },
            });
        }

        await Promise.resolve();
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
        expect(claimComposerContentSpy).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('admits a declaration-owned staged handle for the current mounted target through the shared attachment transaction', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        }))).resolves.toEqual({
            status: 'applied',
            revision: 4,
            attachmentInstanceIds: ['host-created-issue-42'],
        });
        // Publication claimed the handle at the transfer store under the exact
        // (composer, attachmentInstanceId) the draft recorded — id created
        // first, claim before commit.
        expect(claimComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, {
            composer: sessionRef,
            attachmentInstanceId: 'host-created-issue-42',
        });
        expect(handlers.readComposer!(request('readComposer', { ref: sessionRef }))).toMatchObject({
            status: 'ready',
            snapshot: {
                attachments: [{
                    attachment: { pluginId: 'acme.fixture', localId: 'issue' },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        });
        handlers.dispose();
    });

    it('carries cancellation into delayed staged-media claim and releases only this attempt’s new claim before commit', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const cancellation = new AbortController();
        let finishClaim!: () => void;
        const claimStarted = new Promise<void>((resolve) => {
            claimComposerContentSpy.mockImplementationOnce(async () => {
                resolve();
                await new Promise<void>((finish) => {
                    finishClaim = finish;
                });
                return { status: 'claimed', newlyAcquired: true } as const;
            });
        });
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        const applying = handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        }), { signal: cancellation.signal });
        await claimStarted;
        expect(claimComposerContentSpy.mock.calls[0]?.[2]).toEqual({ signal: cancellation.signal });
        cancellation.abort();
        finishClaim();

        await expect(applying).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['composer_apply_cancelled'],
        });
        expect(target.readSnapshot).toBeDefined();
        expect(target.readSnapshot!().attachments).toEqual([]);
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, {
            claimant: {
                composer: sessionRef,
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
        handlers.dispose();
    });

    it('refuses late staged-media claim settlement after surface retirement without releasing a rejoined claim', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        let current = true;
        let finishClaim!: () => void;
        const claimStarted = new Promise<void>((resolve) => {
            claimComposerContentSpy.mockImplementationOnce(async () => {
                resolve();
                await new Promise<void>((finish) => {
                    finishClaim = finish;
                });
                return { status: 'claimed', newlyAcquired: false } as const;
            });
        });
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
            isCurrent: () => current,
        });

        const applying = handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        }));
        await claimStarted;
        current = false;
        finishClaim();

        await expect(applying).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(target.readSnapshot).toBeDefined();
        expect(target.readSnapshot!().attachments).toEqual([]);
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('rechecks the exact document target immediately before committing a settled staged-media claim', async () => {
        const target = createTarget(createSnapshot());
        const unregister = registerComposerPresentationTarget(sessionRef, target);
        cleanups.push(unregister);
        const replacement = createTarget(createSnapshot());
        claimComposerContentSpy.mockImplementationOnce(async () => {
            unregister();
            cleanups.push(registerComposerPresentationTarget(sessionRef, replacement));
            return { status: 'claimed', newlyAcquired: true } as const;
        });
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        }))).resolves.toEqual({ status: 'composerUnavailable' });
        expect(target.readSnapshot).toBeDefined();
        expect(target.readSnapshot!().attachments).toEqual([]);
        expect(replacement.readSnapshot).toBeDefined();
        expect(replacement.readSnapshot!().attachments).toEqual([]);
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, {
            claimant: {
                composer: sessionRef,
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
        handlers.dispose();
    });

    it('rejects a second document claiming the same staged handle with a typed custody conflict', async () => {
        // Document A attached the handle first; its publication claimed it at
        // the transfer store. Document B's publication of the same handle must
        // refuse typed, leave B's draft unchanged, and never release A's claim.
        claimComposerContentSpy
            .mockResolvedValueOnce({ status: 'claimed', newlyAcquired: true })
            .mockResolvedValueOnce({ status: 'claimedElsewhere' });
        const targetA = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, targetA));
        const targetB = createTarget(createSnapshot({ ref: otherSessionRef }));
        cleanups.push(registerComposerPresentationTarget(otherSessionRef, targetB));
        const makeHandlers = () => createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });
        const handlersA = makeHandlers();
        const handlersB = makeHandlers();

        const stagedTransaction = {
            expectedRevision: 3,
            operations: [{
                kind: 'attachment.add' as const,
                attachmentLocalId: 'issue',
                value: {
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42' },
                },
                content: { kind: 'stagedMedia' as const, handle: composerMediaHandle },
            }],
        };
        await expect(handlersA.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: stagedTransaction,
        }))).resolves.toEqual({
            status: 'applied',
            revision: 4,
            attachmentInstanceIds: ['host-created-issue-42'],
        });

        await expect(handlersB.applyComposer!(request('applyComposer', {
            ref: otherSessionRef,
            transaction: stagedTransaction,
        }))).resolves.toEqual({
            status: 'invalidOperation',
            operationIndex: 0,
            reason: 'staged_media_custody_conflict',
        });
        expect(targetB.readSnapshot).toBeDefined();
        expect(targetB.readSnapshot!()).toMatchObject({ revision: 3, attachments: [] });
        // B's refused publication released nothing: A's custody stands.
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
        // A's removal is the same claimant and releases exactly once.
        await expect(handlersA.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 4,
                operations: [{ kind: 'attachment.remove', instanceId: 'host-created-issue-42' }],
            },
        }))).resolves.toEqual({ status: 'applied', revision: 5 });
        await Promise.resolve();
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, {
            claimant: {
                composer: sessionRef,
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
        handlersA.dispose();
        handlersB.dispose();
    });

    it('releases a publication claim it created when the document owner rejects the commit', async () => {
        // A claim admitted but never published must not strand: the losing
        // side of a revision race gives the custody back instead of blocking
        // every later document from attaching the same handle.
        const target = {
            ...createTarget(createSnapshot()),
            commitDocument: (): ComposerTransactionResultV1 => ({ status: 'conflict', currentRevision: 9 }),
        };
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        }))).resolves.toEqual({ status: 'conflict', currentRevision: 9 });
        expect(claimComposerContentSpy).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, {
            claimant: {
                composer: sessionRef,
                attachmentInstanceId: 'host-created-issue-42',
            },
        });
        handlers.dispose();
    });

    it('does not release restart-rejoined custody when the document owner rejects the commit', async () => {
        claimComposerContentSpy.mockResolvedValueOnce({ status: 'claimed', newlyAcquired: false });
        const target = {
            ...createTarget(createSnapshot()),
            commitDocument: (): ComposerTransactionResultV1 => ({ status: 'conflict', currentRevision: 9 }),
        };
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'issue',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                    content: { kind: 'stagedMedia', handle: composerMediaHandle },
                }],
            },
        }))).resolves.toEqual({ status: 'conflict', currentRevision: 9 });
        expect(releaseComposerContentSpy).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('fails closed before opening a picker when the exact target lacks Composer media capability', async () => {
        const signal = new AbortController().signal;
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });
        getComposerMediaContentAvailabilitySpy.mockResolvedValueOnce({ available: false });

        await expect(handlers.pickComposerMedia!(request('pickComposerMedia', {
            ref: sessionRef,
            request: { attachmentLocalId: 'issue', kinds: ['image'] },
        }), { signal })).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['composer_media_capability_unavailable'],
        });

        expect(getComposerMediaContentAvailabilitySpy).toHaveBeenCalledWith({
            executionTarget: composerMediaExecutionTarget,
            signal,
        });
        expect(pickAndStageComposerMediaSpy).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('does not open a picker when the host retires while capability negotiation is pending', async () => {
        const availabilityDeferred: {
            resolve?: (value: Readonly<{
                available: true;
                capability: 'composer.mediaContent.v1';
            }>) => void;
        } = {};
        getComposerMediaContentAvailabilitySpy.mockImplementationOnce(async () => await new Promise<Readonly<{
            available: true;
            capability: 'composer.mediaContent.v1';
        }>>((resolve) => {
            availabilityDeferred.resolve = resolve;
        }));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        const pendingPick = handlers.pickComposerMedia!(request('pickComposerMedia', {
            ref: sessionRef,
            request: { attachmentLocalId: 'issue', kinds: ['image'] },
        }));
        await Promise.resolve();
        handlers.dispose();
        availabilityDeferred.resolve?.({ available: true, capability: 'composer.mediaContent.v1' });

        await expect(pendingPick).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(pickAndStageComposerMediaSpy).not.toHaveBeenCalled();
    });

    it('does not advertise media operations without the mounted target-bound transfer port', () => {
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
        });

        expect(handlers.pickComposerMedia).toBeUndefined();
        expect(handlers.inspectComposerContent).toBeUndefined();
        expect(handlers.releaseComposerContent).toBeUndefined();
        handlers.dispose();
    });

    it('retires a completed pick that settles after its mounted host does', async () => {
        const stageDeferred: {
            resolve?: (value: ComposerContentHandleV1 | null) => void;
        } = {};
        pickAndStageComposerMediaSpy.mockImplementationOnce(async () => await new Promise<ComposerContentHandleV1 | null>((resolve) => {
            stageDeferred.resolve = resolve;
        }));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        const pendingPick = handlers.pickComposerMedia!(request('pickComposerMedia', {
            ref: sessionRef,
            request: { attachmentLocalId: 'issue', kinds: ['image'] },
        }));
        await vi.waitFor(() => {
            expect(pickAndStageComposerMediaSpy).toHaveBeenCalledTimes(1);
        });
        handlers.dispose();
        stageDeferred.resolve?.(composerMediaHandle);

        await expect(pendingPick).resolves.toMatchObject({ code: 'stale_surface' });
        // A late completed pick never created an attachment instance, so the
        // retirement must not fabricate a claimant (claimant-only release).
        expect(releaseComposerContentSpy).toHaveBeenCalledWith(composerMediaHandle, undefined);
    });

    it('lets an already accepted release settle after the mounted host retires', async () => {
        const releaseDeferred: {
            resolve?: (value: Readonly<{ success: true }>) => void;
        } = {};
        releaseComposerContentSpy.mockImplementationOnce(async () => await new Promise<Readonly<{ success: true }>>((resolve) => {
            releaseDeferred.resolve = resolve;
        }));
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
            executionTarget: composerMediaExecutionTarget,
        });

        const pendingRelease = handlers.releaseComposerContent!(request('releaseComposerContent', {
            handle: composerMediaHandle,
        }));
        handlers.dispose();
        releaseDeferred.resolve?.({ success: true });

        await expect(pendingRelease).resolves.toBeNull();
    });

    it('focuses only the explicitly addressed current target and treats a closed scope as unavailable', () => {
        const target = createTarget(createSnapshot());
        const other = createTarget(createSnapshot({ ref: otherSessionRef }));
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        cleanups.push(registerComposerPresentationTarget(otherSessionRef, other));
        const handlers = createHandlers();

        expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
            .toEqual({ status: 'focused' });
        expect(target.focus).toHaveBeenCalledTimes(1);
        expect(other.focus).not.toHaveBeenCalled();

        cleanups.pop()?.();
        cleanups.pop()?.();
        expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
            .toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        handlers.dispose();
    });

    it('returns no active composer when more than one current target reports focus', () => {
        const focusedState = {
            focused: true,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        } as const;
        cleanups.push(registerComposerPresentationTarget(sessionRef, createTarget(createSnapshot({
            state: focusedState,
        }))));
        cleanups.push(registerComposerPresentationTarget(otherSessionRef, createTarget(createSnapshot({
            ref: otherSessionRef,
            state: focusedState,
        }))));
        const handlers = createHandlers();

        expect(handlers.activeComposer!(request('activeComposer'))).toBeNull();
        handlers.dispose();
    });

    it('fails closed when the exact target retires or is replaced during a focus request', () => {
        const retiredTarget = Object.assign(createTarget(createSnapshot({
            state: {
                focused: true,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            },
        })), {
            isCurrent: () => false,
        });
        cleanups.push(registerComposerPresentationTarget(sessionRef, retiredTarget));
        const handlers = createHandlers();

        expect(handlers.activeComposer!(request('activeComposer'))).toBeNull();
        expect(handlers.readComposer!(request('readComposer', { ref: sessionRef })))
            .toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
            .toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(retiredTarget.focus).not.toHaveBeenCalled();

        cleanups.pop()?.();
        const replacement = createTarget(createSnapshot());
        const target = createTarget(createSnapshot());
        let retireReplacement: (() => void) | null = null;
        target.focus.mockImplementation(() => {
            retireReplacement = registerComposerPresentationTarget(sessionRef, replacement);
            return true;
        });
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));

        expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
            .toEqual({ status: 'unavailable', reason: 'scopeClosed' });
        expect(target.focus).toHaveBeenCalledTimes(1);
        expect(replacement.focus).not.toHaveBeenCalled();

        if (retireReplacement) cleanups.push(retireReplacement);
        handlers.dispose();
    });

    it('rejects stale decorations, then clears an accepted ephemeral decoration after document revision changes', () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createHandlers();

        expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
            ref: sessionRef,
            key: 'analysis',
            decorations: {
                revision: 2,
                ranges: [{ range: { start: 0, end: 1 }, treatment: 'highlight' }],
            },
        }))).toEqual({ status: 'staleRevision', currentRevision: 3 });
        expect(target.setDecorations).not.toHaveBeenCalled();

        expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
            ref: sessionRef,
            key: 'analysis',
            decorations: {
                revision: 3,
                ranges: [{ range: { start: 0, end: 5 }, treatment: 'highlight' }],
            },
        }))).toEqual({ status: 'set' });

        expect(applyComposerPresentationTransaction({
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{ kind: 'text.set', text: 'changed' }],
            },
        })).toEqual({ status: 'applied', revision: 4 });
        expect(target.setDecorations).toHaveBeenLastCalledWith(expect.objectContaining({
            key: 'analysis',
            decorations: null,
        }));

        handlers.dispose();
    });

    it('fails closed by clearing a prior decoration when the target rejects its replacement', () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createHandlers();
        const firstDecoration = {
            revision: 3,
            ranges: [{ range: { start: 0, end: 5 }, treatment: 'highlight' as const }],
        };

        expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
            ref: sessionRef,
            key: 'analysis',
            decorations: firstDecoration,
        }))).toEqual({ status: 'set' });
        target.setDecorations.mockImplementationOnce(() => {
            throw new Error('adapter unavailable');
        });

        expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
            ref: sessionRef,
            key: 'analysis',
            decorations: {
                revision: 3,
                ranges: [{ range: { start: 1, end: 5 }, treatment: 'warning' }],
            },
        }))).toMatchObject({ code: 'unavailable' });
        expect(target.setDecorations).toHaveBeenLastCalledWith(expect.objectContaining({
            key: 'analysis',
            decorations: null,
        }));
        handlers.dispose();
    });

    it('uses the generic host-resource lease identity and releases locks on scope replacement and disposal', () => {
        const target = createTarget(createSnapshot());
        const releaseFirst = vi.fn();
        target.acquireInputLock.mockReturnValueOnce(releaseFirst);
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const handlers = createHandlers();

        expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
            subscriptionId: 'lock-1',
            ref: sessionRef,
            request: { reason: 'Awaiting upload', mode: 'submit' },
        }))).toBeNull();
        expect(target.acquireInputLock).toHaveBeenCalledWith(expect.objectContaining({
            subscriptionId: 'lock-1',
            request: { reason: 'Awaiting upload', mode: 'submit' },
        }));

        const replacement = createTarget(createSnapshot());
        const releaseSecond = vi.fn();
        replacement.acquireInputLock.mockReturnValueOnce(releaseSecond);
        cleanups.push(registerComposerPresentationTarget(sessionRef, replacement));
        expect(releaseFirst).toHaveBeenCalledTimes(1);

        expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
            subscriptionId: 'lock-2',
            ref: sessionRef,
            request: { reason: 'Awaiting upload', mode: 'editAndSubmit' },
        }))).toBeNull();
        expect(handlers.disposeHostResource!(request('disposeHostResource', {
            subscriptionId: 'lock-2',
        }))).toBeNull();
        expect(releaseSecond).toHaveBeenCalledTimes(1);

        expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
            ref: sessionRef,
            request: { reason: 'Missing transport lease', mode: 'submit' },
        }))).toMatchObject({
            code: 'invalid_payload',
        });
        handlers.dispose();
    });

    it('makes cancellation and surface retirement inert before touching the exact target', () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        let current = false;
        const handlers = createHandlers({ isCurrent: () => current });

        expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
            .toMatchObject({ code: 'stale_surface' });
        expect(target.focus).not.toHaveBeenCalled();

        current = true;
        const abort = new AbortController();
        abort.abort();
        expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
            ref: sessionRef,
            key: 'analysis',
            decorations: null,
        }), { signal: abort.signal })).toMatchObject({ code: 'unavailable' });
        expect(target.setDecorations).not.toHaveBeenCalled();
        handlers.dispose();
    });

    it('serves active, read, watch, and revision-checked apply through the registered semantic document', async () => {
        const target = createTarget(createSnapshot({
            state: {
                focused: true,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            },
        }));
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const published: Array<Readonly<{ subscriptionId: string; snapshot: ComposerSnapshotV1 }>> = [];
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            publishComposerSnapshot: (event) => published.push(event),
        });
        const subscription = new AbortController();

        expect(handlers.activeComposer!(request('activeComposer'))).toEqual(sessionRef);
        expect(handlers.readComposer!(request('readComposer', { ref: sessionRef }))).toEqual({
            status: 'ready',
            snapshot: expect.objectContaining({ ref: sessionRef, text: 'draft', revision: 3 }),
        });
        expect(handlers.watchComposer!(request('watchComposer', {
            subscriptionId: 'watch-1',
            ref: sessionRef,
        }), { signal: subscription.signal })).toBeNull();

        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{ kind: 'text.set', text: 'changed' }],
            },
        }))).resolves.toEqual({ status: 'applied', revision: 4 });
        expect(published).toEqual([{
            subscriptionId: 'watch-1',
            snapshot: expect.objectContaining({ ref: sessionRef, text: 'changed', revision: 4 }),
        }]);

        subscription.abort();
        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 4,
                operations: [{ kind: 'text.set', text: 'after-dispose' }],
            },
        }))).resolves.toEqual({ status: 'applied', revision: 5 });
        expect(published).toHaveLength(1);
        handlers.dispose();
    });

    it('does not let a retired watch cancellation dispose a replacement using the same generic resource id', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const published: Array<Readonly<{ subscriptionId: string; snapshot: ComposerSnapshotV1 }>> = [];
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            publishComposerSnapshot: (event) => published.push(event),
        });
        const retiredSubscription = new AbortController();
        const replacementSubscription = new AbortController();

        expect(handlers.watchComposer!(request('watchComposer', {
            subscriptionId: 'watch-1',
            ref: sessionRef,
        }), { signal: retiredSubscription.signal })).toBeNull();
        expect(handlers.disposeHostResource!(request('disposeHostResource', {
            subscriptionId: 'watch-1',
        }))).toBeNull();
        expect(handlers.watchComposer!(request('watchComposer', {
            subscriptionId: 'watch-1',
            ref: sessionRef,
        }), { signal: replacementSubscription.signal })).toBeNull();

        retiredSubscription.abort();
        await expect(handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: {
                expectedRevision: 3,
                operations: [{ kind: 'text.set', text: 'replacement still live' }],
            },
        }))).resolves.toEqual({ status: 'applied', revision: 4 });

        expect(published).toEqual([{
            subscriptionId: 'watch-1',
            snapshot: expect.objectContaining({ text: 'replacement still live', revision: 4 }),
        }]);
        handlers.dispose();
    });

    it('uses only the mount-bound projection to authorize attachment mutations', async () => {
        const target = createTarget(createSnapshot());
        cleanups.push(registerComposerPresentationTarget(sessionRef, target));
        const attachmentTransaction = {
            expectedRevision: 3,
            operations: [{
                kind: 'attachment.add' as const,
                attachmentLocalId: 'issue',
                value: {
                    key: '42',
                    value: { issueId: 42 },
                    presentation: { label: 'Issue #42' },
                },
            }],
        };
        const directHandlers = createHandlers();

        await expect(directHandlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: attachmentTransaction,
        }))).resolves.toMatchObject({
            status: 'invalidOperation',
            reason: 'attachment_authority_mismatch',
        });

        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
            transactionApplier: createIssueAttachmentTransactionApplier(),
        });
        expect(await handlers.applyComposer!(request('applyComposer', {
            ref: sessionRef,
            transaction: attachmentTransaction,
        }))).toEqual({
            status: 'applied',
            revision: 4,
            attachmentInstanceIds: ['host-created-issue-42'],
        });
        expect(handlers.readComposer!(request('readComposer', { ref: sessionRef }))).toMatchObject({
            status: 'ready',
            snapshot: {
                attachments: [{
                    instanceId: 'host-created-issue-42',
                    attachment: { pluginId: 'acme.fixture', localId: 'issue' },
                    key: '42',
                }],
            },
        });
        directHandlers.dispose();
        handlers.dispose();
    });
});
