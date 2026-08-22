import type { ComposerAttachmentViewV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    ComposerHandle,
    ComposerReadResultV1,
    ComposerSnapshotV1,
    ComposerTransactionResultV1,
    ComposerTransactionV1,
} from '@happier-dev/plugin-ui';
import { describe, expect, it } from 'vitest';

import { applyTriageEntryMutation } from './applyEntryMutation.js';
import { deriveTriageComposerEntryAttachmentKey } from './attachmentValue.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const SOURCE_INSTANCE = {
    source: SOURCE,
    sourceInstanceId: '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78',
} as const;
const PRESENTATION = { typeLabel: 'Pull request', label: 'Fix the parser' } as const;

function entryRef(entryId: string) {
    return { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId } as const;
}

function triageAttachment(entryId: string, instanceId: string): ComposerAttachmentViewV1 {
    const ref = entryRef(entryId);
    return {
        v: 1,
        instanceId,
        attachment: { pluginId: 'happier.triage', localId: 'entry' },
        key: deriveTriageComposerEntryAttachmentKey(ref),
        value: { v: 1, entryRef: ref, sourceInstance: SOURCE_INSTANCE },
        presentation: PRESENTATION,
        availability: { status: 'ready' },
    } as ComposerAttachmentViewV1;
}

function snapshot(input: Readonly<{
    revision: number;
    attachments?: readonly ComposerAttachmentViewV1[];
}>): ComposerSnapshotV1 {
    return {
        revision: input.revision,
        ref: { kind: 'session', sessionId: 'session-1' },
        text: 'please review this',
        selection: { start: 0, end: 0 },
        references: [],
        attachments: [...(input.attachments ?? [])],
        layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
    } as ComposerSnapshotV1;
}

/**
 * The composer document is a genuine host boundary: it lives in another program
 * and answers over the mounted transport. Only that boundary is replaced here —
 * the plan, the revision check and the replay decision are the real ones.
 */
function createHandle(script: Readonly<{
    reads: readonly (ComposerReadResultV1 | Error)[];
    applies: readonly (ComposerTransactionResultV1 | Error)[];
}>) {
    const applied: ComposerTransactionV1[] = [];
    let readIndex = 0;
    let applyIndex = 0;
    // A scripted `Error` is the transport rejecting, which is how this boundary
    // reports a closed daemon connection or an un-negotiated host method.
    const settle = <T>(step: T | Error): T => {
        if (step instanceof Error) throw step;
        return step;
    };
    const handle = {
        ref: { kind: 'session', sessionId: 'session-1' },
        read: async () => settle(script.reads[Math.min(readIndex++, script.reads.length - 1)]!),
        apply: async (transaction: ComposerTransactionV1) => {
            applied.push(transaction);
            return settle(script.applies[Math.min(applyIndex++, script.applies.length - 1)]!);
        },
    } as unknown as ComposerHandle;
    return { handle, applied };
}

describe('applyTriageEntryMutation', () => {
    it('attaches against the revision it just read', async () => {
        const { handle, applied } = createHandle({
            reads: [{ status: 'ready', snapshot: snapshot({ revision: 12 }) }],
            applies: [{ status: 'applied', revision: 13 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'attach',
            entryRef: entryRef('42'),
            sourceInstance: SOURCE_INSTANCE,
            presentation: PRESENTATION,
        });

        expect(outcome).toEqual({ kind: 'applied' });
        expect(applied).toHaveLength(1);
        expect(applied[0]?.expectedRevision).toBe(12);
    });

    it('re-plans rather than resubmitting when the draft moved under it', async () => {
        // Between the two reads the draft changed. Resubmitting the same
        // operation with a newer revision would apply a decision made against a
        // draft that no longer exists; re-planning addresses what is there now.
        const { handle, applied } = createHandle({
            reads: [
                {
                    status: 'ready',
                    snapshot: snapshot({ revision: 12, attachments: [triageAttachment('42', 'triage-0')] }),
                },
                {
                    status: 'ready',
                    snapshot: snapshot({ revision: 13, attachments: [triageAttachment('42', 'triage-9')] }),
                },
            ],
            applies: [{ status: 'conflict', currentRevision: 13 }, { status: 'applied', revision: 14 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({ kind: 'applied' });
        expect(applied).toHaveLength(2);
        // The replay addresses the record the *second* read reported, at the
        // revision that read carried.
        expect(applied[1]).toEqual({
            expectedRevision: 13,
            operations: [{ kind: 'attachment.remove', instanceId: 'triage-9' }],
        });
    });

    it('settles instead of resurrecting an entry the replay finds already gone', async () => {
        const { handle, applied } = createHandle({
            reads: [
                {
                    status: 'ready',
                    snapshot: snapshot({ revision: 12, attachments: [triageAttachment('42', 'triage-0')] }),
                },
                { status: 'ready', snapshot: snapshot({ revision: 13 }) },
            ],
            applies: [{ status: 'conflict', currentRevision: 13 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({ kind: 'settled' });
        expect(applied).toHaveLength(1);
    });

    it('reports a second conflict instead of retrying forever', async () => {
        const { handle, applied } = createHandle({
            reads: [{
                status: 'ready',
                snapshot: snapshot({ revision: 12, attachments: [triageAttachment('42', 'triage-0')] }),
            }],
            applies: [{ status: 'conflict', currentRevision: 13 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({
            kind: 'refused',
            reason: 'The draft changed while this was applied. Try again.',
        });
        expect(applied).toHaveLength(2);
    });

    it('refuses a closed composer without planning anything', async () => {
        const { handle, applied } = createHandle({
            reads: [{ status: 'unavailable', reason: 'scopeClosed' }],
            applies: [{ status: 'applied', revision: 1 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({ kind: 'refused', reason: 'The composer is no longer open.' });
        expect(applied).toHaveLength(0);
    });

    it('settles a rejected read instead of leaving the control pending', async () => {
        // The host API throws rather than answering when the mounted scope's
        // method is not currently negotiated -- a daemon reconnect is enough.
        // An escaping rejection never reaches the caller's outcome branch, so
        // the invoked control stays pending with no error and no way out.
        const { handle, applied } = createHandle({
            reads: [new Error('host_api_method_unavailable:readComposer')],
            applies: [{ status: 'applied', revision: 1 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({
            kind: 'refused',
            reason: 'The composer could not be reached. Try again.',
        });
        expect(applied).toHaveLength(0);
    });

    it('rethrows a cancellation instead of inventing a settled refusal', async () => {
        // `hostCancellation.ts` states the rule the blanket catch must not
        // break: "Reporting a cancelled call as a settled outcome invents an
        // answer nobody received." A caller that aborted learned nothing about
        // the composer, so telling it the composer "could not be reached" is a
        // fact nobody established — and it is indistinguishable from the real
        // transport failure the sibling tests above cover.
        const controller = new AbortController();
        controller.abort();
        const { handle, applied } = createHandle({
            reads: [new DOMException('Aborted', 'AbortError')],
            applies: [{ status: 'applied', revision: 1 }],
        });

        await expect(applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
            options: { signal: controller.signal },
        })).rejects.toThrow();
        expect(applied).toHaveLength(0);
    });

    it('settles a rejected apply instead of leaving the control pending', async () => {
        const { handle, applied } = createHandle({
            reads: [{
                status: 'ready',
                snapshot: snapshot({ revision: 12, attachments: [triageAttachment('42', 'triage-0')] }),
            }],
            applies: [new Error('transport closed')],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({
            kind: 'refused',
            reason: 'The composer could not be reached. Try again.',
        });
        expect(applied).toHaveLength(1);
    });

    it('settles a rejection raised by the conflict replay', async () => {
        // The replay reaches the same boundary a second time, so its rejection
        // has to settle through the same answer rather than escaping the
        // outcome the first attempt was already committed to producing.
        const { handle } = createHandle({
            reads: [
                {
                    status: 'ready',
                    snapshot: snapshot({ revision: 12, attachments: [triageAttachment('42', 'triage-0')] }),
                },
                new Error('transport closed'),
            ],
            applies: [{ status: 'conflict', currentRevision: 13 }],
        });

        const outcome = await applyTriageEntryMutation({
            handle,
            intent: 'remove',
            entryRef: entryRef('42'),
        });

        expect(outcome).toEqual({
            kind: 'refused',
            reason: 'The composer could not be reached. Try again.',
        });
    });
});
