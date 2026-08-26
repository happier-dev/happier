import { describe, expect, it, vi } from 'vitest';

const storeTempDataSpy = vi.hoisted(() => vi.fn(() => 'seed-handoff'));

vi.mock('@/components/sessions/composer/newSessionDraftRepositoryAdapter', () => ({
    writeNewSessionDraftToRepository: vi.fn(),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: storeTempDataSpy,
}));

import { readPluginNewSessionSeedV1, seedAndOpenNewSession } from './newSessionSeedComposer';

describe('readPluginNewSessionSeedV1', () => {
    it('admits a declared seed and refuses one carrying an unknown member', () => {
        expect(readPluginNewSessionSeedV1({
            prompt: { text: 'Repair the failing check', mode: 'replace' },
            placement: { directory: '/workspace' },
        })).toMatchObject({ prompt: { text: 'Repair the failing check', mode: 'replace' } });

        expect(readPluginNewSessionSeedV1({ arbitrary: true })).toBeNull();
        // Composer attachments ARE seedable, as the author half only — the same
        // `{ attachmentLocalId, value }` a live `attachment.add` carries. The
        // record they become is minted at the composer's own mount.
        expect(readPluginNewSessionSeedV1({
            attachments: [{
                attachmentLocalId: 'entry',
                value: { key: 'k', value: { v: 1 }, presentation: { label: 'PR #42' } },
            }],
        })).toMatchObject({ attachments: [{ attachmentLocalId: 'entry' }] });
        // An EMPTY attachment list is still refused: it declares an intent the
        // seed cannot carry out and would open a screen with nothing on it.
        expect(readPluginNewSessionSeedV1({ attachments: [] })).toBeNull();
        // Staged media stays out: its handle is bound to an execution target
        // the seed has not chosen yet.
        expect(readPluginNewSessionSeedV1({
            attachments: [{
                attachmentLocalId: 'entry',
                value: { key: 'k', value: { v: 1 }, presentation: { label: 'PR #42' } },
                content: { kind: 'stagedMedia' },
            }],
        })).toBeNull();
        expect(readPluginNewSessionSeedV1({ prompt: { text: 'x' } })).toBeNull();
        expect(readPluginNewSessionSeedV1(undefined)).toBeNull();

        // An ambiguous placement is not a malformed seed. It must stay in the
        // New Session owner's hands until the reader chooses one, rather than
        // quietly becoming an unplaced generic draft.
        expect(readPluginNewSessionSeedV1({
            candidates: [{
                projectKey: { id: 'project-api' },
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/worktrees/api',
                label: 'API',
                reachable: true,
                worktrees: [{ path: '/worktrees/api', branch: 'main', isMain: true, isCurrent: true }],
            }],
        })).toMatchObject({
            candidates: [{
                projectKey: { id: 'project-api' },
                machineId: 'machine-a',
                rootPath: '/worktrees/api',
            }],
        });
    });
});

describe('seedAndOpenNewSession', () => {
    function harness(overrides: Partial<Parameters<typeof seedAndOpenNewSession>[0]> = {}) {
        const writeDraft = vi.fn();
        const navigate = vi.fn();
        const outcome = seedAndOpenNewSession({
            seed: { prompt: { text: 'Repair the failing check', mode: 'replace' }, placement: { directory: '/work' } },
            scope: { serverId: 'server-a', accountId: 'account-a' },
            isCurrent: () => true,
            navigateToNewSession: navigate,
            createDraftId: () => '00000000-0000-4000-8000-000000000042',
            nowMs: () => 5,
            writeDraft,
            ...overrides,
        });
        return { outcome, writeDraft, navigate };
    }

    it('writes ordinary draft fields through the incumbent draft and hands unresolved input to New Session once', () => {
        storeTempDataSpy.mockClear();
        const { outcome, writeDraft, navigate } = harness();

        expect(outcome).toEqual({ kind: 'seeded' });
        expect(writeDraft).toHaveBeenCalledWith({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            draftId: '00000000-0000-4000-8000-000000000042',
            draft: expect.objectContaining({
                input: 'Repair the failing check',
                entryIntent: 'session',
                selectedPath: '/work',
            }),
        });
        expect(storeTempDataSpy).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith({
            dataId: null,
            draftId: '00000000-0000-4000-8000-000000000042',
        });
    });

    it('opens the incumbent worktree picker for checkout intents without fabricating a checkout draft', () => {
        for (const checkoutIntent of ['createWorktree', 'ask'] as const) {
            const { outcome, writeDraft, navigate } = harness({ seed: { checkoutIntent } });

            expect(outcome, checkoutIntent).toEqual({ kind: 'seeded' });
            expect(writeDraft, checkoutIntent).toHaveBeenCalledWith({
                scope: { serverId: 'server-a', accountId: 'account-a' },
                draftId: '00000000-0000-4000-8000-000000000042',
                draft: expect.objectContaining({ entryIntent: 'session' }),
            });
            // A concrete checkout draft needs a user-selected worktree name
            // and base ref. A profile only answers which question to ask, so
            // this seam must send the reader to the existing picker instead.
            expect(writeDraft.mock.calls[0]?.[0].draft, checkoutIntent)
                .not.toHaveProperty('checkoutCreationDraft');
            expect(navigate, checkoutIntent).toHaveBeenCalledWith({
                dataId: null,
                draftId: '00000000-0000-4000-8000-000000000042',
                worktree: 'new',
            });
        }
    });

    it('keeps already-settled checkout intents on the ordinary New Session route', () => {
        for (const checkoutIntent of ['none', 'reuseWorkspace'] as const) {
            const { outcome, navigate } = harness({ seed: { checkoutIntent } });

            expect(outcome, checkoutIntent).toEqual({ kind: 'seeded' });
            expect(navigate, checkoutIntent).toHaveBeenCalledWith({
                dataId: null,
                draftId: '00000000-0000-4000-8000-000000000042',
            });
        }
    });

    it('refuses an unmaterialized prepared review workspace before writing or navigating', () => {
        storeTempDataSpy.mockClear();
        const { outcome, writeDraft, navigate } = harness({
            seed: { checkoutIntent: 'preparedReviewWorkspace' },
        });

        expect(outcome).toEqual({
            kind: 'unavailable',
            reason: 'prepared_review_workspace_unavailable',
        });
        expect(writeDraft).not.toHaveBeenCalled();
        expect(storeTempDataSpy).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('never navigates when the seed is invalid, empty, aborted or the surface is gone', () => {
        for (const [reasonLabel, overrides, expected] of [
            ['invalid', { seed: { arbitrary: true } }, { kind: 'invalid', reason: 'seed_invalid' }],
            ['empty', { seed: {} }, { kind: 'invalid', reason: 'seed_empty' }],
            ['aborted', { signal: AbortSignal.abort() }, { kind: 'unavailable', reason: 'aborted' }],
            ['retired', { isCurrent: () => false }, { kind: 'stale', reason: 'host_retired' }],
        ] as const) {
            const { outcome, writeDraft, navigate } = harness(overrides);
            expect(outcome, reasonLabel).toEqual(expected);
            expect(writeDraft, reasonLabel).not.toHaveBeenCalled();
            expect(navigate, reasonLabel).not.toHaveBeenCalled();
        }
    });

    it('hands author-shaped attachments to the mounted New Session composer instead of persisting them as records', () => {
        storeTempDataSpy.mockClear();
        const { outcome } = harness({
            pluginId: 'happier.triage',
            seed: {
                attachments: [{
                    attachmentLocalId: 'entry',
                    value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
                }],
            },
        });

        expect(outcome).toEqual({ kind: 'seeded', dataId: 'seed-handoff' });
        expect(storeTempDataSpy).toHaveBeenCalledWith({
            pluginNewSessionSeed: {
                attachments: [{
                    pluginId: 'happier.triage',
                    attachmentLocalId: 'entry',
                    value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
                }],
            },
        });
    });

    it('hands ambiguous placement candidates to the mounted New Session owner without selecting one', () => {
        storeTempDataSpy.mockClear();
        const { outcome } = harness({
            seed: {
                candidates: [{
                    projectKey: { id: 'project-api' },
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/worktrees/api',
                    reachable: true,
                    worktrees: [],
                }, {
                    projectKey: { id: 'project-web' },
                    serverId: 'server-b',
                    machineId: 'machine-b',
                    rootPath: '/worktrees/web',
                    reachable: true,
                    worktrees: [],
                }],
            },
        });

        expect(outcome).toEqual({ kind: 'seeded', dataId: 'seed-handoff' });
        expect(storeTempDataSpy).toHaveBeenCalledWith({
            pluginNewSessionSeed: {
                placementCandidates: [
                expect.objectContaining({ machineId: 'machine-a', rootPath: '/worktrees/api' }),
                expect.objectContaining({ machineId: 'machine-b', rootPath: '/worktrees/web' }),
            ],
            },
        });
    });

    it('refuses attachments no caller is credited for instead of opening a screen without them', () => {
        storeTempDataSpy.mockClear();
        const { outcome, writeDraft, navigate } = harness({
            seed: {
                attachments: [{
                    attachmentLocalId: 'entry',
                    value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
                }],
            },
        });

        expect(outcome).toEqual({ kind: 'invalid', reason: 'seed_attachments_uncredited' });
        expect(writeDraft).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(storeTempDataSpy).not.toHaveBeenCalled();
    });

    it('reports a navigation that did not happen rather than claiming the screen opened', () => {
        const { outcome, writeDraft } = harness({
            navigateToNewSession: () => { throw new Error('router unavailable'); },
        });

        expect(outcome).toEqual({ kind: 'unavailable', reason: 'navigation_unavailable' });
        // The seed is already durable, so the reader can still reach it.
        expect(writeDraft).toHaveBeenCalledTimes(1);
    });
});
