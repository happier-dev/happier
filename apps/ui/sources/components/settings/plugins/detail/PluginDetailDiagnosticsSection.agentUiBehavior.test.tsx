import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => {
                const translations: Readonly<Record<string, string>> = {
                    'settingsPlugins.diagnosticsTitle': 'Plugin diagnostics',
                    'settingsPlugins.registryDiagnosticsTitle': 'Registry diagnostics',
                    'settingsPlugins.agentUiDiagnosticsTitle': 'Agent interface diagnostics',
                };
                return translations[key] ?? key;
            },
        });
    },
});

/**
 * A refusal the shared descriptor interpreter emits for a form it does not
 * support. A bundled Agent's identical field is caught by the generator test in
 * CI; an external Agent's is only ever produced at runtime, so this section is
 * the author's single feedback channel for it.
 */
function refusedAdapterDescriptor(pluginId: string, agentId: string): Readonly<Record<string, unknown>> {
    return {
        kind: 'plugin.ui.v1',
        pluginId,
        agentId,
        version: 1,
        behavior: { payload: { spawnSessionExtras: { kind: 'adapter', adapterId: `${pluginId}.custom` } } },
    };
}

async function publish(machineId: string, descriptorsByAgentId: Readonly<Record<string, unknown>>): Promise<void> {
    const { publishProjectedAgentUiBehaviorDescriptors } = await import(
        '@/agents/registry/agentUiBehaviorProjection'
    );
    publishProjectedAgentUiBehaviorDescriptors({ machineId, descriptorsByAgentId });
}

afterEach(async () => {
    const { clearProjectedAgentUiBehaviorDescriptors } = await import(
        '@/agents/registry/agentUiBehaviorProjection'
    );
    clearProjectedAgentUiBehaviorDescriptors();
});

describe('PluginDetailDiagnosticsSection agent UI behavior refusals', () => {
    it('shows the author the interpreter refusals their own Agent descriptor produced', async () => {
        await publish('machine-a', {
            'acme.agent': refusedAdapterDescriptor('acme.tools', 'acme.agent'),
        });
        const { PluginDetailDiagnosticsSection } = await import('./PluginDetailDiagnosticsSection');

        const screen = await renderScreen(
            <PluginDetailDiagnosticsSection
                pluginId="acme.tools"
                machineId="machine-a"
                projection={null}
                registryDiagnostics={[]}
            />,
        );

        const content = screen.getTextContent();
        expect(content).toContain('A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER');
        expect(content).toContain('Agent interface diagnostics');
    });

    it('never attributes another plugin\'s refusal to this plugin', async () => {
        await publish('machine-a', {
            'acme.agent': refusedAdapterDescriptor('acme.tools', 'acme.agent'),
            'other.agent': refusedAdapterDescriptor('other.tools', 'other.agent'),
        });
        const { PluginDetailDiagnosticsSection } = await import('./PluginDetailDiagnosticsSection');

        const screen = await renderScreen(
            <PluginDetailDiagnosticsSection
                pluginId="acme.tools"
                machineId="machine-a"
                projection={null}
                registryDiagnostics={[]}
            />,
        );

        const content = screen.getTextContent();
        expect(content).toContain('acme.agent');
        expect(content).not.toContain('other.agent');
    });

    it('shows nothing for a machine that published no descriptor', async () => {
        await publish('machine-a', {
            'acme.agent': refusedAdapterDescriptor('acme.tools', 'acme.agent'),
        });
        const { PluginDetailDiagnosticsSection } = await import('./PluginDetailDiagnosticsSection');

        const screen = await renderScreen(
            <PluginDetailDiagnosticsSection
                pluginId="acme.tools"
                machineId="machine-b"
                projection={null}
                registryDiagnostics={[]}
            />,
        );

        expect(screen.getTextContent()).not.toContain('A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER');
    });
});
