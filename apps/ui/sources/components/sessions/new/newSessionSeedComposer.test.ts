import { describe, expect, it, vi } from 'vitest';

const storeTempDataSpy = vi.hoisted(() => vi.fn(() => 'seed-handoff'));
const getTempDataSpy = vi.hoisted(() => vi.fn());

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: storeTempDataSpy,
    getTempData: getTempDataSpy,
}));

import { readPluginNewSessionSeedV1, seedAndOpenNewSession } from './newSessionSeedComposer';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

describe('readPluginNewSessionSeedV1', () => {
    it('admits the dedicated one-shot shape and rejects the retired append/replace prompt shape', () => {
        expect(readPluginNewSessionSeedV1({
            prompt: 'Repair the failing check',
            placement: { directory: '/workspace' },
        })).toMatchObject({ prompt: 'Repair the failing check' });
        expect(readPluginNewSessionSeedV1({
            prompt: { text: 'Repair the failing check', mode: 'append' },
        })).toBeNull();
        expect(readPluginNewSessionSeedV1({ arbitrary: true })).toBeNull();
        expect(readPluginNewSessionSeedV1({ attachments: [] })).toBeNull();
        expect(readPluginNewSessionSeedV1(undefined)).toBeNull();
    });
});

describe('seedAndOpenNewSession', () => {
    function harness(overrides: Partial<Parameters<typeof seedAndOpenNewSession>[0]> = {}) {
        const navigate = vi.fn();
        const writeAttachmentSeeds = vi.fn();
        const outcome = seedAndOpenNewSession({
            seed: { prompt: 'Repair the failing check', placement: { directory: '/work' } },
            pluginId: 'happier.triage',
            scope,
            isCurrent: () => true,
            navigateToNewSession: navigate,
            createDraftId: () => '00000000-0000-4000-8000-000000000042',
            writeAttachmentSeeds,
            ...overrides,
        });
        return { outcome, navigate, writeAttachmentSeeds };
    }

    it('hands the complete fresh seed to the mounted screen without pre-writing a draft', () => {
        storeTempDataSpy.mockClear();
        const { outcome, navigate, writeAttachmentSeeds } = harness({
            seed: {
                prompt: 'Repair the failing check',
                profileId: 'profile-review',
                placement: { serverId: 'server-a', machineId: 'machine-a', directory: '/work' },
            },
        });

        expect(outcome).toEqual({ kind: 'opened', dataId: 'seed-handoff' });
        expect(storeTempDataSpy).toHaveBeenCalledWith({
            prompt: 'Repair the failing check',
            selectedProfileId: 'profile-review',
            machineId: 'machine-a',
            directory: '/work',
        });
        expect(writeAttachmentSeeds).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith({
            dataId: 'seed-handoff',
            draftId: '00000000-0000-4000-8000-000000000042',
            spawnServerId: 'server-a',
            machineId: 'machine-a',
            directory: '/work',
        });
    });

    it('routes incumbent checkout questions and rejects a prepared intent that bypassed mounted materialization', () => {
        for (const checkoutIntent of ['createWorktree', 'ask'] as const) {
            expect(harness({ seed: { checkoutIntent } }).navigate).toHaveBeenCalledWith({
                dataId: 'seed-handoff',
                draftId: '00000000-0000-4000-8000-000000000042',
                worktree: 'new',
            });
        }
        storeTempDataSpy.mockClear();
        const refused = harness({ seed: { checkoutIntent: 'preparedReviewWorkspace' } });
        expect(refused.outcome).toEqual({
            kind: 'unavailable',
            reason: 'prepared_review_workspace_unavailable',
        });
        expect(storeTempDataSpy).not.toHaveBeenCalled();
        expect(refused.navigate).not.toHaveBeenCalled();
        expect(refused.writeAttachmentSeeds).not.toHaveBeenCalled();
    });

    it('stores attachment requests only in the Account+draft handoff owner', () => {
        storeTempDataSpy.mockClear();
        const attachment = {
            attachmentLocalId: 'entry',
            value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
        } as const;
        const { writeAttachmentSeeds } = harness({ seed: { attachments: [attachment] } });

        expect(writeAttachmentSeeds).toHaveBeenCalledWith({
            scope,
            draftId: '00000000-0000-4000-8000-000000000042',
        }, [{ pluginId: 'happier.triage', ...attachment }]);
        expect(storeTempDataSpy).toHaveBeenCalledWith({});
    });

    it('retire-on-refusal leaves no durable draft or pending attachment and a retry opens once', () => {
        getTempDataSpy.mockClear();
        const writeAttachmentSeeds = vi.fn();
        const seed = {
            attachments: [{
                attachmentLocalId: 'entry',
                value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
            }],
        } as const;
        const refused = harness({
            seed,
            writeAttachmentSeeds,
            navigateToNewSession: () => { throw new Error('router unavailable'); },
        });
        expect(refused.outcome).toEqual({ kind: 'unavailable', reason: 'navigation_unavailable' });
        expect(getTempDataSpy).toHaveBeenCalledWith('seed-handoff');
        expect(writeAttachmentSeeds).toHaveBeenLastCalledWith({
            scope,
            draftId: '00000000-0000-4000-8000-000000000042',
        }, []);

        const retry = harness({ seed });
        expect(retry.outcome).toEqual({ kind: 'opened', dataId: 'seed-handoff' });
        expect(retry.navigate).toHaveBeenCalledOnce();
    });

    it('does nothing for invalid, empty, cancelled, retired, or uncredited attachment input', () => {
        for (const [overrides, expected] of [
            [{ seed: { arbitrary: true } }, { kind: 'invalid', reason: 'seed_invalid' }],
            [{ seed: {} }, { kind: 'invalid', reason: 'seed_empty' }],
            [{ signal: AbortSignal.abort() }, { kind: 'unavailable', reason: 'aborted' }],
            [{ isCurrent: () => false }, { kind: 'stale', reason: 'host_retired' }],
            [{
                pluginId: undefined,
                seed: { attachments: [{
                    attachmentLocalId: 'entry',
                    value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
                }] },
            }, { kind: 'invalid', reason: 'seed_attachments_uncredited' }],
        ] as const) {
            const result = harness(overrides);
            expect(result.outcome).toEqual(expected);
            expect(result.navigate).not.toHaveBeenCalled();
            expect(result.writeAttachmentSeeds).not.toHaveBeenCalled();
        }
    });
});
