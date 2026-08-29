import { describe, expect, it, vi } from 'vitest';

const seedDraftSpy = vi.hoisted(() => vi.fn(() => '00000000-0000-4000-8000-000000000042'));

import { readPluginNewSessionSeedV1, seedAndOpenNewSession } from './newSessionSeedComposer';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

describe('readPluginNewSessionSeedV1', () => {
    it('admits the dedicated one-shot shape and rejects the retired append/replace prompt shape', () => {
        expect(readPluginNewSessionSeedV1({
            prompt: 'Repair the failing check',
            placement: { kind: 'currentTarget', directory: '/workspace' },
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
        const outcome = seedAndOpenNewSession({
            seed: {
                prompt: 'Repair the failing check',
                placement: { kind: 'currentTarget', directory: '/work' },
            },
            pluginId: 'happier.triage',
            scope,
            isCurrent: () => true,
            navigateToNewSession: navigate,
            createDraftId: () => '00000000-0000-4000-8000-000000000042',
            seedDraft: seedDraftSpy,
            ...overrides,
        });
        return { outcome, navigate };
    }

    it('persists the complete fresh seed before navigating by draft identity', () => {
        seedDraftSpy.mockClear();
        const { outcome, navigate } = harness({
            seed: {
                prompt: 'Repair the failing check',
                profileId: 'profile-review',
                placement: {
                    kind: 'exactTarget',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    directory: '/work',
                },
            },
        });

        expect(outcome).toEqual({ kind: 'opened', dataId: null });
        expect(seedDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope,
            seed: expect.objectContaining({
                prompt: { text: 'Repair the failing check', mode: 'replace' },
                profileId: 'profile-review',
                placement: {
                    kind: 'exactTarget',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    directory: '/work',
                },
            }),
            createDraftId: expect.any(Function),
        }));
        expect(navigate).toHaveBeenCalledWith({
            dataId: null,
            draftId: '00000000-0000-4000-8000-000000000042',
        });
    });

    it('routes incumbent checkout questions and rejects a prepared intent that bypassed mounted materialization', () => {
        for (const checkoutIntent of ['createWorktree', 'ask'] as const) {
            expect(harness({ seed: { checkoutIntent } }).navigate).toHaveBeenCalledWith({
                dataId: null,
                draftId: '00000000-0000-4000-8000-000000000042',
                worktree: 'new',
            });
        }
        seedDraftSpy.mockClear();
        const refused = harness({ seed: { checkoutIntent: 'preparedReviewWorkspace' } });
        expect(refused.outcome).toEqual({
            kind: 'unavailable',
            reason: 'prepared_review_workspace_unavailable',
        });
        expect(seedDraftSpy).not.toHaveBeenCalled();
        expect(refused.navigate).not.toHaveBeenCalled();
    });

    it('stores attachment requests in the draft-local handoff owner', () => {
        seedDraftSpy.mockClear();
        const attachment = {
            attachmentLocalId: 'entry',
            value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
        } as const;
        const { outcome } = harness({ seed: { attachments: [attachment] } });

        expect(outcome).toEqual({ kind: 'opened', dataId: null });
        expect(seedDraftSpy).toHaveBeenCalled();
        expect(seedDraftSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            attachmentSeeds: [expect.objectContaining({
                instanceId: expect.any(String),
                pluginId: 'happier.triage',
                attachmentLocalId: attachment.attachmentLocalId,
                value: attachment.value,
            })],
        }));
    });

    it('keeps the durable draft on navigation refusal while clearing pending attachment custody', () => {
        seedDraftSpy.mockClear();
        const seed = {
            attachments: [{
                attachmentLocalId: 'entry',
                value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
            }],
        } as const;
        const refused = harness({
            seed,
            navigateToNewSession: () => { throw new Error('router unavailable'); },
        });
        expect(refused.outcome).toEqual({ kind: 'unavailable', reason: 'navigation_unavailable' });
        expect(seedDraftSpy).toHaveBeenCalledTimes(1);
        const retry = harness({ seed });
        expect(retry.outcome).toEqual({ kind: 'opened', dataId: null });
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
        }
    });
});
