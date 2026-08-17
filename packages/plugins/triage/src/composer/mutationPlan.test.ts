import type { ComposerAttachmentViewV1, ComposerSnapshotV1 } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import { deriveTriageComposerEntryAttachmentKey } from './attachmentValue.js';
import { planTriageEntryAttachmentMutation } from './mutationPlan.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE_ID = '2f1c9b4e-7a55-4a8c-9d2e-0b6f4c3a1d78';
const SOURCE_INSTANCE = { source: SOURCE, sourceInstanceId: INSTANCE_ID } as const;
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
        presentation: { typeLabel: 'Pull request', label: `Fix ${entryId}` },
        availability: { status: 'ready' },
    } as ComposerAttachmentViewV1;
}

function snapshot(input: Readonly<{
    revision?: number;
    text?: string;
    attachments?: readonly ComposerAttachmentViewV1[];
    attachmentsSupported?: boolean;
}> = {}): ComposerSnapshotV1 {
    return {
        revision: input.revision ?? 7,
        ref: { kind: 'session', sessionId: 'session-1' },
        text: input.text ?? 'please review this',
        selection: { start: 3, end: 9 },
        references: [],
        attachments: [...(input.attachments ?? [])],
        layout: 'wrap',
        capabilities: {
            text: true,
            references: true,
            attachments: input.attachmentsSupported ?? true,
            submit: true,
        },
        state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
    } as ComposerSnapshotV1;
}

describe('planTriageEntryAttachmentMutation — attach', () => {
    it('plans exactly one attachment.add against the read revision', () => {
        const plan = planTriageEntryAttachmentMutation({
            intent: 'attach',
            snapshot: snapshot({ revision: 12 }),
            entryRef: entryRef('42'),
            sourceInstance: SOURCE_INSTANCE,
            presentation: PRESENTATION,
        });

        expect(plan).toEqual({
            status: 'transaction',
            transaction: {
                expectedRevision: 12,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'entry',
                    value: {
                        key: deriveTriageComposerEntryAttachmentKey(entryRef('42')),
                        value: { v: 1, entryRef: entryRef('42'), sourceInstance: SOURCE_INSTANCE },
                        presentation: PRESENTATION,
                    },
                }],
            },
        });
    });

    it('carries no text or reference operation, so the draft prose survives byte-identical', () => {
        // The one entry admission is the attachment. A text or reference
        // operation here would be a second, independently persisted path to the
        // same entry and would rewrite prose the user typed.
        const plan = planTriageEntryAttachmentMutation({
            intent: 'attach',
            snapshot: snapshot({ text: 'please review this' }),
            entryRef: entryRef('42'),
            sourceInstance: SOURCE_INSTANCE,
            presentation: PRESENTATION,
        });

        expect(plan.status).toBe('transaction');
        if (plan.status !== 'transaction') return;
        const kinds = plan.transaction.operations.map((operation) => operation.kind);
        expect(kinds).toEqual(['attachment.add']);
        expect(kinds.some((kind) => kind.startsWith('text.') || kind.startsWith('reference.'))).toBe(false);
    });

    it('repeats the same canonical key for an already attached entry so the record updates in place', () => {
        const attached = triageAttachment('42', 'triage-1');
        const plan = planTriageEntryAttachmentMutation({
            intent: 'attach',
            snapshot: snapshot({ attachments: [attached] }),
            entryRef: entryRef('42'),
            sourceInstance: SOURCE_INSTANCE,
            presentation: PRESENTATION,
        });

        expect(plan.status).toBe('transaction');
        if (plan.status !== 'transaction') return;
        expect(plan.transaction.operations).toHaveLength(1);
        const [operation] = plan.transaction.operations;
        expect(operation?.kind).toBe('attachment.add');
        if (operation?.kind !== 'attachment.add') return;
        expect(operation.value.key).toBe(attached.key);
    });

    it('carries only the private identity record as the value', () => {
        const plan = planTriageEntryAttachmentMutation({
            intent: 'attach',
            snapshot: snapshot(),
            entryRef: entryRef('42'),
            sourceInstance: SOURCE_INSTANCE,
            presentation: PRESENTATION,
        });

        if (plan.status !== 'transaction') throw new Error('expected a transaction');
        const [operation] = plan.transaction.operations;
        if (operation?.kind !== 'attachment.add') throw new Error('expected an attachment.add');
        expect(Object.keys(operation.value.value as object).sort()).toEqual(['entryRef', 'sourceInstance', 'v']);
    });

    it('refuses an instance that belongs to another source instead of substituting one', () => {
        const plan = planTriageEntryAttachmentMutation({
            intent: 'attach',
            snapshot: snapshot(),
            entryRef: entryRef('42'),
            sourceInstance: {
                source: { pluginId: 'happier.tracker', localId: 'items' },
                sourceInstanceId: INSTANCE_ID,
            },
            presentation: PRESENTATION,
        });

        expect(plan).toEqual({ status: 'refused', reason: 'invalidValue' });
    });

    it('refuses a composer scope that admits no attachment', () => {
        const plan = planTriageEntryAttachmentMutation({
            intent: 'attach',
            snapshot: snapshot({ attachmentsSupported: false }),
            entryRef: entryRef('42'),
            sourceInstance: SOURCE_INSTANCE,
            presentation: PRESENTATION,
        });

        expect(plan).toEqual({ status: 'refused', reason: 'attachmentsUnsupported' });
    });
});

describe('planTriageEntryAttachmentMutation — remove', () => {
    it('removes the host-minted instance the snapshot reports', () => {
        const plan = planTriageEntryAttachmentMutation({
            intent: 'remove',
            snapshot: snapshot({ revision: 3, attachments: [triageAttachment('41', 'triage-0'), triageAttachment('42', 'triage-1')] }),
            entryRef: entryRef('42'),
        });

        expect(plan).toEqual({
            status: 'transaction',
            transaction: {
                expectedRevision: 3,
                operations: [{ kind: 'attachment.remove', instanceId: 'triage-1' }],
            },
        });
    });

    it('reports an already absent removal as the current desired state rather than re-adding it', () => {
        // The host badge may have removed it a moment earlier. Planning an add
        // here would resurrect an entry the user just removed.
        const plan = planTriageEntryAttachmentMutation({
            intent: 'remove',
            snapshot: snapshot({ attachments: [triageAttachment('41', 'triage-0')] }),
            entryRef: entryRef('42'),
        });

        expect(plan).toEqual({ status: 'alreadySettled', reason: 'notAttached' });
    });

    it('removes a record whose persisted value no longer parses', () => {
        const stale = {
            ...triageAttachment('42', 'triage-1'),
            value: { v: 1 },
        } as ComposerAttachmentViewV1;

        const plan = planTriageEntryAttachmentMutation({
            intent: 'remove',
            snapshot: snapshot({ attachments: [stale] }),
            entryRef: entryRef('42'),
        });

        expect(plan).toEqual({
            status: 'transaction',
            transaction: {
                expectedRevision: 7,
                operations: [{ kind: 'attachment.remove', instanceId: 'triage-1' }],
            },
        });
    });

    it('ignores another plugin attachment that happens to carry the same key', () => {
        const foreign = {
            ...triageAttachment('42', 'other-1'),
            attachment: { pluginId: 'happier.files', localId: 'entry' },
        } as ComposerAttachmentViewV1;

        const plan = planTriageEntryAttachmentMutation({
            intent: 'remove',
            snapshot: snapshot({ attachments: [foreign] }),
            entryRef: entryRef('42'),
        });

        expect(plan).toEqual({ status: 'alreadySettled', reason: 'notAttached' });
    });
});
