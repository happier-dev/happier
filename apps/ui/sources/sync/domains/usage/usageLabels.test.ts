import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentUiBehaviorDeclarationV1Schema } from '@happier-dev/protocol/plugins/contributions/agentUiGrammar';
import { clearProjectedAgentUiBehaviorDescriptors, publishProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';
import { usageAgentTitle, usageSourceAgentId, usageSourceTitle } from './usageLabels';
import { MUSE_UI_DESCRIPTOR } from '../../../../../../packages/plugins/muse/src/ui/descriptor';
import { MUSE_ACCOUNTING_SOURCE_ID } from '../../../../../../packages/plugins/muse/src/agent/definition';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => {
    clearProjectedAgentUiBehaviorDescriptors();
    vi.restoreAllMocks();
});

describe('declared accounting source presentation', () => {
    it('names the host ACP runtime captures in words, never as humanized event ids', () => {
        for (const source of ['acp-usage-update', 'acp-session-update-usage', 'acp-prompt-usage']) {
            expect(usageSourceTitle(source)).not.toMatch(/acp/i);
        }
    });
    it('preserves released and parameterized source titles in the selected host locale', async () => {
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            expect(usageSourceTitle('claude-assistant-usage')).toBe(t('usage.board.page.sourceClaudeResponses'));
            publishProjectedAgentUiBehaviorDescriptors({ machineId: 'muse-machine', descriptorsByAgentId: {
                muse: MUSE_UI_DESCRIPTOR,
            } });
            expect(usageSourceTitle(MUSE_ACCOUNTING_SOURCE_ID)).toBe('utilisation · Muse');
        } finally {
            setPreferredLanguageFromSettings(previous);
        }
    });

    it('reads the Muse producer declaration through the same source label owner', () => {
        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'muse-machine', descriptorsByAgentId: {
            muse: MUSE_UI_DESCRIPTOR,
        } });
        expect(usageSourceAgentId(MUSE_ACCOUNTING_SOURCE_ID)).toBe('muse');
        expect(usageSourceTitle(MUSE_ACCOUNTING_SOURCE_ID)).toBe('usage · Muse');
    });

    it.each([
        ['claude-assistant-usage', 'claude'],
        ['claude-sdk-result', 'claude'],
        ['codex-app-server-token-usage', 'codex'],
        ['codex-native-accounting', 'codex'],
        ['pi-native-accounting', 'pi'],
        ['opencode-native-accounting', 'opencode'],
    ])('retains released source identity %s through its bundled declaration', (source, agentId) => {
        expect(usageSourceAgentId(source)).toBe(agentId);
        expect(usageSourceTitle(source)).not.toBe(source);
        expect(usageSourceTitle(source)).not.toBe(source.replace(/^[a-z]/, letter => letter.toUpperCase()));
    });

    it('names a declared capture by its Agent where coverage is listed, keeping the capture name elsewhere (acceptance 11-21 #9)', () => {
        for (const [source, agentId] of [['claude-assistant-usage', 'claude'], ['claude-sdk-result', 'claude'],
            ['codex-app-server-response-usage', 'codex'], ['codex-native-accounting', 'codex'], ['pi-session-stats', 'pi']] as const) {
            expect(usageSourceAgentId(source)).toBe(agentId);
            expect(usageSourceTitle(source, undefined, 'coverage')).toBe(usageAgentTitle(agentId));
        }
        expect(usageSourceTitle('claude-assistant-usage')).toBe(t('usage.board.page.sourceClaudeResponses'));
        // A host capture whose Agent the source does not name stays named for what it is.
        expect(usageSourceAgentId('acp-usage-update')).toBeNull();
        expect(usageSourceTitle('acp-usage-update', undefined, 'coverage')).not.toMatch(/acp/i);
    });

    it('reads installed Agent source declarations without discovering native inventories', () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        const agentId = 'third.party/research:remote';
        const declaration = { accountingSourcePresentation: [
            { sourceId: 'research-observed-v1', title: { key: 'usage.observed', fallback: 'Research observations' } },
            { sourceId: 'research-summary-v1', title: 'Research summaries' },
        ] };
        expect(AgentUiBehaviorDeclarationV1Schema.safeParse(declaration).success).toBe(true);
        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'research-machine', descriptorsByAgentId: {
            [agentId]: { kind: 'plugin.ui.v1', pluginId: 'third.party', agentId, behavior: declaration },
        } });

        expect(usageSourceAgentId('research-observed-v1')).toBe(agentId);
        expect(usageSourceAgentId('research-summary-v1')).toBe(agentId);
        expect(usageSourceAgentId(`native:${agentId}`)).toBe(agentId);
        expect(usageSourceTitle('research-observed-v1')).toBe('Research observations');
        expect(usageSourceTitle('research-summary-v1')).toBe('Research summaries');
        expect(usageSourceTitle('research-summary-v1', 'My capture')).toBe('My capture');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not retain source declarations after their Agent is removed', () => {
        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'research-machine', descriptorsByAgentId: {
            'third.party/research': { kind: 'plugin.ui.v1', pluginId: 'third.party', agentId: 'third.party/research',
                behavior: { accountingSourcePresentation: [{ sourceId: 'research-observed-v1', title: 'Research observations' }] } },
        } });
        expect(usageSourceAgentId('research-observed-v1')).toBe('third.party/research');
        publishProjectedAgentUiBehaviorDescriptors({ machineId: 'research-machine', descriptorsByAgentId: {} });
        expect(usageSourceAgentId('research-observed-v1')).toBeNull();
        expect(usageSourceTitle('research-observed-v1')).not.toBe('Research observations');
    });
});
