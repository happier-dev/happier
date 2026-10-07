import React from 'react';
import { describe, expect, it } from 'vitest';
import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { renderScreen } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCliGlyph } from '@/agents/catalog/catalog';
import { applyAcpBackendUpsertV1 } from '@happier-dev/protocol';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    storage: async (importOriginal) => importOriginal(),
    text: () => createTextModuleMock({ translate: (key) => key }),
});

function configuredBackendEntries() {
    const result = applyAcpBackendUpsertV1({
        settings: { v: 2, backends: [] },
        backend: { id: 'custom-acp', name: 'custom-acp', title: 'Custom ACP', command: 'custom-acp', args: [] },
        nowMs: 1,
    });
    if (!result.ok) throw new Error(`Invalid configured ACP fixture: ${result.code}`);
    const entries = getResolvedBackendCatalogEntries({ enabledAgentIds: [], acpCatalogSettingsV1: result.settings });
    expect(entries).toHaveLength(1);
    return entries;
}

function bundledEntries(enabledAgentIds: string[]) {
    return getResolvedBackendCatalogEntries({ enabledAgentIds, acpCatalogSettingsV1: { v: 2, backends: [] } });
}

describe('ProfileCompatibilityIcon', () => {
    it('shows only the first two compatible backend glyphs followed by ellipsis when more than two backends are supported', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');
        const backendEntries = bundledEntries(['claude', 'codex', 'opencode', 'auggie']);

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
                backendEntries={backendEntries}
            />,
        );

        const glyphs = screen.findAllByType('Text').map((node) => node.props.children);
        expect(glyphs).toEqual([getAgentCliGlyph('claude'), getAgentCliGlyph('codex'), '...']);
    });

    it('shows a neutral configured ACP glyph alongside a bundled Agent glyph without borrowing its icon', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');

        const screen = await renderScreen(
            <ProfileCompatibilityIcon
                profile={{
                    isBuiltIn: false,
                    compatibility: { codex: true },
                    compatibilityByTargetKey: {
                        'acpBackend:custom-acp': true,
                    },
                }}
                backendEntries={[...configuredBackendEntries(), ...bundledEntries(['codex'])]}
            />,
        );

        const glyphs = screen.findAllByType('Text').map((node) => node.props.children);
        expect(glyphs).toEqual(['•', getAgentCliGlyph('codex')]);
    });

    it('shows the neutral fallback glyph when legacy customAcp compatibility resolves to a configured backend with no canonical icon carrier', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');
        const compatEntries = configuredBackendEntries();

        const screen = await renderScreen(
            <ProfileCompatibilityIcon
                profile={{
                    isBuiltIn: false,
                    compatibility: { claude: true },
                    compatibilityByTargetKey: {
                        'acpBackend:custom-acp': true,
                    },
                }}
                backendEntries={[...compatEntries, ...bundledEntries(['claude'])]}
            />,
        );

        const glyphs = screen.findAllByType('Text').map((node) => node.props.children);
        expect(glyphs).toEqual(['•', getAgentCliGlyph('claude')]);
    });

    it('never borrows a bundled carrier glyph for an external Agent target', async () => {
        const { ProfileCompatibilityIcon } = await import('./ProfileCompatibilityIcon');
        const externalEntry: ResolvedBackendCatalogEntry = {
            agentCatalogEntry: createResolvedAgentCatalogEntryFixture({
                agentId: 'acme.review/agent',
                overrides: { isBuiltIn: false, iconAgentId: 'codex' },
            }),
            backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'agent' } },
            backendTargetKey: 'agent:acme.review/agent',
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
                    compatibility: { codex: true },
                    compatibilityByTargetKey: { 'agent:acme.review/agent': true },
                }}
                backendEntries={[externalEntry, ...bundledEntries(['codex'])]}
            />,
        );

        expect(screen.findAllByType('Text').map((node) => node.props.children)).toEqual(['•', getAgentCliGlyph('codex')]);
    });
});
