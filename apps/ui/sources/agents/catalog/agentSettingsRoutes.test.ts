import { describe, expect, it } from 'vitest';

import {
    createAgentSettingsRoute,
    createPluginAgentSettingsRoute,
    resolveAgentModelsTargetKey,
} from './agentSettingsRoutes';

describe('agentSettingsRoutes', () => {
    it('retains exact plugin identity when Agents share one local id', () => {
        const left = { pluginId: 'acme.agent-one', localId: 'assistant' };
        const right = { pluginId: 'acme.agent-two', localId: 'assistant' };

        expect(createAgentSettingsRoute({ agentId: 'left', identity: left }))
            .toBe('/(app)/settings/agents/assistant?pluginId=acme.agent-one');
        expect(createAgentSettingsRoute({ agentId: 'right', identity: right }))
            .toBe('/(app)/settings/agents/assistant?pluginId=acme.agent-two');
        expect(createPluginAgentSettingsRoute(right))
            .toBe('/(app)/settings/agents/assistant?pluginId=acme.agent-two');
    });

    it('keeps bundled-only Agents on their canonical local route', () => {
        expect(createAgentSettingsRoute({ agentId: 'codex', identity: null }))
            .toBe('/(app)/settings/agents/codex');
    });

    it('never recreates the built-in backend target split for model settings', () => {
        expect(resolveAgentModelsTargetKey({ agentId: 'codex' }))
            .toBe('agent:happier.agent.codex/codex');
        expect(resolveAgentModelsTargetKey({
            agentId: 'assistant',
            pluginId: 'acme.agent',
        })).toBe('agent:acme.agent/assistant');
        expect(resolveAgentModelsTargetKey({
            agentId: 'codex',
            agentTargetKey: 'agent:override.agent/codex',
        })).toBe('agent:override.agent/codex');
    });
});
