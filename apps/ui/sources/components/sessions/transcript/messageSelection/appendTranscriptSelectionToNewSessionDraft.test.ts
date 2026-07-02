import { describe, expect, it, vi } from 'vitest';

import type { NewSessionDraft } from '@/sync/domains/state/persistence';

import { appendTranscriptSelectionToNewSessionDraft } from './appendTranscriptSelectionToNewSessionDraft';

function createDraft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
    return {
        input: 'Existing draft',
        selectedMachineId: 'machine-a',
        selectedPath: '/repo',
        entryIntent: 'automation',
        selectedProfileId: 'profile-a',
        selectedSecretId: 'secret-a',
        agentType: 'claude',
        permissionMode: 'default',
        modelMode: 'default',
        acpSessionModeId: null,
        updatedAt: 1,
        ...overrides,
    };
}

describe('appendTranscriptSelectionToNewSessionDraft', () => {
    it('appends the transcript prompt to an existing scoped new-session draft without losing selections', () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const existingDraft = createDraft({ targetServerId: 'server-existing' });
        const saveNewSessionDraft = vi.fn();

        appendTranscriptSelectionToNewSessionDraft({
            promptText: 'Forwarded transcript',
            sourceServerId: 'server-a',
            scope,
            nowMs: () => 123,
            loadNewSessionDraft: vi.fn(() => existingDraft),
            saveNewSessionDraft,
        });

        expect(saveNewSessionDraft).toHaveBeenCalledWith({
            ...existingDraft,
            input: 'Existing draft\n\nForwarded transcript',
            entryIntent: 'session',
            updatedAt: 123,
        }, scope);
    });

    it('creates a session draft targeting the source server when no draft exists', () => {
        const saveNewSessionDraft = vi.fn();

        appendTranscriptSelectionToNewSessionDraft({
            promptText: 'Forwarded transcript',
            sourceServerId: 'server-a',
            scope: null,
            nowMs: () => 456,
            loadNewSessionDraft: vi.fn(() => null),
            saveNewSessionDraft,
        });

        expect(saveNewSessionDraft).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Forwarded transcript',
            selectedMachineId: null,
            selectedPath: null,
            entryIntent: 'session',
            agentType: 'claude',
            permissionMode: 'default',
            modelMode: 'default',
            acpSessionModeId: null,
            targetServerId: 'server-a',
            updatedAt: 456,
        }), null);
    });
});
