import { describe, expect, it } from 'vitest';
import { createEphemeralComposerDocumentOwner, type ComposerDraftDocument } from './composerDocumentOwner';
import { withdrawPendingMessageToComposer } from './pendingMessageComposerDocumentOwner';

const original: ComposerDraftDocument = {
    text: '@issue Original typed text',
    structuredInputMentions: [{ kind: 'partner.reference', ref: 'partner:42', tokenText: '@issue', start: 0, end: 6 }],
    composerAttachments: [{
        v: 1, instanceId: 'attachment-42', attachment: { pluginId: 'example.plugin', localId: 'ticket' },
        key: '42', value: { issue: 42 }, presentation: { typeLabel: 'Ticket', label: 'Issue 42' },
    }],
};

function createComposer() {
    return createEphemeralComposerDocumentOwner({
        ref: { kind: 'session', sessionId: 'session-a' },
        capabilities: { text: true, references: true, attachments: true, submit: true },
    });
}

describe('pending withdrawal draft recovery', () => {
    it('restores the original display document with mentions and attachment values after confirmed removal', async () => {
        const composer = createComposer();
        const result = await withdrawPendingMessageToComposer({
            composer, document: original, isCurrent: () => true, withdraw: async () => 'removed',
        });
        expect(result).toEqual({ outcome: 'removed', status: 'restored' });
        expect(composer.read().document).toEqual(original);
    });

    it.each(['already_delivered', 'delivery_unknown'] as const)('preserves the composer for %s', async (outcome) => {
        const composer = createComposer();
        await expect(withdrawPendingMessageToComposer({
            composer, document: original, isCurrent: () => true, withdraw: async () => outcome,
        })).resolves.toEqual({ outcome, status: 'not_removed' });
        expect(composer.read().document.text).toBe('');
    });

    it('preserves newer input entered while removal is awaiting the owner', async () => {
        const composer = createComposer();
        const newer = { text: 'Newer draft', structuredInputMentions: [], composerAttachments: [] };
        const result = await withdrawPendingMessageToComposer({
            composer, document: original, isCurrent: () => true,
            withdraw: async () => { composer.replaceDocument(newer); return 'removed'; },
        });
        expect(result).toEqual({ outcome: 'removed', status: 'composer_changed' });
        expect(composer.read().document).toEqual(newer);
    });

    it('does not overwrite a draft after the Account, Home, or composer context retires', async () => {
        const composer = createComposer();
        let current = true;
        const result = await withdrawPendingMessageToComposer({
            composer, document: original, isCurrent: () => current,
            withdraw: async () => { current = false; return 'removed'; },
        });
        expect(result).toEqual({ outcome: 'removed', status: 'context_retired' });
        expect(composer.read().document.text).toBe('');
    });
});
