import { describe, expect, it } from 'vitest';

import { createProviderConnectionViewFixture } from '@/dev/testkit/harness/providerSettingsHarness';

import { buildSessionRouteSourceRows } from './buildSessionRouteSourceRows';

const CODEX = 'agent:happier.agent.codex/codex';
const CLAUDE = 'agent:happier.agent.claude/claude';

describe('buildSessionRouteSourceRows', () => {
    it('lists shown and hidden sources to browse and keeps an incompatible one, naming the Agents it works with', () => {
        const rows = buildSessionRouteSourceRows({
            agentTargetKey: CODEX,
            isGateway: view => view.connectionId === 'pc_gateway',
            views: [
                createProviderConnectionViewFixture({ connectionId: 'pc_gateway', providerName: 'Main gateway', displayName: 'Main gateway' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_shown', providerName: 'Ollama', displayName: 'Ollama' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_hidden', providerName: 'OpenRouter', displayName: 'Work',
                    role: 'named', displayNameMode: 'custom' }),
                createProviderConnectionViewFixture({ connectionId: 'pc_other', providerName: 'DeepSeek', displayName: 'DeepSeek',
                    compatibility: [
                        { agentTargetKey: CODEX, agentName: 'Codex', status: 'incompatible', reasons: ['no_compatible_protocol'] },
                        { agentTargetKey: CLAUDE, agentName: 'Claude Code', status: 'verified', reasons: [] },
                    ] }),
                // Offers this Agent nothing and is not known to be incompatible: not a route to name.
                createProviderConnectionViewFixture({ connectionId: 'pc_empty', providerName: 'Empty', displayName: 'Empty' }),
            ],
            // The hidden source keeps one favorite in the main picker; it is still a hidden source.
            shownSources: [{ connectionId: 'pc_shown', rows: [{}, {}, {}, {}] }, { connectionId: 'pc_hidden', rows: [{}] }],
            hiddenSources: [{ connectionId: 'pc_hidden', modelCount: 312 }, { connectionId: 'pc_gateway', modelCount: 9 }],
        });

        expect(rows.gateways).toEqual([
            { connectionId: 'pc_gateway', label: 'Main gateway', icon: null, modelCount: 9, hiddenFromPicker: true, worksWith: null },
        ]);
        expect(rows.providers).toEqual([
            { connectionId: 'pc_other', label: 'DeepSeek', icon: null, modelCount: null, hiddenFromPicker: false, worksWith: ['Claude Code'] },
            { connectionId: 'pc_shown', label: 'Ollama', icon: null, modelCount: 4, hiddenFromPicker: false, worksWith: null },
            { connectionId: 'pc_hidden', label: 'OpenRouter · Work', icon: null, modelCount: 313, hiddenFromPicker: true, worksWith: null },
        ]);
    });
});
