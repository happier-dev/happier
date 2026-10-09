import { afterEach, describe, expect, it } from 'vitest';
import type { Metadata } from '@happier-dev/session-core/state';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { updateSessionMetadataWithRetry } from '@/sync/domains/session/metadata/updateSessionMetadataWithRetry';
import { persistCreatedSessionAuthoringOrigin } from './newSessionAuthoringOrigin';

afterEach(() => resetSessionDraftRepositoryForTests());

describe('created Session authoring origin', () => {
    it('hands the reopened original destination to the real owner tuple without replacing unrelated work or publishing it to recipients', async () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        const origin = { kind: 'project', accountId: scope.accountId, page: 'changes', comparisonId: 'comparison-a',
            workspace: { serverId: scope.serverId, workspaceId: 'workspace-a', machineId: 'original-machine', rootPath: '/original' } } as const;
        writeNewSessionDraftToRepository({ scope, draftId: 'authoring-send', draft: {
            input: 'Review the changes', selectedMachineId: 'edited-machine', selectedPath: '/edited',
            targetServerId: 'server-b', selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'edited-machine' } },
            authoringOrigin: origin,
        } });
        resetSessionDraftRepositoryForTests();
        const recovered = readNewSessionDraftFromRepository({ scope, draftId: 'authoring-send' });
        if (!recovered?.authoringOrigin) throw new Error('Expected the reopened authoring origin');
        const metadata: Metadata = { path: '/edited', host: 'target-host', machineId: 'edited-machine',
            work: { memoryEnabled: false, viewPreferences: { showToolCalls: true } } };
        const created = createSessionOwnerMetadataV1({ metadata });
        if (!created.ok) throw new Error('Expected admitted Session metadata');
        const envelope = createPlainSessionOwnerMetadataEnvelopeV1(created.ownerMetadata);
        const initial = {
            mode: 'owner' as const, metadataLayoutVersion: 1 as const, metadataVersion: 3,
            sharedMetadataCiphertext: 'shared-current', ownerMetadataEnvelope: envelope,
            agentStateVersion: 5, agentStateCiphertext: null,
            value: { metadata, ownerMetadata: created.ownerMetadata,
                sharedMetadata: projectSessionSharedMetadataV1({ metadata }), agentState: null },
        };
        const transportWrites: unknown[] = [];
        let committed: unknown;
        await persistCreatedSessionAuthoringOrigin({
            sessionId: 'created-session', serverId: 'server-b', origin: recovered.authoringOrigin,
            shouldContinue: () => true,
            updateSessionMetadataWithRetry: async (sessionId, updater, options) => {
                expect(sessionId).toBe('created-session');
                expect(options.serverId).toBe('server-b');
                await updateSessionMetadataWithRetry<Metadata>({
                    sessionId, getSession: () => ({ metadataLayoutVersion: 1, metadataVersion: 3, metadata }),
                    refreshSessions: async () => undefined, acquireTupleSnapshot: async () => initial,
                    tupleCrypto: { encryptPayload: async (value) => JSON.stringify(value),
                        encodeOwnerMetadata: (owner) => createPlainSessionOwnerMetadataEnvelopeV1(owner) },
                    emitUpdateMetadata: async (payload) => {
                        transportWrites.push(payload);
                        return { result: 'success', metadataLayoutVersion: 1, version: 4, agentStateVersion: 6 };
                    },
                    applyTupleSnapshot: (snapshot) => { committed = snapshot; }, updater,
                });
            },
        });
        expect(committed).toMatchObject({ value: { metadata: {
            path: '/edited', machineId: 'edited-machine', work: {
                memoryEnabled: false, viewPreferences: { showToolCalls: true }, authoringOriginV1: origin,
            },
        } } });
        expect(transportWrites).toMatchObject([{ mode: 'owner', ownerMetadata: { t: 'plain', v: {
            work: { memoryEnabled: false, viewPreferences: { showToolCalls: true }, authoringOriginV1: origin },
        } } }]);
        const wire = transportWrites[0];
        if (!wire || typeof wire !== 'object' || !('sharedMetadata' in wire)) throw new Error('Expected tuple transport output');
        expect(JSON.stringify(wire.sharedMetadata)).not.toContain('comparison-a');
        expect(JSON.stringify(wire.sharedMetadata)).not.toContain('/original');
    });
});
