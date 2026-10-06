import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
    writeExistingSessionDraft,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { createRepositoryComposerDocumentOwner } from './repositoryComposerDocumentOwner';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

afterEach(() => {
    resetSessionDraftRepositoryForTests();
});

describe('repositoryComposerDocumentOwner', () => {
    it('retires every mounted mutation path when its exact credential lifetime is replaced', async () => {
        const sessionId = 'session-retired-owner';
        writeExistingSessionDraft({ scope, sessionId, patch: { text: 'owned by the old credential' } });
        let current = true;
        const owner = createRepositoryComposerDocumentOwner({
            scope,
            ref: { kind: 'session', sessionId },
            isCurrent: () => current,
        });
        const captured = owner.captureCurrentness();
        current = false;

        expect(owner.read().document.text).toBe('');
        expect(owner.apply(owner.read().revision, {
            text: 'stale edit',
            references: [],
            attachments: [],
        })).toEqual({ status: 'composerUnavailable' });
        expect(owner.clearAccepted(captured).changed).toBe(false);
        expect(owner.replaceDocument({
            text: 'stale replacement',
            structuredInputMentions: [],
            composerAttachments: [],
        })).toBe(owner.read().revision);
        owner.clear('discarded');
        await Promise.resolve();

        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId })
            ?.document.composer.text.value).toBe('owned by the old credential');
    });

    it('keeps participant presentation identity while persisting an exact Run draft', () => {
        const sessionId = 'session-run-draft';
        const runId = 'run-a';
        const ref = { kind: 'participantMessage', sessionId, instanceId: 'composer-a' } as const;
        const address = { kind: 'run', sessionId, runId } as const;
        const owner = createRepositoryComposerDocumentOwner({ scope, ref, address });

        expect(owner.ref).toEqual(ref);
        expect(owner.apply(0, {
            text: 'run-only draft',
            references: [],
            attachments: [],
        })).toMatchObject({ status: 'applied' });
        expect(getSessionDraftSnapshot(scope, address)?.document.composer.text.value).toBe('run-only draft');
        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId })).toBeNull();

        const currentness = owner.captureCurrentness();
        writeExistingSessionDraft({ scope, sessionId, runId, patch: { text: 'newer run edit' } });
        expect(owner.clearAccepted(currentness).changed).toBe(false);
        expect(getSessionDraftSnapshot(scope, address)?.document.composer.text.value).toBe('newer run edit');
    });

    it('keeps an absent empty composer stable when authoring first creates the repository draft', () => {
        const ref = { kind: 'newSession', instanceId: 'draft-a' } as const;
        const owner = createRepositoryComposerDocumentOwner({ scope, ref });
        const before = owner.read();
        const listener = vi.fn();
        owner.observe(listener);

        writeNewSessionDraft({
            scope,
            draftId: ref.instanceId,
            patch: { authoring: { profileId: 'profile-a' } },
            materializationIntent: 'userEdit',
        });

        const after = owner.read();
        expect(after.document).toBe(before.document);
        expect(after.revision).toBe(before.revision);
        expect(listener).not.toHaveBeenCalled();
    });

    it('converts structured mentions to positional references when replacing a document', () => {
        const sessionId = 'session-replace-document-mentions';
        const ref = { kind: 'session', sessionId } as const;
        const owner = createRepositoryComposerDocumentOwner({ scope, ref });
        const mention = {
            kind: 'mention' as const,
            ref: 'vendor:issue-42',
            tokenText: '@issue',
            start: 0,
            end: 6,
            label: 'Issue',
        };

        owner.replaceDocument({
            text: '@issue',
            structuredInputMentions: [mention],
            composerAttachments: [],
        });

        expect(owner.read().document.structuredInputMentions).toEqual([mention]);
        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId })
            ?.document.composer.mentions.value).toEqual([
            expect.objectContaining({ ref: 'vendor:issue-42', tokenText: '@issue', start: 0, end: 6 }),
        ]);
    });
});

describe('repositoryComposerDocumentOwner Session revision', () => {
    it('does not reconstruct duplicate positionless mentions onto arbitrary equal tokens', () => {
        const sessionId = 'session-legacy-mentions';
        const text = 'first @same then @same';
        writeExistingSessionDraft({
            scope,
            sessionId,
            patch: {
                text,
                mentions: [
                    { kind: 'mention', ref: 'first', tokenText: '@same' },
                    { kind: 'mention', ref: 'second', tokenText: '@same' },
                ],
            },
        });

        const owner = createRepositoryComposerDocumentOwner({
            scope,
            ref: { kind: 'session', sessionId },
        });

        expect(owner.read().document.structuredInputMentions).toEqual([]);
        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId })
            ?.document.composer.mentions.value).toEqual([
            { kind: 'mention', ref: 'first', tokenText: '@same' },
            { kind: 'mention', ref: 'second', tokenText: '@same' },
        ]);
    });

    it('does not relocate a current ranged mention whose exact occurrence is stale', () => {
        const sessionId = 'session-stale-ranged-mention';
        const staleMention = { kind: 'mention', ref: 'stale', tokenText: '@same', start: 0, end: 5 };
        writeExistingSessionDraft({
            scope,
            sessionId,
            patch: { text: 'prefix @same then @same', mentions: [staleMention] },
        });

        const owner = createRepositoryComposerDocumentOwner({
            scope,
            ref: { kind: 'session', sessionId },
        });

        expect(owner.read().document.structuredInputMentions).toEqual([]);
        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId })
            ?.document.composer.mentions.value).toEqual([staleMention]);
    });

    it('reports that no accepted fields cleared when every captured mutation was superseded', () => {
        const sessionId = 'session-currentness-a';
        const ref = { kind: 'session', sessionId } as const;
        writeExistingSessionDraft({
            scope,
            sessionId,
            patch: { text: 'A', mentions: [], attachments: [] },
        });
        const owner = createRepositoryComposerDocumentOwner({ scope, ref });
        const currentness = owner.captureCurrentness();

        writeExistingSessionDraft({
            scope,
            sessionId,
            patch: { text: 'B', mentions: [{ phase: 'B' }], attachments: [{ phase: 'B' }] },
        });
        writeExistingSessionDraft({
            scope,
            sessionId,
            patch: { text: 'A', mentions: [], attachments: [] },
        });

        expect(owner.clearAccepted(currentness).changed).toBe(false);
        expect(owner.read().document).toEqual({
            text: 'A',
            structuredInputMentions: [],
            composerAttachments: [],
        });
    });

    it('clears current text and mentions while retaining a newer attachment edit', () => {
        const sessionId = 'session-partial-clear';
        const ref = { kind: 'session', sessionId } as const;
        writeExistingSessionDraft({
            scope,
            sessionId,
            patch: {
                text: '@issue draft',
                mentions: [{ kind: 'happier.file', ref: 'file:issue-42', tokenText: '@issue', start: 0, end: 6 }],
                attachments: [],
            },
        });
        const owner = createRepositoryComposerDocumentOwner({ scope, ref });
        const currentness = owner.captureCurrentness();
        const attachmentDraft = {
            v: 1 as const,
            instanceId: 'attachment-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };
        const attachment = {
            ...attachmentDraft,
            availability: { status: 'ready' as const },
        };
        expect(owner.apply(owner.read().revision, {
            text: owner.read().document.text,
            references: [{ kind: 'happier.file', ref: 'file:issue-42', token: '@issue', start: 0, end: 6 }],
            attachments: [attachment],
        }).status).toBe('applied');

        expect(owner.clearAccepted(currentness)).toEqual({
            changed: true,
            changes: {
                text: true,
                structuredInputMentions: true,
                composerAttachments: false,
            },
            acceptedFieldsCurrent: {
                text: true,
                structuredInputMentions: true,
                composerAttachments: false,
            },
        });
        expect(owner.read().document).toEqual({
            text: '',
            structuredInputMentions: [],
            composerAttachments: [attachmentDraft],
        });
    });

    it('rebases a Run reference that remains in newer text and preserves it after the older submission succeeds', () => {
        const sessionId = 'session-run-reference-rebase';
        const runId = 'run-reference-rebase';
        const address = { kind: 'run', sessionId, runId } as const;
        const owner = createRepositoryComposerDocumentOwner({
            scope,
            ref: { kind: 'participantMessage', sessionId, instanceId: runId },
            address,
        });
        owner.replaceDocument({
            text: '@issue accepted',
            structuredInputMentions: [{
                kind: 'mention',
                ref: 'vendor:issue-42',
                tokenText: '@issue',
                start: 0,
                end: 6,
            }],
            composerAttachments: [],
        });
        const accepted = owner.captureCurrentness();

        owner.replaceDocument({
            text: 'prefix @issue accepted',
            structuredInputMentions: owner.read().document.structuredInputMentions,
            composerAttachments: [],
        });

        expect(owner.clearAccepted(accepted).changed).toBe(false);
        expect(owner.read().document).toMatchObject({
            text: 'prefix @issue accepted',
            structuredInputMentions: [{
                ref: 'vendor:issue-42',
                tokenText: '@issue',
                start: 7,
                end: 13,
            }],
        });
    });

    it.each(['session', 'run'] as const)('clears a newer %s reference-only edit with unchanged accepted text', (kind) => {
        const sessionId = 'session-run-reference-clear';
        const runId = 'run-reference-clear';
        const address = kind === 'run'
            ? { kind: 'run', sessionId, runId } as const
            : { kind: 'session', sessionId } as const;
        const owner = createRepositoryComposerDocumentOwner({
            scope,
            ref: kind === 'run'
                ? { kind: 'participantMessage', sessionId, instanceId: runId }
                : { kind: 'session', sessionId },
            address,
        });
        owner.replaceDocument({
            text: '@issue accepted',
            structuredInputMentions: [],
            composerAttachments: [],
        });
        const accepted = owner.captureCurrentness();

        owner.replaceDocument({
            text: '@issue accepted',
            structuredInputMentions: [{
                kind: 'mention',
                ref: 'vendor:issue-42',
                tokenText: '@issue',
                start: 0,
                end: 6,
            }],
            composerAttachments: [],
        });

        expect(owner.clearAccepted(accepted)).toMatchObject({
            changed: true,
            changes: { text: true, structuredInputMentions: true },
        });
        expect(owner.read().document).toEqual({
            text: '',
            structuredInputMentions: [],
            composerAttachments: [],
        });
    });

    it('projects the repository document revision so a fresh owner cannot overwrite a newer draft', () => {
        const sessionId = 'session-revision-a';
        const ref = { kind: 'session', sessionId } as const;
        writeExistingSessionDraft({ scope, sessionId, patch: { text: 'before' } });

        const reader = createRepositoryComposerDocumentOwner({ scope, ref });
        const read = reader.read();
        expect(read.revision).toBe(
            getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.revision,
        );

        // Another writer advances the durable draft after that read.
        writeExistingSessionDraft({ scope, sessionId, patch: { text: 'newer' } });

        // The exact offscreen apply path constructs a fresh owner per call, so
        // the stale revision must still be refused rather than reset to zero.
        const writer = createRepositoryComposerDocumentOwner({ scope, ref });
        const result = writer.apply(read.revision, { text: 'stale', references: [], attachments: [] });

        expect(result).toEqual({
            status: 'conflict',
            currentRevision: getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.revision,
        });
        expect(getSessionDraftSnapshot(scope, { kind: 'session', sessionId })?.document.composer.text.value)
            .toBe('newer');
    });

    it('keeps the New Session composer revision host-private and instance-local', () => {
        const ref = { kind: 'newSession', instanceId: 'draft-revision-a' } as const;
        writeNewSessionDraft({
            scope,
            draftId: ref.instanceId,
            patch: { text: 'seeded' },
            materializationIntent: 'userEdit',
        });

        const owner = createRepositoryComposerDocumentOwner({ scope, ref });

        expect(owner.read().revision).toBe(0);
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: ref.instanceId })?.revision)
            .toBeGreaterThan(0);
    });
});
