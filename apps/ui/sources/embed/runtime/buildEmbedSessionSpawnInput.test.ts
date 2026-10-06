import { describe, expect, it } from 'vitest';
import {
    AccountApiTokenSelfV1Schema,
    SessionCreationKeyV1Schema,
    type AccountApiTokenSelfV1,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';

import type { EmbeddedNewSessionDraft } from '@/components/sessions/shell/embedded/embeddedSessionTarget';
import { buildEmbedSessionSpawnInput } from './buildEmbedSessionSpawnInput';

const agentTargetKey = 'agent:happier.agent.claude/claude';
const allowedModel: ProviderBoundModelRef = { agentTargetKey, providerConnectionId: null, modelId: 'allowed-model' };
const endpointUrl = 'https://home.example';

function createSelf(): AccountApiTokenSelfV1 {
    return AccountApiTokenSelfV1Schema.parse({
        accountId: 'account', accountEncryptionMode: 'plain',
        credentialId: '00000000-0000-4000-8000-000000000001', parentTokenId: null, expiresAt: null,
        grant: {
            v: 1, actions: { families: [], ids: ['session.spawn_new'] },
            targets: { sessions: [], machines: ['bound-machine'] }, approve: false, origins: [],
            models: [allowedModel], permissionModes: ['acceptEdits'],
            create: { machineId: 'bound-machine', agentTargetKey, directory: 'managed', placement: { folderId: 'folder', tagIds: ['tag'] } },
        },
        embedConfig: { v: 1, ui: { attachments: true }, newChat: { enabled: true }, organization: { folderId: 'folder', tagIds: ['tag'] }, style: null },
    });
}

function createDraft(): EmbeddedNewSessionDraft {
    return {
        creationKey: SessionCreationKeyV1Schema.parse('draft-identity'),
        executionTarget: { serverId: 'other-server', machineId: 'other-machine' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        directory: { kind: 'path', path: '/private/workspace' },
        organizationPlacement: { folderId: 'other-folder', tagIds: [] },
        modelSelection: { v: 1, ref: { ...allowedModel, modelId: 'disallowed-model' }, updatedAt: 17 },
        permissionMode: 'yolo',
        initialInput: { text: 'secret first message' },
        environmentVariables: { SECRET: 'secret environment' },
        profileId: 'private-profile', roleId: 'private-role', title: 'private title',
    };
}

describe('buildEmbedSessionSpawnInput', () => {
    it('binds creation to the admitted grant and coerces disallowed choices without relaying draft content or host facts', () => {
        const input = { draft: createDraft(), attemptId: 'launch-attempt', self: createSelf(), endpointUrl };
        const spawn = buildEmbedSessionSpawnInput(input);
        expect(spawn).toEqual({
            creationKey: 'launch-attempt', executionTarget: { serverId: endpointUrl, machineId: 'bound-machine' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            directory: { kind: 'managed' }, organizationPlacement: { folderId: 'folder', tagIds: ['tag'] },
            modelSelection: { v: 1, ref: allowedModel, updatedAt: 17 }, permissionMode: 'safe-yolo',
        });
        expect(buildEmbedSessionSpawnInput(input)).toEqual(spawn);
    });

    it('preserves granted selections and maps permission aliases through the canonical intent owner', () => {
        const draft = { ...createDraft(), modelSelection: { v: 1 as const, ref: allowedModel, updatedAt: 23 }, permissionMode: 'safe-yolo' as const };
        const spawn = buildEmbedSessionSpawnInput({ draft, attemptId: 'launch-attempt', self: createSelf(), endpointUrl });
        expect(spawn.modelSelection).toEqual(draft.modelSelection);
        expect(spawn.permissionMode).toBe('safe-yolo');
        const missingSelections = { ...createDraft(), modelSelection: undefined, permissionMode: undefined };
        const selected = buildEmbedSessionSpawnInput({ draft: missingSelections, attemptId: 'launch-attempt', self: createSelf(), endpointUrl });
        expect(selected.modelSelection).toEqual({ v: 1, ref: allowedModel, updatedAt: 0 });
        const self = createSelf();
        self.grant.models = null;
        self.grant.permissionModes = null;
        const unrestricted = buildEmbedSessionSpawnInput({ draft: missingSelections, attemptId: 'launch-attempt', self, endpointUrl });
        expect(unrestricted.modelSelection).toBeUndefined();
        expect(unrestricted.permissionMode).toBe('default');
    });

    it('fails with typed create_not_granted when creation, presentation or canonical action admission refuses the spawn', () => {
        const self = createSelf();
        const denied = [
            { ...self, grant: { ...self.grant, create: null } },
            { ...self, embedConfig: { ...self.embedConfig!, newChat: { enabled: false } } },
            { ...self, grant: { ...self.grant, actions: { families: [], ids: ['session.message.send'] } } },
            { ...self, grant: { ...self.grant, create: { ...self.grant.create!, agentTargetKey: 'backend:claude' } } },
        ];
        for (const value of denied) {
            expect(() => buildEmbedSessionSpawnInput({ draft: createDraft(), attemptId: 'launch-attempt', self: AccountApiTokenSelfV1Schema.parse(value), endpointUrl })).toThrowError(expect.objectContaining({ code: 'create_not_granted' }));
        }
    });

    it('does not silently normalize the attempt identity into a different creation key', () => {
        expect(() => buildEmbedSessionSpawnInput({ draft: createDraft(), attemptId: ' launch-attempt ', self: createSelf(), endpointUrl })).toThrowError(expect.objectContaining({ code: 'create_not_granted' }));
    });
});
