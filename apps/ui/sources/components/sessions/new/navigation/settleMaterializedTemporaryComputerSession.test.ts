import { describe, expect, it, vi } from 'vitest';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';

import {
    buildTemporaryComputerFirstPrompt,
    buildTemporaryComputerFirstPromptDelivery,
    createMaterializedTemporaryComputerSettlement,
    presentMaterializedTemporaryComputerSessionAndContinueSettlement,
    recoverMaterializedTemporaryComputerSessionForSession,
    runMaterializedTemporaryComputerSessionSettlementSingleflight,
    settlePersistedMaterializedTemporaryComputerSession,
} from './settleMaterializedTemporaryComputerSession';
import { uploadReviewedRunnerAttachments } from '@/sync/domains/ephemeralRunner/uploadReviewedRunnerAttachments';
import { RunnerActivationClientError } from '@/sync/api/ephemeralRunner/runnerActivationClient';

describe('buildTemporaryComputerFirstPrompt', () => {
    it('delivers issued handles through raw ingress without authored attachment presentation', async () => {
        const { RawIngressStructuredInputV1Schema } = await import('@happier-dev/protocol/runtime/input/structuredInputV1');
        const attachmentHandle = { v: 1 as const, sessionId: 'session-a', id: 'issued-notes' };
        const delivery = buildTemporaryComputerFirstPromptDelivery({
            sessionId: 'session-a', composer: { text: 'Inspect this', references: [], attachments: [] },
            uploaded: [{ id: 'file-a', name: 'notes.txt', path: 'uploads/notes.txt', sizeBytes: 8, attachmentHandle }],
        });
        expect(delivery.initialMessageText).toBe('Inspect this');
        expect(RawIngressStructuredInputV1Schema.parse(delivery.metaOverrides?.happierStructuredInputV1))
            .toEqual({ v: 1, sessionAttachments: [attachmentHandle] });
        expect(delivery.metaOverrides).not.toHaveProperty('happier');
        expect(delivery.metaOverrides).not.toHaveProperty('happierAttachments');
    });
    it('preserves the exact reviewed prompt when there are no uploaded attachments', () => {
        expect(buildTemporaryComputerFirstPrompt({
            reviewedText: '  Keep my intentional spacing  ',
            uploaded: [],
        })).toBe('  Keep my intentional spacing  ');
    });

    it('keeps uploads in metadata without adding an attachment listing to the prompt', () => {
        expect(buildTemporaryComputerFirstPrompt({
            reviewedText: 'Inspect this',
            uploaded: [{
                id: 'file-a',
                name: 'notes.txt',
                path: '.happier/uploads/notes.txt',
                mimeType: 'text/plain',
                sizeBytes: 8,
                sha256: 'a'.repeat(64),
                attachmentHandle: { v: 1, sessionId: 'session-a', id: 'issued-file-a' },
            }],
        })).toBe('Inspect this');
    });

    it('retains reviewed Composer reference identity in the recovery delivery', () => {
        const delivery = buildTemporaryComputerFirstPromptDelivery({
            composer: {
                text: 'Inspect @issue-42',
                references: [{
                    kind: 'acme.issue',
                    ref: 'issue:42',
                    token: '@issue-42',
                    label: 'Issue #42',
                    start: 8,
                    end: 17,
                }],
                attachments: [],
            },
            uploaded: [],
        });

        expect(delivery.initialMessageText).toBe('Inspect @issue-42');
        expect(readHappierStructuredInputV1FromMeta(delivery.metaOverrides)?.mentions)
            .toEqual([expect.objectContaining({ kind: 'acme.issue', ref: 'issue:42' })]);
    });

    it('rebuilds the ordinary review-comments message after materialization without losing Composer metadata', () => {
        const delivery = buildTemporaryComputerFirstPromptDelivery({
            sessionId: 'session-a',
            composer: {
                text: 'Also inspect @issue-42',
                references: [{
                    kind: 'acme.issue',
                    ref: 'issue:42',
                    token: '@issue-42',
                    label: 'Issue #42',
                    start: 13,
                    end: 22,
                }],
                attachments: [],
            },
            uploaded: [],
            reviewComments: [{
                id: 'comment-a',
                filePath: 'src/example.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 4, lineHash: 'lh1:1234567890abcdef' },
                snapshot: {
                    selectedLines: ['const answer = 41;'],
                    beforeContext: [],
                    afterContext: [],
                },
                body: 'This value should be 42.',
                createdAt: 1,
            }],
        });

        expect(delivery.initialMessageText).toContain('This value should be 42.');
        expect(delivery.metaOverrides).toMatchObject({
            happier: {
                kind: 'review_comments.v1',
                payload: {
                    sessionId: 'session-a',
                    comments: [expect.objectContaining({ id: 'comment-a' })],
                },
            },
        });
        expect(readHappierStructuredInputV1FromMeta(delivery.metaOverrides)?.mentions)
            .toEqual([expect.objectContaining({ kind: 'acme.issue', ref: 'issue:42' })]);
    });
});

describe('createMaterializedTemporaryComputerSettlement', () => {
    it('returns after presentation while recoverable settlement work continues', async () => {
        const events: string[] = [];
        let rejectSettlement!: (error: Error) => void;
        const settlement = new Promise<void>((_resolve, reject) => { rejectSettlement = reject; });

        await expect(presentMaterializedTemporaryComputerSessionAndContinueSettlement({
            present: async () => { events.push('present'); },
            settle: async () => {
                events.push('settle');
                await settlement;
            },
        })).resolves.toBeUndefined();
        expect(events).toEqual(['present', 'settle']);

        rejectSettlement(new Error('creator custody unavailable'));
        await Promise.resolve();
        await Promise.resolve();
    });

    it('presents the authoritative Session before creator custody recovery can fail', async () => {
        const present = vi.fn(async () => undefined);
        await expect(settlePersistedMaterializedTemporaryComputerSession({
            scope: { serverId: 'server-present-first', accountId: 'account-present-first' },
            draftId: 'draft-present-first',
            activationId: '00000000-0000-4000-8000-0000000000ab',
            launchUserAttemptId: null,
            sessionId: 'session-present-first',
            projection: {
                activationId: '00000000-0000-4000-8000-0000000000ab',
                state: 'materialized',
                materialization: { sessionId: 'session-present-first', machineId: 'machine-present-first' },
            } as RunnerActivationProjectionV1,
            present,
        })).rejects.toBeDefined();
        expect(present).toHaveBeenCalledOnce();
    });

    it('presents before a slow upload and cleans custody only after prompt admission', async () => {
        const events: string[] = [];
        let finishUpload!: () => void;
        let promptAdmitted = false;
        const admit = async () => {
            if (promptAdmitted) return;
            promptAdmitted = true;
            events.push('complete:verified');
        };
        const settlement = createMaterializedTemporaryComputerSettlement({
            present: async () => { events.push('present'); },
            upload: () => uploadReviewedRunnerAttachments({
                sessionId: 'session-a',
                messageLocalId: 'message-a',
                reviewedFiles: [{ id: 'file-a', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 8, sha256: 'a'.repeat(64) }],
                stagedFiles: [{ id: 'file-a', source: { kind: 'memory', name: 'notes.txt', bytes: new Uint8Array(8) } }],
                destination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
                maxFileBytes: 1024,
                admitInitialPrompt: admit,
                uploadFile: async () => {
                    events.push('upload:start');
                    await new Promise<void>((resolve) => { finishUpload = resolve; });
                    return { success: true, path: '.happier/uploads/notes.txt', sizeBytes: 8, sha256: 'a'.repeat(64),
                        attachmentHandle: { v: 1, sessionId: 'session-a', id: 'issued-file-a' } };
                },
            }),
            complete: admit,
            cleanup: async () => { events.push('cleanup'); },
        });

        const pending = settlement.run();
        const concurrentRetry = settlement.run();
        await vi.waitFor(() => expect(events).toEqual(['present', 'upload:start']));
        expect(events).not.toContain('cleanup');
        finishUpload();
        await Promise.all([pending, concurrentRetry]);

        expect(events).toEqual(['present', 'upload:start', 'complete:verified', 'cleanup']);
    });

    it('retains successful checkpoints when cleanup fails and does not duplicate presentation, upload, or prompt admission', async () => {
        const present = vi.fn(async () => undefined);
        const upload = vi.fn(async () => ['verified'] as const);
        const complete = vi.fn(async () => undefined);
        const cleanup = vi.fn()
            .mockRejectedValueOnce(new Error('custody busy'))
            .mockResolvedValueOnce(undefined);
        const settlement = createMaterializedTemporaryComputerSettlement({ present, upload, complete, cleanup });

        await expect(settlement.run()).rejects.toThrow('custody busy');
        await expect(settlement.run()).resolves.toBeUndefined();

        expect(present).toHaveBeenCalledTimes(1);
        expect(upload).toHaveBeenCalledTimes(1);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('keeps custody when upload verification fails and retries from the ordinary upload boundary', async () => {
        const present = vi.fn(async () => undefined);
        const upload = vi.fn()
            .mockRejectedValueOnce(new Error('digest mismatch'))
            .mockResolvedValueOnce(['verified'] as const);
        const complete = vi.fn(async () => undefined);
        const cleanup = vi.fn(async () => undefined);
        const settlement = createMaterializedTemporaryComputerSettlement({ present, upload, complete, cleanup });

        await expect(settlement.run()).rejects.toThrow('digest mismatch');
        expect(complete).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();

        await settlement.run();
        expect(present).toHaveBeenCalledTimes(1);
        expect(upload).toHaveBeenCalledTimes(2);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});

describe('recoverMaterializedTemporaryComputerSessionForSession', () => {
    const projection = (activationId: string, sessionId: string): RunnerActivationProjectionV1 => ({
        activationId,
        state: 'materialized',
        materialization: { sessionId, machineId: 'machine-a' },
    } as RunnerActivationProjectionV1);

    it('re-enters settlement from the synchronized activation reference after the creator mount is gone', async () => {
        const readActivation = vi.fn(async (activationId: string) => projection(activationId, 'session-a'));
        const settle = vi.fn(async () => undefined);

        await expect(recoverMaterializedTemporaryComputerSessionForSession({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-a',
            candidates: [{
                draftId: 'draft-a',
                activationId: '00000000-0000-4000-8000-000000000001',
                launchUserAttemptId: 'attempt-a',
            }],
            readAcceptedBinding: async () => ({ sessionId: 'session-a' }),
            readActivation,
            settle,
        })).resolves.toBe('settled');

        expect(settle).toHaveBeenCalledWith(expect.objectContaining({
            draftId: 'draft-a',
            activationId: '00000000-0000-4000-8000-000000000001',
            launchUserAttemptId: 'attempt-a',
            sessionId: 'session-a',
        }));
    });

    it('does not settle a materialized activation belonging to another Session', async () => {
        const settle = vi.fn(async () => undefined);

        await expect(recoverMaterializedTemporaryComputerSessionForSession({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-a',
            candidates: [{
                draftId: 'draft-a',
                activationId: '00000000-0000-4000-8000-000000000001',
                launchUserAttemptId: null,
            }],
            readAcceptedBinding: async () => ({ sessionId: 'session-b' }),
            readActivation: async (activationId) => projection(activationId, 'session-b'),
            settle,
        })).resolves.toBe('not_found');

        expect(settle).not.toHaveBeenCalled();
    });

    it('surfaces a retryable exact-activation read failure only after local custody binds it to this Session', async () => {
        const activationId = '00000000-0000-4000-8000-000000000001';
        const readActivation = vi.fn(async () => {
            throw new RunnerActivationClientError('unavailable', 503, true);
        });

        await expect(recoverMaterializedTemporaryComputerSessionForSession({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-a',
            candidates: [{ draftId: 'draft-a', activationId, launchUserAttemptId: 'attempt-a' }],
            readAcceptedBinding: async () => ({ sessionId: 'session-a' }),
            readActivation,
        })).resolves.toBe('retryable_unavailable');

        expect(readActivation).toHaveBeenCalledWith(activationId);
    });

    it('treats genuine absence as not found and never reads an unrelated Session activation', async () => {
        const activationId = '00000000-0000-4000-8000-000000000001';
        const absentRead = vi.fn(async () => {
            throw new RunnerActivationClientError('not_found', 404, false);
        });
        await expect(recoverMaterializedTemporaryComputerSessionForSession({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-a',
            candidates: [{ draftId: 'draft-a', activationId, launchUserAttemptId: null }],
            readAcceptedBinding: async () => ({ sessionId: 'session-a' }),
            readActivation: absentRead,
        })).resolves.toBe('not_found');

        const unrelatedRead = vi.fn(async () => projection(activationId, 'session-b'));
        await expect(recoverMaterializedTemporaryComputerSessionForSession({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-a',
            candidates: [{ draftId: 'draft-b', activationId, launchUserAttemptId: null }],
            readAcceptedBinding: async () => ({ sessionId: 'session-b' }),
            readActivation: unrelatedRead,
        })).resolves.toBe('not_found');

        expect(absentRead).toHaveBeenCalledOnce();
        expect(unrelatedRead).not.toHaveBeenCalled();
    });

    it('leaves recovery custody untouched when the exact activation read is cancelled', async () => {
        const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        const settle = vi.fn(async () => undefined);

        await expect(recoverMaterializedTemporaryComputerSessionForSession({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-a',
            candidates: [{
                draftId: 'draft-a',
                activationId: '00000000-0000-4000-8000-000000000001',
                launchUserAttemptId: 'attempt-a',
            }],
            readAcceptedBinding: async () => ({ sessionId: 'session-a' }),
            readActivation: async () => { throw cancelled; },
            settle,
        })).resolves.toBe('not_found');

        expect(settle).not.toHaveBeenCalled();
    });

    it('coalesces creator and Session-entry recovery while preserving retry after a lost response', async () => {
        let release!: () => void;
        const first = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
        const key = {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            activationId: '00000000-0000-4000-8000-000000000001',
            sessionId: 'session-a',
        } as const;

        const creator = runMaterializedTemporaryComputerSessionSettlementSingleflight(key, first);
        const recovered = runMaterializedTemporaryComputerSessionSettlementSingleflight(key, first);
        expect(first).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([creator, recovered]);

        const retry = vi.fn()
            .mockRejectedValueOnce(new Error('outcome_unknown'))
            .mockResolvedValueOnce(undefined);
        await expect(runMaterializedTemporaryComputerSessionSettlementSingleflight(key, retry)).rejects.toThrow('outcome_unknown');
        await expect(runMaterializedTemporaryComputerSessionSettlementSingleflight(key, retry)).resolves.toBeUndefined();
        expect(retry).toHaveBeenCalledTimes(2);
    });
});
