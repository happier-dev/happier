import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { applyVoiceAgentSelection, type VoiceAgentSelectionChoice } from './voiceAgentSelection';
import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { resolveVoiceAgentCatalogSelectionV1, voiceAgentCatalogSelectionValueV1 } from '@happier-dev/protocol/voice/settings/voiceAgentSelection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

const externalChoice = {
    kind: 'catalog',
    entry: {
        agentId: 'external-registry-id',
        backendTargetKey: 'agent:acme.voice/agents/conversation',
        identity: { pluginId: 'acme.voice', localId: 'agents/conversation' },
        projectionGeneration: 7,
        isBuiltIn: false,
    },
} satisfies VoiceAgentSelectionChoice;

describe('atomic Voice Agent selection', () => {
    it('selects the exact configured target without confusing two definitions of the same Agent', () => {
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['first', 'second'].map(id => ({
            id, name: id, title: id, launch: { kind: 'command' as const, command: 'fixture-agent', args: [] }, createdAt: 0, updatedAt: 0,
        })) });
        const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: ['custom-acp'], acpCatalogSnapshot: {
            status: 'ready', record, revision: 1,
        } }).map(entry => entry.agentCatalogEntry);
        expect(entries).toHaveLength(2);
        const second = entries[1]!;
        expect(voiceAgentCatalogSelectionValueV1(entries[0]!)).not.toBe(voiceAgentCatalogSelectionValueV1(second));
        expect(resolveVoiceAgentCatalogSelectionV1(entries, second.backendTargetKey!)).toEqual(second);
        expect(resolveVoiceAgentCatalogSelectionV1(entries, second.agentId)).toBeNull();
        expect(resolveVoiceAgentCatalogSelectionV1([second], second.agentId)).toEqual(second);
        expect(resolveVoiceAgentCatalogSelectionV1(entries, 'agent:happier.agent.custom-acp/custom-acp:definition:missing')).toBeNull();
        const selected = applyVoiceAgentSelection(voiceSettingsDefaults, { kind: 'catalog', entry: second });
        expect(readLocalConversationVoiceSettings(selected).agent).toMatchObject({
            agentId: second.agentId, agentTargetKey: second.backendTargetKey,
            agentIdentity: second.identity,
        });
        expect(readLocalConversationVoiceSettings(selected).agent).not.toHaveProperty('agentProjectionGeneration');
    });
    it('does not activate an imported Chat intent from Agent choice alone without current selectable model facts', () => {
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const pending = writeLocalConversationVoiceSettings(voiceSettingsDefaults, { ...local, agent: {
            ...local.agent,
            providerChat: { status: 'needs_selection', providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
                chatModelId: 'legacy-chat', commitModelId: 'legacy-commit' },
        } });
        const next = applyVoiceAgentSelection(pending, { kind: 'legacy_provider_chat', agentId: 'opencode' });
        expect(next).toBe(pending);
        expect(readLocalConversationVoiceSettings(next).agent.providerChat?.status).toBe('needs_selection');
    });

    it.each([
        { authorized: false, chatConfirmed: true, commitConfirmed: true, expected: 'needs_selection' },
        { authorized: true, chatConfirmed: false, commitConfirmed: true, expected: 'needs_selection' },
        { authorized: true, chatConfirmed: true, commitConfirmed: false, expected: 'needs_selection' },
        { authorized: true, chatConfirmed: true, commitConfirmed: true, expected: 'configured' },
    ] as const)('uses the incumbent model picker admission for BOTH imported Chat models: %o', ({ authorized, chatConfirmed, commitConfirmed, expected }) => {
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const connectionId = ProviderConnectionIdSchema.parse('voice-openai-compatible-chat');
        const agentTargetKey = 'agent:happier.agent.opencode/opencode';
        const pending = writeLocalConversationVoiceSettings(voiceSettingsDefaults, { ...local, agent: {
            ...local.agent,
            providerChat: { status: 'needs_selection', providerConnectionId: connectionId,
                chatModelId: 'legacy-chat', commitModelId: 'legacy-commit' },
        } });
        const projection = createProviderModelProjectionFixture({ agentTargetKey, groups: [createProviderModelProjectionGroupFixture({
            connectionId,
            authorization: authorized ? { authorized: true } : { authorized: false,
                error: { v: 1, code: 'provider_connection_disabled', retryable: false, action: 'enable_connection' } },
            rows: ['legacy-chat', 'legacy-commit'].map(modelId => ({
                ref: { agentTargetKey, providerConnectionId: connectionId, modelId },
                descriptor: { id: modelId, name: modelId },
                sources: { manual: true, static: false, probe: false }, confidence: 'manual',
                compatibility: { result: { status: 'experimental', selectedProtocol: 'openai-chat',
                    reasons: ['compatibility_evidence_missing'], confirmationScope: { kind: 'model', modelId } },
                    compatibilityFingerprint: `compatibility:v1:${modelId}`,
                    confirmed: modelId === 'legacy-commit' ? commitConfirmed : chatConfirmed },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
            })),
        })] });
        const next = applyVoiceAgentSelection(pending, { kind: 'legacy_provider_chat', agentId: 'opencode', modelProjection: projection });
        expect(readLocalConversationVoiceSettings(next).agent.providerChat?.status).toBe(expected);
    });

    it('persists the exact external catalog tuple and replaces it completely for a bundled Agent', () => {
        const external = applyVoiceAgentSelection(voiceSettingsDefaults, externalChoice);
        const persisted = settingsParse({ voice: external }).voice;
        expect(readLocalConversationVoiceSettings(persisted).agent).toMatchObject({
            agentId: 'external-registry-id',
            agentTargetKey: 'agent:acme.voice/agents/conversation',
            agentIdentity: { pluginId: 'acme.voice', localId: 'agents/conversation' },
        });
        expect(readLocalConversationVoiceSettings(persisted).agent).not.toHaveProperty('agentProjectionGeneration');
        const bundled = applyVoiceAgentSelection(persisted, {
            kind: 'catalog',
            entry: {
                agentId: 'codex', backendTargetKey: 'agent:happier.agent.codex/codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                projectionGeneration: 8, isBuiltIn: true,
            },
        });
        expect(readLocalConversationVoiceSettings(bundled).agent).toMatchObject({
            agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex',
            agentIdentity: null,
        });
    });

    it('keeps unchanged custom selections exact but clears the tuple when the normalized id changes', () => {
        const external = applyVoiceAgentSelection(voiceSettingsDefaults, externalChoice);
        expect(applyVoiceAgentSelection(external, { kind: 'custom', agentId: '  external-registry-id  ' })).toBe(external);
        expect(applyVoiceAgentSelection(external, { kind: 'custom', agentId: '  ' })).toBe(external);
        const changed = applyVoiceAgentSelection(external, { kind: 'custom', agentId: '  claude  ' });
        expect(readLocalConversationVoiceSettings(changed).agent).toMatchObject({
            agentId: 'claude', agentTargetKey: null, agentIdentity: null,
        });
    });

    it('keeps stored selections readable when unknown observation fields are present', () => {
        const selected = applyVoiceAgentSelection(voiceSettingsDefaults, externalChoice);
        const local = readLocalConversationVoiceSettings(selected);
        const stored = { ...selected, providers: { ...selected.providers, local_conversation: {
            schemaVersion: 1, config: { ...local, agent: { ...local.agent,
                agentProjectionGeneration: 7, futureObservation: { version: 2 },
            } },
        } } };
        const actual = readLocalConversationVoiceSettings(settingsParse({ voice: stored }).voice).agent;
        expect(actual).toMatchObject({ agentId: externalChoice.entry.agentId,
            agentTargetKey: externalChoice.entry.backendTargetKey, agentIdentity: externalChoice.entry.identity });
        expect(actual).not.toHaveProperty('agentProjectionGeneration');
    });
});
