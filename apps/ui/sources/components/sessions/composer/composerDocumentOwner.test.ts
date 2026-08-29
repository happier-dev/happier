import type { ComposerAttachmentDraftV1, ComposerRefV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createEphemeralComposerDocumentOwner } from './composerDocumentOwner';
import { projectComposerDocumentSnapshot } from './composerSnapshotProjection';

const participantRef: ComposerRefV1 = {
    kind: 'participantMessage',
    sessionId: 'session-a',
    instanceId: 'participant-a',
};

const attachment: ComposerAttachmentDraftV1 = {
    v: 1,
    instanceId: 'attachment-a',
    attachment: { pluginId: 'example.plugin', localId: 'ticket' },
    key: 'ticket-a',
    value: { id: 42 },
    presentation: {
        typeLabel: 'Ticket',
        label: 'Issue 42',
    },
};

describe('ComposerDocumentOwner', () => {
    it('advances one native revision for one atomic semantic transaction', () => {
        const listener = vi.fn();
        const owner = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
        });
        owner.observe(listener);

        const result = owner.apply(0, {
            text: '@issue please inspect',
            references: [{
                kind: 'plugin',
                ref: 'issue:42',
                token: '@issue',
                label: 'Issue 42',
                start: 0,
                end: 6,
            }],
            attachments: [{ ...attachment, availability: { status: 'ready' } }],
        });

        expect(result).toEqual({ status: 'applied', revision: 1 });
        expect(owner.read()).toMatchObject({
            revision: 1,
            document: {
                text: '@issue please inspect',
                composerAttachments: [attachment],
            },
        });
        expect(owner.read().document.structuredInputMentions).toHaveLength(1);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('uses field mutation currentness so A to B to A cannot clear a newer edit', () => {
        const owner = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: {
                text: 'A',
                structuredInputMentions: [],
                composerAttachments: [],
            },
        });
        const accepted = owner.captureCurrentness();

        expect(owner.apply(0, { text: 'B', references: [], attachments: [] })).toMatchObject({ revision: 1 });
        expect(owner.apply(1, { text: 'A', references: [], attachments: [] })).toMatchObject({ revision: 2 });

        expect(owner.clearAccepted(accepted).changed).toBe(false);
        expect(owner.read().document.text).toBe('A');
    });

    // A valid public `attachment.update` may carry an equivalent strict-JSON
    // value in another object-key order. Deciding that by serialization made it
    // a mutation here — advancing the field revision and making the accepted
    // snapshot unable to clear it — while the durable draft repository, which
    // asks the Protocol equality owner, treated the same value as unchanged.
    it('treats an equivalent strict-JSON attachment value as unchanged whatever its key order', () => {
        const owner = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: {
                text: 'ready',
                structuredInputMentions: [],
                composerAttachments: [{ ...attachment, value: { a: 1, b: 2 } }],
            },
        });
        const accepted = owner.captureCurrentness();

        expect(owner.apply(0, {
            text: 'ready',
            references: [],
            attachments: [{
                ...attachment,
                value: { b: 2, a: 1 },
                availability: { status: 'ready' },
            }],
        })).toEqual({ status: 'applied', revision: 0 });
        expect(owner.clearAccepted(accepted).changed).toBe(true);
        expect(owner.read().document.composerAttachments).toEqual([]);

        // Positive twin: a real nested value change is still a mutation.
        const changed = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: {
                text: 'ready',
                structuredInputMentions: [],
                composerAttachments: [{ ...attachment, value: { a: 1, b: 2 } }],
            },
        });
        expect(changed.apply(0, {
            text: 'ready',
            references: [],
            attachments: [{
                ...attachment,
                value: { a: 1, b: 3 },
                availability: { status: 'ready' },
            }],
        })).toEqual({ status: 'applied', revision: 1 });
    });

    it('keeps currentness isolated by exact composer ref', () => {
        const first = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: { text: 'first', structuredInputMentions: [], composerAttachments: [] },
        });
        const second = createEphemeralComposerDocumentOwner({
            ref: { ...participantRef, instanceId: 'participant-b' },
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: { text: 'second', structuredInputMentions: [], composerAttachments: [] },
        });

        expect(second.clearAccepted(first.captureCurrentness()).changed).toBe(false);
        expect(second.read().document.text).toBe('second');
    });

    it('supports participant semantic attachments and refuses them for automation', () => {
        const participant = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
        });
        const automation = createEphemeralComposerDocumentOwner({
            ref: {
                kind: 'automationAuthoring',
                sessionId: 'session-a',
                instanceId: 'automation-a',
            },
            capabilities: { text: true, references: true, attachments: false, submit: false },
        });
        const mutation = {
            text: '',
            references: [],
            attachments: [{ ...attachment, availability: { status: 'ready' as const } }],
        };

        expect(participant.apply(0, mutation)).toMatchObject({ status: 'applied' });
        expect(automation.apply(0, mutation)).toMatchObject({ status: 'invalidOperation' });
        expect(automation.read().document.composerAttachments).toEqual([]);
    });

    it('owns semantic document data only', () => {
        const owner = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
        });

        expect(Object.keys(owner.read().document).sort()).toEqual([
            'composerAttachments',
            'structuredInputMentions',
            'text',
        ]);
    });

    it('keeps unavailable plugin fallback visible and presentation-only state outside the document', () => {
        const owner = createEphemeralComposerDocumentOwner({
            ref: participantRef,
            capabilities: { text: true, references: true, attachments: true, submit: true },
            initialDocument: {
                text: 'draft',
                structuredInputMentions: [],
                composerAttachments: [attachment],
            },
        });

        const snapshot = projectComposerDocumentSnapshot({
            owner,
            attachmentCatalog: { entriesById: null },
            presentation: {
                layout: 'collapsed',
                focused: true,
                editable: true,
                submittable: false,
                submitting: false,
                running: false,
                inputLock: { mode: 'submit', reasons: ['Plugin unavailable'] },
            },
        });

        expect(snapshot.attachments).toEqual([{
            ...attachment,
            availability: { status: 'unavailable' },
        }]);
        expect(snapshot.state.inputLock).toEqual({ mode: 'submit', reasons: ['Plugin unavailable'] });
        expect(owner.read().document).toEqual({
            text: 'draft',
            structuredInputMentions: [],
            composerAttachments: [attachment],
        });
    });
});
