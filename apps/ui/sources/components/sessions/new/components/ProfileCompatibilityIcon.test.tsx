import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    storage: () => createStorageModuleStub({
        useSetting: () => ({
            v: 2,
            backends: [{ id: 'custom-acp', title: 'Custom ACP', command: 'custom-acp', args: [] }],
        }),
    }),
    text: () => createTextModuleMock({ translate: (key) => key }),
});

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

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('ProfileCompatibilityIcon', () => {
    it('shows only the first two compatible backend glyphs followed by ellipsis when more than two backends are supported', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');

        const screen = await renderScreen(
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

        const glyphs = screen.findAllByType('Text').map((node: any) => node.props.children);
        expect(glyphs).toEqual(['CL', 'CX', '...']);
    });

    it('shows the custom ACP glyph when a profile is only compatible with a configured ACP backend', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');

        const screen = await renderScreen(
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

        const glyphs = screen.findAllByType('Text').map((node: any) => node.props.children);
        expect(glyphs).toEqual(['CA']);
    });
});
