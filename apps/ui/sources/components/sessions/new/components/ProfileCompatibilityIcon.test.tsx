import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createResolvedAgentCatalogEntryFixture, renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
        }, target: { kind: 'backend'; backendId: string; configuredBackendId?: string }) => {
            if (typeof target.configuredBackendId === 'string' && target.configuredBackendId.trim().length > 0) {
                return profile.compatibilityByTargetKey?.[`acpBackend:${target.configuredBackendId}`] === true;
            }
            return profile.compatibility?.[target.backendId] === true;
        },
    };
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'opencode', 'auggie'],
    getAgentCliGlyph: (agentId: string) => ({
        claude: 'CL',
        codex: 'CX',
        opencode: 'OC',
        auggie: 'AU',
    })[agentId] ?? agentId,
    getAgentCore: () => ({
        displayNameKey: 'agent.name',
        ui: {
            profileCompatibilityGlyphScale: 1,
        },
    }),
    isBundledAgentId: (agentId: string) => ['claude', 'codex', 'opencode', 'auggie'].includes(agentId),
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

    it('shows the neutral fallback glyph when a profile is only compatible with a configured ACP backend that has no real provider icon', async () => {
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
        expect(glyphs).toEqual(['•']);
    });

    it('shows the neutral fallback glyph when legacy customAcp compatibility resolves to a configured backend with no canonical icon carrier', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');
        const compatEntries: ResolvedBackendCatalogEntry[] = [{
            agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'acp:custom-acp' }),
            backendTarget: { kind: 'backend', backendId: 'custom-acp', configuredBackendId: 'custom-acp', sourceKind: 'configured' },
            backendTargetKey: 'backend:custom-acp:configured:custom-acp',
            kind: 'configuredBackend',
            backendId: 'custom-acp',
            agentId: 'acp:custom-acp',
            catalogAgentId: null,
            builtInAgentId: null,
            iconAgentId: null,
            title: 'Custom ACP',
            subtitle: 'custom-acp',
            cliAuthBackgroundCheckSafe: false,
        }];

        const screen = await renderScreen(
            <ProfileCompatibilityIcon
                profile={{
                    isBuiltIn: false,
                    compatibility: {},
                    compatibilityByTargetKey: {
                        'acpBackend:custom-acp': true,
                    },
                }}
                backendEntries={compatEntries}
            />,
        );

        const glyphs = screen.findAllByType('Text').map((node: any) => node.props.children);
        expect(glyphs).toEqual(['•']);
    });

    it('never borrows a bundled carrier glyph for an external Agent target', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');
        const externalEntry: ResolvedBackendCatalogEntry = {
            agentCatalogEntry: createResolvedAgentCatalogEntryFixture({
                agentId: 'acme.review/agent',
                overrides: { isBuiltIn: false, iconAgentId: 'codex' },
            }),
            backendTarget: { kind: 'backend', backendId: 'acme-review' },
            backendTargetKey: 'backend:acme-review',
            kind: 'pluginBackend',
            backendId: 'acme-review',
            agentId: 'acme.review/agent',
            catalogAgentId: null,
            builtInAgentId: null,
            iconAgentId: 'codex',
            title: 'Acme Review',
            subtitle: null,
            cliAuthBackgroundCheckSafe: false,
        };

        const screen = await renderScreen(
            <ProfileCompatibilityIcon
                profile={{
                    isBuiltIn: false,
                    compatibility: { 'acme-review': true },
                    compatibilityByTargetKey: {},
                }}
                backendEntries={[externalEntry]}
            />,
        );

        expect(screen.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['•']);
    });
});
