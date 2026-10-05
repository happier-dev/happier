import { buildNewSessionAuthoringDraftFromPersistedDraft, buildNewSessionAuthoringDraftFromTempData, buildNewSessionTempDataFromAuthoringDraft, buildPersistedNewSessionDraftFromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { afterEach, describe, expect, it } from 'vitest';
import { seedNewSessionDraftV1 } from '@/components/sessions/new/newSessionDraftSeed';

import { SessionInitialTriggerV1Schema, type ComposerAttachmentDraftV1 } from '@happier-dev/protocol';
import type {
    NewSessionComposerAttachmentSeedV1,
    NewSessionDraft,
} from '@/sync/domains/state/persistence';
import {
    getSessionDraftSnapshot,
    resetSessionDraftRepositoryForTests,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import {
    readNewSessionDraftFromRepository,
    readNewSessionDraftProjectionFromRepository,
    clearNewSessionComposerAttachmentSeedsFromRepository,
    hasNewSessionDraftAccessConflict,
    hasNewSessionDraftPrimaryTeamConflict,
    writeTemporaryComputerActivationRefToRepository,
    writeNewSessionAuthoringDraftToRepository,
    writeNewSessionDraftToRepository,
} from './newSessionDraftRepositoryAdapter';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const attachment: ComposerAttachmentDraftV1 = {
    v: 1,
    instanceId: 'attachment-a',
    attachment: { pluginId: 'example.plugin', localId: 'ticket' },
    key: 'ticket-a',
    value: { id: 42 },
    presentation: { typeLabel: 'Ticket', label: 'Issue 42' },
};

function authoringDraft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
    return {
        input: 'stale delayed text',
        composerAttachments: [],
        selectedMachineId: 'machine-b',
        selectedPath: '/repo',
        entryIntent: 'session',
        selectedProfileId: null,
        selectedSecretId: null,
        agentType: 'codex',
        permissionMode: 'default',
        acpSessionModeId: null,
        updatedAt: 10,
        ...overrides,
    };
}

afterEach(() => {
    resetSessionDraftRepositoryForTests();
});

/**
 * Temporary-computer authoring lives only in the current catalogued document,
 * so these assertions read it through that exact document version rather than
 * the released V1 vocabulary the same union also carries.
 */
function cataloguedNewSessionAuthoring(
    snapshot: ReturnType<typeof getSessionDraftSnapshot>,
) {
    const document = snapshot?.document;
    if (document?.v !== 2 || document.target.kind !== 'newSession') return undefined;
    return document.target.authoring;
}

describe('newSessionDraftRepositoryAdapter', () => {
    it('persists initial triggers in the canonical authoring document and clears them without changing composer text', () => {
        const draftId = 'birth-triggers';
        const initialTriggers = SessionInitialTriggerV1Schema.array().parse([{
            trigger: { kind: 'sessionLifecycle', enabled: true, events: ['sessionStarted'], policy: { kind: 'firstMatch' } },
            target: { kind: 'workflow', ref: 'builtin:review-and-converge' },
            executionTarget: { kind: 'session' }, inputs: { maxRounds: 3 },
            visibleTeamId: null,
        }]);
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Live prompt', initialTriggers }) });
        expect(cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }))?.initialTriggers?.value)
            .toEqual(initialTriggers);
        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered?.initialTriggers).toEqual(initialTriggers);
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Stale autosave', initialTriggers: [] }) });
        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ input: 'Live prompt', initialTriggers: [] });
    });
    it('keeps an explicit placement-only seed without keeping ordinary empty authoring edits', () => {
        writeNewSessionDraftToRepository({
            scope,
            draftId: 'ordinary-empty-edit',
            draft: authoringDraft({ input: '' }),
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId: 'ordinary-empty-edit' })).toBeNull();

        const draftId = seedNewSessionDraftV1({
            scope,
            createDraftId: () => 'placement-only-seed',
            seed: { placement: { kind: 'exactTarget', serverId: 'server-b', machineId: 'machine-b' } },
        });
        expect(draftId).toBe('placement-only-seed');
        expect(readNewSessionDraftFromRepository({ scope, draftId: draftId! })).toMatchObject({
            input: '',
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'machine-b' } },
        });
    });

    it('keeps the Zen source in the local draft through seed, reload and ordinary authoring edits', () => {
        const zenTaskSource = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix the task' } as const;
        const draftId = seedNewSessionDraftV1({
            scope,
            createDraftId: () => 'zen-task-draft',
            seed: { prompt: { text: 'Work on this task', mode: 'replace' }, ...{ zenTaskSource } },
        });
        expect(draftId).toBe('zen-task-draft');
        const reloaded = readNewSessionDraftFromRepository({ scope, draftId: draftId! });
        expect(reloaded).toMatchObject({ zenTaskSource, input: 'Work on this task' });
        writeNewSessionAuthoringDraftToRepository({
            scope, draftId: draftId!, draft: { ...reloaded!, selectedPath: '/changed' },
        });
        expect(readNewSessionDraftFromRepository({ scope, draftId: draftId! })).toMatchObject({ zenTaskSource });
        const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: draftId! });
        expect(snapshot?.localSupplement.newSessionLocalState).toMatchObject({ zenTaskSource });
        expect(JSON.stringify(snapshot?.document)).not.toContain('zen_task');
        expect(readNewSessionDraftFromRepository({ scope: { ...scope, accountId: 'other' }, draftId: draftId! })).toBeNull();
    });
    it('writes and clears only the Temporary computer activation reference', () => {
        const draftId = 'temporary-computer-reference-only';
        const executionTarget = {
            kind: 'temporary_computer',
            serverId: 'server-a',
            artifactTarget: 'linux-x64',
            workspace: { kind: 'choose_on_endpoint' },
        } as const;
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'newer composer text',
                authoring: { executionTarget, directory: '/newer/path' },
            },
            materializationIntent: 'userEdit',
        });
        const before = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        const reference = {
            v: 1,
            activationId: '1d79cf10-cabc-4132-a8b8-bafaa7d60b2e',
            createdOnDeviceLabel: 'Creating device',
        } as const;

        writeTemporaryComputerActivationRefToRepository({ scope, draftId, activationRef: reference });

        const written = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        expect(written?.document.composer.text).toEqual(before?.document.composer.text);
        expect(written?.document.target).toMatchObject({
            authoring: {
                executionTarget: cataloguedNewSessionAuthoring(before)?.executionTarget,
                directory: cataloguedNewSessionAuthoring(before)?.directory,
                temporaryComputerActivationRef: { value: reference },
            },
        });

        writeTemporaryComputerActivationRefToRepository({ scope, draftId, activationRef: null });

        const cleared = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        expect(cleared?.document.composer.text).toEqual(before?.document.composer.text);
        expect(cataloguedNewSessionAuthoring(cleared)?.temporaryComputerActivationRef?.value).toBeNull();
        expect(cataloguedNewSessionAuthoring(cleared)?.executionTarget)
            .toEqual(cataloguedNewSessionAuthoring(before)?.executionTarget);
    });

    it('preserves Temporary computer intent and its activation reference through authoring, reentry and repository edits', () => {
        const draftId = 'temporary-computer-draft';
        const executionTarget = {
            kind: 'temporary_computer',
            serverId: 'server-a',
            artifactTarget: 'darwin-arm64',
            workspace: { kind: 'choose_on_endpoint' },
        } as const;
        const temporaryComputerActivationRef = {
            v: 1,
            activationId: '1d79cf10-cabc-4132-a8b8-bafaa7d60b2e',
            createdOnDeviceLabel: 'My laptop',
        } as const;
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'Keep the reviewed request',
                authoring: {
                    executionTarget,
                    temporaryComputerActivationRef,
                    directory: '/previous-machine-folder',
                },
            },
            materializationIntent: 'userEdit',
        });

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({
            executionTarget,
            temporaryComputerActivationRef,
            selectedMachineId: null,
            targetServerId: 'server-a',
            selectedPath: '/previous-machine-folder',
        });
        if (!recovered) throw new Error('Expected the retained New Session draft');

        const authored = buildNewSessionAuthoringDraftFromPersistedDraft(recovered);
        const reentry = buildNewSessionTempDataFromAuthoringDraft({ draft: authored, machineId: 'stale-machine' });
        expect(reentry.machineId).toBeUndefined();
        const reentered = buildNewSessionAuthoringDraftFromTempData(reentry);
        const persisted = buildPersistedNewSessionDraftFromAuthoringDraft({
            draft: reentered,
            machineId: 'stale-machine',
            targetServerId: 'another-home',
            selectedSecretId: null,
            selectedSecretIdByProfileIdByEnvVarName: null,
            sessionOnlySecretValueEncByProfileIdByEnvVarName: null,
            backendNewSessionOptionStateByTargetKey: null,
            updatedAt: 20,
        });
        expect(persisted).toMatchObject({
            executionTarget,
            temporaryComputerActivationRef,
            selectedMachineId: null,
            targetServerId: 'server-a',
            selectedPath: '/previous-machine-folder',
        });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: persisted });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.target).toMatchObject({
            authoring: {
                executionTarget: { value: executionTarget },
                temporaryComputerActivationRef: { value: temporaryComputerActivationRef },
                directory: { value: '/previous-machine-folder' },
            },
        });
    });

    it('round-trips and explicitly clears initial access in the canonical synchronized authoring document', () => {
        const access = { grants: [{ subject: { kind: 'account' as const, accountId: 'person-b' }, accessLevel: 'edit' as const, canApprovePermissions: true }] };
        const draftId = 'access-draft';
        // A New Session draft exists once it holds content; access then travels with it.
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Share with Person B', access, primaryTeamId: 'team-a' }) });
        const firstSnapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        const projection = readNewSessionDraftProjectionFromRepository({ scope, draftId });
        const recovered = projection?.draft ?? null;
        expect(projection?.revision).toBe(firstSnapshot?.revision);
        expect(recovered?.access).toEqual(access);
        expect(recovered?.primaryTeamId).toBe('team-a');
        const authored = buildNewSessionAuthoringDraftFromPersistedDraft(recovered!);
        expect(authored.access).toEqual(access);
        const temp = buildNewSessionTempDataFromAuthoringDraft({ draft: authored, machineId: 'machine-b' });
        expect(buildNewSessionAuthoringDraftFromTempData(temp).access).toEqual(access);
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.target).toMatchObject({
            authoring: { access: { value: access } },
        });
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: authoringDraft({ access: null, primaryTeamId: null }) });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.access).toBeNull();
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.primaryTeamId).toBeNull();
    });

    it('round-trips every synchronized authoring field the writer persists, including organization placement', () => {
        const draftId = 'organization-placement-draft';
        const organizationPlacement = { folderId: 'folder-a', tagIds: ['tag-a', 'tag-b'] };
        const runtimeDescriptorV1 = { v: 1 as const, agentId: 'codex', agent: { backendMode: 'appServer' } };
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({ organizationPlacement, runtimeDescriptorV1 }),
        });
        const written = cataloguedNewSessionAuthoring(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId }));
        expect(written).toMatchObject({
            organizationPlacement: { value: organizationPlacement },
            runtimeDescriptorV1: { value: runtimeDescriptorV1 },
        });

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered?.organizationPlacement).toEqual(organizationPlacement);
        expect(recovered?.runtimeDescriptorV1).toEqual(runtimeDescriptorV1);

        // Reopening and autosaving the recovered draft must not revert the saved choice to defaults.
        writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: recovered! });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.organizationPlacement).toEqual(organizationPlacement);
    });

    it('projects a clean conflict with per-field access and Team-context presence', () => {
        const draftId = 'conflict-presence';
        const access = { grants: [{ subject: { kind: 'account' as const, accountId: 'person-b' }, accessLevel: 'edit' as const, canApprovePermissions: true }] };
        writeNewSessionDraftToRepository({ scope, draftId, draft: authoringDraft({ input: 'Share with Person B', access, primaryTeamId: 'team-a' }) });
        const clean = readNewSessionDraftProjectionFromRepository({ scope, draftId });
        expect(clean?.conflict).toBeNull();
        expect(hasNewSessionDraftAccessConflict(clean?.conflict)).toBe(false);
        expect(hasNewSessionDraftPrimaryTeamConflict(clean?.conflict)).toBe(false);
        expect(hasNewSessionDraftAccessConflict({ fields: [{
            fieldId: 'target.authoring.access',
            path: { kind: 'authoring', fieldId: 'access' },
            mine: null,
            synced: null,
        }] })).toBe(true);
        expect(hasNewSessionDraftPrimaryTeamConflict({ fields: [{
            fieldId: 'target.authoring.primaryTeamId',
            path: { kind: 'authoring', fieldId: 'primaryTeamId' },
            mine: null,
            synced: null,
        }] })).toBe(true);
        expect(hasNewSessionDraftAccessConflict({ fields: [{
            fieldId: 'target.authoring.primaryTeamId',
            path: { kind: 'authoring', fieldId: 'primaryTeamId' },
            mine: null,
            synced: null,
        }] })).toBe(false);
    });

    it('projects a published 0.2 draft and contracts predecessor fields when a current-only value is written', () => {
        const draftId = 'predecessor-draft';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'Continue on another device',
                // Reader-compatibility fixture: current writers intentionally exclude predecessor keys.
                authoring: {
                    machineId: 'machine-legacy',
                    serverId: 'server-legacy',
                    agentId: 'codex',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    modelId: 'gpt-5',
                    codexBackendMode: 'appServer',
                } as never,
            },
            materializationIntent: 'userEdit',
        });

        const recovered = readNewSessionDraftFromRepository({ scope, draftId });
        expect(recovered).toMatchObject({
            input: 'Continue on another device',
            selectedMachineId: 'machine-legacy',
            targetServerId: 'server-legacy',
            executionTarget: { kind: 'machine', target: { serverId: 'server-legacy', machineId: 'machine-legacy' } },
            agentType: 'codex',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5',
                },
            },
        });

        writeNewSessionDraftToRepository({ scope, draftId, draft: recovered! });
        const current = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document;
        expect(current).toMatchObject({
            v: 2,
            target: {
            kind: 'newSession',
            authoring: {
                executionTarget: {
                    value: {
                        kind: 'machine',
                        target: { serverId: 'server-legacy', machineId: 'machine-legacy' },
                    },
                },
                agentTarget: {
                    value: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                },
            },
            },
        });
        if (current?.target.kind !== 'newSession') throw new Error('expected new-session draft');
        expect(current.target.authoring).not.toHaveProperty('machineId');
        expect(current.target.authoring).not.toHaveProperty('serverId');
        expect(current.target.authoring).not.toHaveProperty('agentId');
        expect(current.target.authoring).not.toHaveProperty('backendTarget');
        expect(current.target.authoring).not.toHaveProperty('modelId');
        expect(current.target.authoring).not.toHaveProperty('codexBackendMode');
    });

    it('persists delayed authoring fields without rewriting the canonical composer document', () => {
        const draftId = 'draft-a';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'live composer text',
                mentions: [{ kind: 'mention', tokenText: '@issue', start: 0, end: 6 }],
                attachments: [attachment],
            },
            materializationIntent: 'userEdit',
        });

        writeNewSessionAuthoringDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft(),
        });

        const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
        expect(snapshot?.document.composer).toMatchObject({
            text: { value: 'live composer text' },
            mentions: { value: [{ kind: 'mention', tokenText: '@issue', start: 0, end: 6 }] },
            attachments: { value: [attachment] },
        });
        expect(snapshot?.document.target).toMatchObject({
            kind: 'newSession',
            authoring: {
                executionTarget: {
                    value: {
                        kind: 'machine',
                        target: { serverId: 'server-a', machineId: 'machine-b' },
                    },
                },
                directory: { value: '/repo' },
                agentTarget: {
                    value: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                },
            },
        });
    });

    it('round-trips the canonical execution and Agent selection through the repository', () => {
        const draftId = 'round-trip-draft';
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({
                executionTarget: {
                    kind: 'machine',
                    target: { serverId: 'server-a', machineId: 'machine-b' },
                    selectionOrigin: {
                        kind: 'machine_pool',
                        poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                    },
                },
            }),
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            selectedMachineId: 'machine-b',
            targetServerId: 'server-a',
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-b' },
                selectionOrigin: {
                    kind: 'machine_pool',
                    poolId: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                },
            },
            agentType: 'codex',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        });
    });

    it('sanitizes incomplete synchronized Automation trigger rows when materializing a local draft', () => {
        const draftId = 'incomplete-automation-draft';
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                authoring: {
                    automation: {
                        enabled: true,
                        name: 'Continue later',
                        description: '',
                        triggers: [{
                            clientId: 'trigger-a',
                            kind: 'sessionLifecycle',
                            persisted: null,
                            enabled: true,
                            definition: null,
                        }],
                    },
                },
            },
            materializationIntent: 'userEdit',
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })?.automationDraft).toMatchObject({
            enabled: true,
            name: 'Continue later',
            triggers: [],
        });
    });

    it('retains the full writer for an initial seed before the composer mounts', () => {
        writeNewSessionDraftToRepository({
            scope,
            draftId: 'seeded-draft',
            draft: authoringDraft({
                input: 'Seeded prompt',
                composerAttachments: [attachment],
            }),
        });

        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: 'seeded-draft' })?.document.composer)
            .toMatchObject({
                text: { value: 'Seeded prompt' },
                attachments: { value: [attachment] },
            });
    });

    it('round-trips device-local launch choices without synchronizing them', () => {
        const draftId = 'local-state-draft';
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({
                entryIntent: 'automation',
                selectedSecretId: 'secret-a',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 12,
                    overrides: { speed: { updatedAt: 12, value: 'fast' } },
                },
                windowsRemoteSessionLaunchModeOverride: {
                    machineId: 'machine-b',
                    mode: 'windows_terminal',
                },
            }),
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
            entryIntent: 'automation',
            selectedSecretId: 'secret-a',
            sessionConfigOptionOverrides: {
                overrides: { speed: { value: 'fast' } },
            },
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-b',
                mode: 'windows_terminal',
            },
        });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })?.document.target)
            .not.toMatchObject({
                authoring: { windowsRemoteSessionLaunchMode: expect.anything() },
            });
    });

    it('round-trips draft-local attachment requests and clears only admitted identities', () => {
        const draftId = 'seed-custody-draft';
        const seed: NewSessionComposerAttachmentSeedV1 = {
            instanceId: 'seed-a',
            pluginId: 'example.plugin',
            attachmentLocalId: 'ticket',
            value: { key: 'ticket-a', value: { id: 42 }, presentation: { label: 'Issue 42' } },
        };
        const otherSeed = { ...seed, instanceId: 'seed-b', value: { ...seed.value, key: 'ticket-b' } };
        writeNewSessionDraftToRepository({
            scope,
            draftId,
            draft: authoringDraft({ composerAttachmentSeeds: [seed, otherSeed] }),
        });

        expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds)
            .toEqual([seed, otherSeed]);
        clearNewSessionComposerAttachmentSeedsFromRepository({ scope, draftId, seeds: [seed] });
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds)
            .toEqual([otherSeed]);
    });
});
