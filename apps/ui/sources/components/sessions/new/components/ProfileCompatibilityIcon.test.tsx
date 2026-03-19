import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input({ colors: { textSecondary: '#666' } })
                : input,
    },
    useUnistyles: () => ({}),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/profiles/profileCompatibility')>(
        '@/sync/domains/profiles/profileCompatibility',
    );
    return {
        ...actual,
        isProfileCompatibleWithBackendTarget: (profile: {
            compatibility?: Record<string, boolean>;
            compatibilityByTargetKey?: Record<string, boolean>;
        }, target: { kind: 'builtInAgent'; agentId: string } | { kind: 'configuredAcpBackend'; backendId: string }) => {
            if (target.kind === 'configuredAcpBackend') {
                return profile.compatibilityByTargetKey?.[`acpBackend:${target.backendId}`] === true;
            }
            return profile.compatibility?.[target.agentId] === true;
        },
    };
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'opencode', 'auggie', 'customAcp'],
    getAgentCliGlyph: (agentId: string) => ({
        claude: 'CL',
        codex: 'CX',
        opencode: 'OC',
        auggie: 'AU',
        customAcp: 'CA',
    })[agentId] ?? agentId,
    getAgentCore: () => ({
        displayNameKey: 'agent.name',
        ui: {
            profileCompatibilityGlyphScale: 1,
        },
    }),
    isAgentId: (agentId: string) => ['claude', 'codex', 'opencode', 'auggie', 'customAcp'].includes(agentId),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex', 'opencode', 'auggie'],
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => ({
        v: 2,
        backends: [{ id: 'custom-acp', title: 'Custom ACP', command: 'custom-acp', args: [] }],
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('ProfileCompatibilityIcon', () => {
    it('shows only the first two compatible backend glyphs followed by ellipsis when more than two backends are supported', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ProfileCompatibilityIcon
                    profile={{
                        isBuiltIn: false,
                        compatibility: {
                            claude: true,
                            codex: true,
                            opencode: true,
                            auggie: true,
                        },
                        compatibilityByTargetKey: {},
                    }}
                />,
            );
        });

        const glyphs = tree.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(glyphs).toEqual(['CL', 'CX', '...']);
    });

    it('shows the custom ACP glyph when a profile is only compatible with a configured ACP backend', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ProfileCompatibilityIcon
                    profile={{
                        isBuiltIn: false,
                        compatibility: {},
                        compatibilityByTargetKey: {
                            'acpBackend:custom-acp': true,
                        },
                    }}
                />,
            );
        });

        const glyphs = tree.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(glyphs).toEqual(['CA']);
    });
});
