import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginUiNewSessionSeedV1Schema } from '@happier-dev/protocol/plugins/ui';
import { ComposerAttachmentAuthorValueV1Schema, MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
    readNewSessionDraftFromRepository,
    writeNewSessionAuthoringDraftToRepository,
} from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import {
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { readPluginNewSessionSeedV1, seedAndOpenNewSession } from './newSessionSeedComposer';
import { clearAllNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts } from './attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from './attachments/newSessionDraftAttachmentFlowId';
import { projectAttachmentDraftToAgentInputRowItem } from '@/components/sessions/attachments/attachmentDraftPresentation';
import { readAgentInputImageNumbers } from '@/components/sessions/agentInput/agentInputContracts';
import { readAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createNewSessionComposerDocumentOwner } from '@/components/sessions/composer/newSessionComposerDocumentOwner';
import { composerReferencesFromStructuredMentions } from '@/components/sessions/composer/composerScopeAdapters';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const draftId = '00000000-0000-4000-8000-000000000042';

afterEach(() => { resetSessionDraftRepositoryForTests(); clearAllNewSessionAttachmentDrafts(); resetRuntimeFetch(); });

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
    it('keeps placement-only seeds (Machine, branch worktree, Project) off the Account until the person writes', async () => {
        const { configureSessionDraftRepository, flushSessionDraft, listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftPrivatePayloadV2 } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
        // The Account draft endpoint is the network boundary; every remote draft write reaches `mutate`.
        const remoteWrites: string[] = [];
        configureSessionDraftRepository({
            scope, syncEnabled: true,
            cipher: {
                seal: async (address, document) => ({ t: 'plain' as const, v: createSessionDraftPrivatePayloadV2(address, document) }),
                open: async (_address, content) => content.t === 'plain' ? content.v.document : null,
            },
            transport: {
                read: async () => ({ status: 'absent' as const }),
                list: async () => ({ items: [], nextAfter: undefined }),
                mutate: async ({ address, content }) => {
                    remoteWrites.push(address.kind === 'newSession' ? address.draftId : address.kind);
                    return { status: 'updated' as const, record: { address, revision: 0, content, createdAt: 1, updatedAt: 1 } };
                },
            },
        });
        try {
            const seeds = [
                { placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'machine-1' } },
                { placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'machine-1', directory: '/repo' }, checkoutIntent: 'createWorktree' },
                { placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'machine-1', directory: '/repo' } },
            ] as const;
            const opened: string[] = [];
            let next = 0;
            for (const seed of seeds) {
                const outcome = seedAndOpenNewSession({ seed, scope, isCurrent: () => true,
                    createDraftId: () => `00000000-0000-4000-8000-00000000010${next++}`, navigateToNewSession: () => {} });
                if (outcome.kind !== 'opened') throw new Error(JSON.stringify(outcome));
                opened.push(outcome.draftId);
            }
            await Promise.all(opened.map(id => flushSessionDraft({ scope, address: { kind: 'newSession', draftId: id } })));
            expect({ remoteWrites: remoteWrites.length, listed: listNewSessionDraftProjections(scope).length }).toEqual({ remoteWrites: 0, listed: 0 });
            // The opened New Session still starts on the chosen Machine and folder.
            expect(readNewSessionDraftFromRepository({ scope, draftId: opened[2]! })).toMatchObject({
                selectedMachineId: 'machine-1', selectedPath: '/repo' });

            const owner = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', instanceId: opened[0]! } });
            owner.replaceDocument({ ...owner.read().document, text: 'Start on this Machine' });
            await flushSessionDraft({ scope, address: { kind: 'newSession', draftId: opened[0]! } });
            expect({ remoteWrites, listed: listNewSessionDraftProjections(scope).length }).toEqual({ remoteWrites: [opened[0]], listed: 1 });
            expect(readNewSessionDraftFromRepository({ scope, draftId: opened[0]! })).toMatchObject({ selectedMachineId: 'machine-1' });
        } finally { configureSessionDraftRepository({ syncEnabled: false }); }
    });

    it('opens a capture-only draft without manufacturing a prompt', () => {
        const navigate = vi.fn();
        const outcome = seedAndOpenNewSession({ seed: {}, media: { items: [{ kind: 'image', source: {
            kind: 'memory', bytes: decodeBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT0sAAAAASUVORK5CYII='),
            name: 'capture.png', mimeType: 'image/png',
        } }] }, scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: navigate });
        expect(outcome).toEqual({ kind: 'opened', dataId: null, draftId });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toMatch(/^\[capture.png\]/);
        expect(readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId), scope)).toHaveLength(1);
        expect(navigate).toHaveBeenCalledOnce();
    });

    it('admits prepared captures and notes before navigation into the canonical draft without uploading', () => {
        const network = vi.fn(async () => { throw new Error('Unexpected upload while seeding'); });
        setRuntimeFetch(network);
        const image = (name: string) => ({ kind: 'image' as const, source: { kind: 'memory' as const,
            name, mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) } });
        const navigate = vi.fn(() => ({ draft: readNewSessionDraftFromRepository({ scope, draftId }),
            media: readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId), scope) }));
        const outcome = seedAndOpenNewSession({ seed: { prompt: 'Compare the totals' },
            media: { items: [image('first.png'), image('second.png')], note: 'Check this clipping',
                windowText: { name: 'Window text.txt', text: 'Terminal contents' } },
            scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: navigate });
        expect(outcome).toEqual({ kind: 'opened', dataId: null, draftId });
        const navigationResult = navigate.mock.results[0];
        const handedOff = navigationResult?.type === 'return' ? navigationResult.value : undefined;
        const draft = handedOff?.draft;
        const media = handedOff?.media ?? [];
        expect(media).toHaveLength(3);
        expect(draft?.input).toMatch(/^Compare the totals\n\n\[first.png\]/);
        expect(draft?.input.endsWith('Check this clipping')).toBe(true);
        expect(draft?.input).not.toContain('Terminal contents');
        const document = createNewSessionComposerDocumentOwner({ scope,
            ref: { kind: 'newSession', instanceId: draftId } }).read().document;
        const references = composerReferencesFromStructuredMentions({ text: document.text, mentions: document.structuredInputMentions });
        expect(references).toHaveLength(2);
        for (const reference of references) {
            expect(document.text.slice(reference.start, reference.end)).toBe(reference.token);
        }
        const numbers = readAgentInputImageNumbers(media.map(projectAttachmentDraftToAgentInputRowItem));
        expect(media.map(item => numbers.get(item.id) ?? null)).toEqual([1, 2, null]);
        expect(media.every(item => item.status === 'pending' && !item.uploadedPath)).toBe(true);
        expect(media[0]?.source).toMatchObject({ kind: 'memory', previewUri: expect.stringContaining('data:image/png;base64,') });
        expect(network).not.toHaveBeenCalled();
    });

    it('refuses an oversized capture before creating a draft or mutating its media store', () => {
        const navigate = vi.fn();
        const outcome = seedAndOpenNewSession({ seed: { prompt: 'Look at this capture' },
            media: { items: [{ kind: 'image', source: { kind: 'native', uri: 'file:///capture.png',
                name: 'capture.png', mimeType: 'image/png', sizeBytes: readAttachmentsUploadConfig().maxFileBytes + 1 } }] },
            scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: navigate });
        expect(outcome).toEqual({ kind: 'invalid', reason: 'seed_invalid' });
        expect(navigate).not.toHaveBeenCalled();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toBeNull();
        expect(readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId), scope)).toEqual([]);
    });

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

    it('preserves an explicit Agent through the public seed and durable authoring draft', () => {
        const agentTarget = { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } } as const;
        const { outcome, navigate } = harness({ seed: { agentTarget } });
        expect(outcome.kind).toBe('opened');
        expect(navigate.mock.results[0]?.value).toMatchObject({ agentTarget });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ agentTarget });
        // An Agent choice alone is opener context: it is not kept across a restart until the person writes.
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toBeNull();
        expect(readPluginNewSessionSeedV1({ agentTarget: { ...agentTarget, targetKey: 'untrusted' } })).toBeNull();
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

    it('accepts the same typed current-screen context from the authoring Action without plugin caller authority', () => {
        const currentUiContext = { navigation: { area: 'sessions', screen: 'sessions', title: 'Sessions' }, commands: [] };
        const { outcome } = harness({ seed: { currentUiContext }, pluginId: undefined });
        expect(outcome.kind).toBe('opened');
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            input: '',
            composerAttachmentSeeds: [{
                pluginId: 'happier.app-context', attachmentLocalId: 'current-screen',
                value: { value: currentUiContext, presentation: { label: 'Sessions' } },
            }],
        });
        expect(readPluginNewSessionSeedV1({ currentUiContext: { ...currentUiContext, execute: true } })).toBeNull();
    });

    it('keeps a long screen title admissible through the attachment boundary without truncating its snapshot', () => {
        const titlePrefix = '界'.repeat(MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 - 1);
        const currentUiContext = { navigation: { area: 'sessions', screen: 'sessions', title: `${titlePrefix} details` }, commands: [] };
        expect(harness({ seed: { currentUiContext }, pluginId: undefined }).outcome.kind).toBe('opened');
        const request = readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds?.[0];
        expect(request?.value.value).toEqual(currentUiContext);
        expect(ComposerAttachmentAuthorValueV1Schema.safeParse(request?.value).success).toBe(true);
    });

    it('refuses retired Zen provenance from plugin input', () => {
        const zenTaskSource = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix the task' } as const;
        const rejected = harness({ seed: { prompt: 'Work on this task', zenTaskSource } });
        expect(rejected.outcome).toEqual({ kind: 'invalid', reason: 'seed_invalid' });
        expect(rejected.navigate).not.toHaveBeenCalled();
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toBeNull();
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
