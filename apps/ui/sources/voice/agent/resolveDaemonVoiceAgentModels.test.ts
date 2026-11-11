import { describe, expect, it } from 'vitest';
import { resolveDaemonVoiceAgentModelIds } from './resolveDaemonVoiceAgentModels';
import { getAgentCore } from '@/agents/catalog/catalog';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

const baseMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('The canonical Session fixture requires readable metadata');
    return metadata;
})();

describe('resolveDaemonVoiceAgentModelIds', () => {
    it('uses Codex defaults for a retained Claude chat and commit model', () => {
        expect(resolveDaemonVoiceAgentModelIds({ metadata: { ...baseMetadata, flavor: 'codex' }, agent: {
            chatModelSource: 'custom', chatModelId: 'claude-haiku-4-5',
            commitModelSource: 'custom', commitModelId: 'claude-sonnet-4-5',
        } })).toEqual({ chatModelId: getAgentCore('codex')?.model?.defaultMode,
            commitModelId: getAgentCore('codex')?.model?.defaultMode });
    });
    it('keeps configured ACP custom models and leaves Session model inheritance to admission', () => {
        const metadata = { ...baseMetadata, flavor: 'custom-acp', acpConfiguredBackendV1: {
            v: 1 as const, backendId: 'qa-c-exact-args', title: 'QA configured ACP', updatedAt: 1,
        } };
        expect(resolveDaemonVoiceAgentModelIds({ metadata, agent: { chatModelSource: 'custom',
            chatModelId: 'acp-model', commitModelSource: 'chat' } })).toEqual({
                chatModelId: 'acp-model', commitModelId: 'acp-model',
            });
        expect(resolveDaemonVoiceAgentModelIds({ metadata, agent: { chatModelSource: 'session',
            commitModelSource: 'session' } })).toEqual({});
    });
    it('recognizes a current Custom ACP target carried by Session creation provenance', () => {
        const correspondence = SessionCreationCorrespondenceV1Schema.parse({
            v: 1, sessionCreationTag: `create:v1:${'b'.repeat(43)}`, recipe: {
                execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/project' } },
                organization: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
                    definitionId: 'qa-c-exact-args' }, modelSelection: null, profileId: null,
                requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
                capabilitySelection: null, transcriptStorage: 'persisted', terminal: null,
                agentSessionStartupInstructionsMarkerV1: null, checkout: null,
            },
        });
        expect(resolveDaemonVoiceAgentModelIds({ metadata: { ...baseMetadata, sessionCreationCorrespondenceV1: correspondence },
            agent: { chatModelSource: 'custom', chatModelId: 'acp-model', commitModelSource: 'chat' } }))
            .toEqual({ chatModelId: 'acp-model', commitModelId: 'acp-model' });
    });
    it('uses custom chat model and commit=chat when configured', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'fast-model',
                commitModelSource: 'chat',
                commitModelId: 'heavy-model',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model', commitModelId: 'fast-model' });
    });

    it('uses session model when chat source=session', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'session',
                chatModelId: 'ignored',
                commitModelSource: 'chat',
                commitModelId: 'ignored',
            },
        });
        expect(result).toEqual({});
    });

    it('uses commit source=session even when chat is custom', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'fast-model',
                commitModelSource: 'session',
                commitModelId: 'ignored',
            },
        });
        expect(result).toEqual({ chatModelId: 'fast-model' });
    });

    it('uses commit custom model when commit source=custom', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'claude' },
            agent: {
                chatModelSource: 'session',
                chatModelId: 'ignored',
                commitModelSource: 'custom',
                commitModelId: 'commit-model',
            },
        });
        expect(result).toEqual({ commitModelId: 'commit-model' });
    });

    it('reports the typed unavailable when the session Agent identity is unreadable', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'unknown-agent' },
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'chat',
            },
        });

        expect(result).toBeNull();
    });

    it('resolves models for an externally installed Agent declared by the session runtime', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata,
                runtimeDescriptorV1: { v: 1, agentId: 'acme.agent/voice', agent: {} },
                sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({
                    v: 1, sessionCreationTag: `create:v1:${'a'.repeat(43)}`, recipe: {
                        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/project' } },
                        organization: { folderId: null, tagIds: [] },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'voice' } },
                        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
                        configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: 'persisted',
                        terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
                    },
                }),
            },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'acme-fast',
                commitModelSource: 'chat',
            },
        });

        expect(result).toEqual({ chatModelId: 'acme-fast', commitModelId: 'acme-fast' });
    });

    it('uses the target session flavor defaults for default sentinel values', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'codex' },
            agent: {
                chatModelSource: 'custom',
                chatModelId: 'default',
                commitModelSource: 'chat',
                commitModelId: 'default',
            },
        });

        expect(result).toEqual({
            chatModelId: getAgentCore('codex')?.model?.defaultMode,
            commitModelId: getAgentCore('codex')?.model?.defaultMode,
        });
    });

    it('uses the resolved Agent flavor for session-default models', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'codex' },
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'session',
            },
        });

        expect(result).toEqual({});
    });

    it('uses the already-resolved owner Agent identity for default session models', () => {
        const result = resolveDaemonVoiceAgentModelIds({
            metadata: { ...baseMetadata, flavor: 'gemini' },
            agent: {
                chatModelSource: 'session',
                commitModelSource: 'session',
            },
        });

        expect(result).toEqual({});
    });

});
