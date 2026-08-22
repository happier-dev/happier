import { describe, expect, it } from 'vitest';

import { hasBlockingPluginReloadDiagnostic } from '@/plugins/runtime/reload/controller';
import type {
    ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type {
    ConfiguredExternalSessionSourceAgentContribution,
} from '@/session/external/configuredSourceMaterializer';
import type {
    ConfiguredExternalSessionSourceRefusal,
} from '@/session/external/configuredSourceRegistry';

import { projectExternalSessionSourceRefusalDiagnostics } from './externalSessionSourceRefusals';

function agent(
    id: string,
    pluginId?: string,
): ConfiguredExternalSessionSourceAgentContribution {
    return Object.freeze({
        id,
        ...(pluginId ? { identity: Object.freeze({ pluginId, localId: id }) } : {}),
    });
}

function refusal(
    agentId: string,
    code: ConfiguredExternalSessionSourceRefusal['code'],
    message: string,
): ConfiguredExternalSessionSourceRefusal {
    return Object.freeze({ agentId, code, message });
}

describe('external-session configured source refusal diagnostics', () => {
    it('names the refused Agent against its own plugin and leaves every other plugin clean', () => {
        const diagnostics = projectExternalSessionSourceRefusalDiagnostics(
            [agent('flaky', 'acme.flaky'), agent('healthy', 'acme.healthy')],
            [refusal(
                'flaky',
                'provider_source_invalid',
                "Configured external-session source for agent 'flaky' was rejected by its provider",
            )],
        );

        expect(Object.keys(diagnostics)).toEqual(['acme.flaky']);
        expect(diagnostics['acme.flaky']).toEqual([{
            code: 'plugin_external_session_source_refused',
            message: expect.stringContaining('flaky'),
            contribution: { pluginId: 'acme.flaky', localId: 'flaky' },
        }]);
        expect(diagnostics['acme.flaky']![0]!.message)
            .toContain('provider_source_invalid');
    });

    it('never blocks reload adoption or the readiness candidate for the refused plugin', () => {
        // A refused configured source can be a transient provider probe failure.
        // `plugin_activation_failed` — the code the activation owner uses for
        // deterministic registration drift — is a BLOCKING reload diagnostic, so
        // reusing it here would reject the whole readiness candidate and refuse
        // the plugin's reload. This is the regression guard for that choice.
        const diagnostics = projectExternalSessionSourceRefusalDiagnostics(
            [agent('flaky', 'acme.flaky')],
            [refusal('flaky', 'provider_ops_unavailable', 'ops unavailable')],
        );
        const registry = {
            pluginDiagnosticsByPluginId: diagnostics,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;

        expect(diagnostics['acme.flaky']).toHaveLength(1);
        expect(hasBlockingPluginReloadDiagnostic(registry, ['acme.flaky'])).toBe(false);
    });

    it('collapses repeated identical refusals and keeps distinct ones for one Agent', () => {
        const diagnostics = projectExternalSessionSourceRefusalDiagnostics(
            [agent('flaky', 'acme.flaky')],
            [
                refusal('flaky', 'provider_source_invalid', 'rejected'),
                refusal('flaky', 'provider_source_invalid', 'rejected'),
                refusal('flaky', 'malformed_canonical_source', 'malformed canonical'),
            ],
        );

        expect(diagnostics['acme.flaky']).toHaveLength(2);
        expect(diagnostics['acme.flaky']!.map((entry) => entry.message)).toEqual([
            expect.stringContaining('provider_source_invalid'),
            expect.stringContaining('malformed_canonical_source'),
        ]);
    });

    it('skips an Agent with no contribution identity and publishes nothing without refusals', () => {
        expect(projectExternalSessionSourceRefusalDiagnostics(
            [agent('bundled-in-code')],
            [refusal('bundled-in-code', 'provider_source_invalid', 'rejected')],
        )).toEqual({});
        expect(projectExternalSessionSourceRefusalDiagnostics(
            [agent('flaky', 'acme.flaky')],
            [],
        )).toEqual({});
    });
});
