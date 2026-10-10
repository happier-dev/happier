import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginUiNewSessionSeedV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
    readNewSessionDraftFromRepository,
    writeNewSessionAuthoringDraftToRepository,
} from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import {
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { readPluginNewSessionSeedV1, seedAndOpenNewSession } from './newSessionSeedComposer';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const draftId = '00000000-0000-4000-8000-000000000042';

afterEach(() => resetSessionDraftRepositoryForTests());

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
        const navigate = vi.fn(() => readNewSessionDraftFromRepository({ scope, draftId }));
        const outcome = seedAndOpenNewSession({
            seed: {
                prompt: 'Repair the failing check',
                placement: { kind: 'currentTarget', directory: '/work' },
            },
            pluginId: 'happier.triage',
            scope,
            isCurrent: () => true,
            navigateToNewSession: navigate,
            createDraftId: () => draftId,
            ...overrides,
        });
        return { outcome, navigate };
    }

    it('opens a blank Bot draft with creation facts and preserves its edited name on reopen', () => {
        const initialSessionFacts = { bot: { kind: 'bot' }, createdAsBot: true } as const;
        const { outcome } = harness({ seed: { sessionName: 'Happier', initialSessionFacts } });
        expect(outcome.kind).toBe('opened');
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({ input: '', sessionName: 'Happier', initialSessionFacts });
        if (!recovered) throw new Error('Expected the editable Bot draft');
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...recovered, sessionName: 'My helper' } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ sessionName: 'My helper', initialSessionFacts });
    });

    it('admits empty automatic names without persisting the New bot placeholder', () => {
        const { outcome } = harness({ seed: { sessionName: '', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true } } });
        expect(outcome.kind).toBe('opened');
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.sessionName).toBe('');
        expect(readPluginNewSessionSeedV1({ initialSessionFacts: { bot: { kind: 'bot', extra: true } } })).toBeNull();
    });

    it('opens the same ordinary Bot draft with qualified selected Instructions and no hidden inline carrier', () => {
        const promptStack = [{ id: 'session.instructions',
            ref: { kind: 'doc', serverId: 'guide-home', artifactId: 'happier-guide' },
            enabled: true, required: true, placement: 'system_append' }] as const;
        const { outcome, navigate } = harness({ seed: {
            sessionName: 'Happier', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true }, promptStack,
        } });
        expect(outcome.kind).toBe('opened');
        expect(navigate.mock.results[0]?.value).toMatchObject({ input: '', sessionName: 'Happier', promptStack });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ promptStack });
        expect(readPluginNewSessionSeedV1({ promptStack: [{ ...promptStack[0], instructions: 'inline fallback' }] })).toBeNull();
    });

    it('persists the complete fresh seed before navigating by draft identity', () => {
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

        expect(outcome).toEqual({ kind: 'opened', dataId: null, draftId: '00000000-0000-4000-8000-000000000042' });
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({
            input: 'Repair the failing check',
            selectedProfileId: 'profile-review',
            selectedMachineId: 'machine-a',
            targetServerId: 'server-a',
            selectedPath: '/work',
            executionTarget: { kind: 'machine', target: { serverId: 'server-a', machineId: 'machine-a' } },
        });
        expect(navigate).toHaveBeenCalledWith({
            dataId: null,
            draftId: '00000000-0000-4000-8000-000000000042',
        });
        expect(navigate.mock.results[0]?.value).toMatchObject({
            input: 'Repair the failing check',
            selectedProfileId: 'profile-review',
            selectedPath: '/work',
        });
        if (!recovered) throw new Error('Expected the opened durable draft');
        writeNewSessionAuthoringDraftToRepository({
            scope,
            draftId,
            draft: { ...recovered, selectedPath: '/edited', selectedProfileId: 'profile-edited' },
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: 'Repair the failing check',
            selectedPath: '/edited',
            selectedProfileId: 'profile-edited',
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
        const retainedDraft = readNewSessionDraftFromRepository({ scope, draftId });
        const refused = harness({ seed: { checkoutIntent: 'preparedReviewWorkspace' } });
        expect(refused.outcome).toEqual({
            kind: 'unavailable',
            reason: 'prepared_review_workspace_unavailable',
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toEqual(retainedDraft);
        expect(refused.navigate).not.toHaveBeenCalled();
    });

    it('stores attachment requests in the draft-local handoff owner', () => {
        const attachment = {
            attachmentLocalId: 'entry',
            value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
        } as const;
        const { outcome } = harness({ seed: PluginUiNewSessionSeedV1Schema.parse({ attachments: [attachment] }) });

        expect(outcome).toEqual({ kind: 'opened', dataId: null, draftId: '00000000-0000-4000-8000-000000000042' });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            composerAttachmentSeeds: [expect.objectContaining({
                instanceId: expect.any(String),
                pluginId: 'happier.triage',
                attachmentLocalId: attachment.attachmentLocalId,
                value: attachment.value,
            })],
        });
        const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        expect(snapshot?.document).toMatchObject({ composer: { attachments: { value: [] } } });
    });

    it('carries a host-admitted Zen source through reopening and target edits without admitting it from plugin input', () => {
        const zenTaskSource = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix the task' } as const;
        const rejected = harness({
            seed: { prompt: 'Work on this task', zenTaskSource },
        });
        expect(rejected.outcome).toEqual({ kind: 'invalid', reason: 'seed_invalid' });
        expect(rejected.navigate).not.toHaveBeenCalled();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toBeNull();

        const opened = harness({
            seed: { prompt: 'Work on this task' },
            zenTaskSource,
        });
        expect(opened.outcome).toEqual({ kind: 'opened', dataId: null, draftId });
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({ input: 'Work on this task', zenTaskSource });
        if (!recovered) throw new Error('Expected the host-admitted task draft');
        writeNewSessionAuthoringDraftToRepository({
            scope,
            draftId,
            draft: { ...recovered, selectedPath: '/edited', selectedProfileId: 'profile-edited' },
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: 'Work on this task',
            selectedPath: '/edited',
            selectedProfileId: 'profile-edited',
            zenTaskSource,
        });
        expect(JSON.stringify(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document))
            .not.toContain('zen_task');
    });

    it('keeps the one durable draft and its pending attachment custody recoverable on navigation refusal', () => {
        const seed = {
            attachments: [{
                attachmentLocalId: 'entry',
                value: { key: 'entry:42', value: { v: 1 }, presentation: { label: 'PR #42' } },
            }],
        } as const;
        const refused = harness({
            seed: PluginUiNewSessionSeedV1Schema.parse(seed),
            navigateToNewSession: () => { throw new Error('router unavailable'); },
        });
        expect(refused.outcome).toEqual({ kind: 'unavailable', reason: 'navigation_unavailable' });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            composerAttachmentSeeds: [expect.objectContaining({
                pluginId: 'happier.triage',
                attachmentLocalId: 'entry',
                value: seed.attachments[0].value,
            })],
        });
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
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toBeNull();
        }
    });
});
