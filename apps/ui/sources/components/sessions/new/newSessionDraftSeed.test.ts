import { describe, expect, it, vi } from 'vitest';

import type { NewSessionDraft } from '@/sync/domains/state/persistence';

import { applyNewSessionDraftSeedV1, seedNewSessionDraftV1 } from './newSessionDraftSeed';

function existingDraft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
    return {
        input: 'Existing draft',
        selectedMachineId: 'machine-a',
        selectedPath: '/repo',
        entryIntent: 'automation',
        selectedProfileId: 'profile-a',
        selectedSecretId: 'secret-a',
        agentType: 'claude',
        permissionMode: 'default',
        acpSessionModeId: null,
        updatedAt: 1,
        ...overrides,
    };
}

describe('applyNewSessionDraftSeedV1', () => {
    it('seeds prompt, profile and placement onto an existing draft without dropping its other selections', () => {
        const seeded = applyNewSessionDraftSeedV1({
            seed: {
                prompt: { text: 'Repair the failing check', mode: 'replace' },
                profileId: 'profile-review',
                placement: { serverId: 'server-b', machineId: 'machine-b', directory: '/work/repo' },
            },
            existingDraft: existingDraft(),
            updatedAt: 99,
        });

        expect(seeded).toMatchObject({
            input: 'Repair the failing check',
            selectedProfileId: 'profile-review',
            targetServerId: 'server-b',
            selectedMachineId: 'machine-b',
            selectedPath: '/work/repo',
            // A seeded New Session is a Session: an Automation draft left in the
            // scope must not swallow the seed into an Automation definition.
            entryIntent: 'session',
            updatedAt: 99,
            // Untouched selections survive.
            selectedSecretId: 'secret-a',
            permissionMode: 'default',
        });
    });

    it('appends rather than replaces when the seed says so', () => {
        const seeded = applyNewSessionDraftSeedV1({
            seed: { prompt: { text: 'Second selection', mode: 'append' } },
            existingDraft: existingDraft({ input: 'First selection' }),
            updatedAt: 2,
        });

        expect(seeded.input).toBe('First selection\n\nSecond selection');
    });

    it('leaves a member the seed did not declare exactly as it was', () => {
        const seeded = applyNewSessionDraftSeedV1({
            seed: { prompt: { text: 'Only the prompt', mode: 'replace' } },
            existingDraft: existingDraft({ selectedProfileId: 'profile-a' }),
            updatedAt: 3,
        });

        // An absent optional member is "not seeded", never "seeded empty".
        expect(seeded.selectedProfileId).toBe('profile-a');
        expect(seeded.selectedMachineId).toBe('machine-a');
    });

    it('builds a fresh Session draft carrying the seed when the scope holds none', () => {
        const seeded = applyNewSessionDraftSeedV1({
            seed: {
                prompt: { text: 'Fresh', mode: 'append' },
                placement: { machineId: 'machine-b' },
            },
            existingDraft: null,
            updatedAt: 4,
        });

        expect(seeded).toMatchObject({
            input: 'Fresh',
            entryIntent: 'session',
            selectedMachineId: 'machine-b',
            selectedPath: null,
            selectedProfileId: null,
            updatedAt: 4,
        });
    });
});

describe('seedNewSessionDraftV1', () => {
    it('creates one fresh exact draft through the incumbent repository owner', () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const writeDraft = vi.fn();

        const draftId = seedNewSessionDraftV1({
            seed: { prompt: { text: 'Seeded', mode: 'replace' } },
            scope,
            writeDraft,
            createDraftId: () => 'draft-seeded',
            nowMs: () => 7,
        });

        expect(draftId).toBe('draft-seeded');
        expect(writeDraft).toHaveBeenCalledWith({
            scope,
            draftId: 'draft-seeded',
            draft: expect.objectContaining({
                input: 'Seeded',
                entryIntent: 'session',
                updatedAt: 7,
            }),
        });
    });

    it('writes nothing at all for a seed that declares nothing', () => {
        const writeDraft = vi.fn();

        seedNewSessionDraftV1({
            seed: {},
            scope: { serverId: 'server-a', accountId: 'account-a' },
            writeDraft,
            nowMs: () => 7,
        });

        // Stamping `updatedAt` and flipping `entryIntent` for a seed that carries
        // nothing would silently retire a reader's in-progress Automation draft.
        expect(writeDraft).not.toHaveBeenCalled();
    });

    it('treats a seed that only attaches entries as a real change', () => {
        // "Open New Session with these entries on it" carries no prompt of its
        // own. Reading it as an empty seed refuses the whole destination and
        // leaves the reader pressing a button that does nothing.
        const writeDraft = vi.fn();

        const seeded = seedNewSessionDraftV1({
            seed: {
                attachments: [{
                    attachmentLocalId: 'entry',
                    value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
            }],
            },
            scope: { serverId: 'server-a', accountId: 'account-a' },
            writeDraft,
            nowMs: () => 7,
        });

        expect(seeded).not.toBeNull();
        expect(writeDraft).toHaveBeenCalledTimes(1);
        // The RECORD is not written here: the persisted draft carries finished
        // attachment drafts, and only a mounted composer can mint one.
        expect(writeDraft.mock.calls[0]?.[0].draft).not.toHaveProperty('composerAttachments');
    });
});
