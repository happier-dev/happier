import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeCodexAcpLoadSessionSupport } from '@/backends/codex/acp/probeLoadSessionSupport';

export const cliCapability: Capability = {
    descriptor: { id: 'cli.codex', kind: 'cli', title: 'Codex CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.codex;
        const base = buildCliCapabilityData({ request, entry });

        const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
        if (!includeAcpCapabilities) {
            return base;
        }

        // Codex ACP is provided by the optional `codex-acp` binary (not the Codex CLI itself).
        // Probe initialize to check for loadSession support so the UI can enable resume reliably.
        const acp = await (async () => {
            const probe = await probeCodexAcpLoadSessionSupport();
            return probe.ok
                ? {
                    ok: true as const,
                    checkedAt: probe.checkedAt,
                    loadSession: probe.loadSession,
                    agentCapabilities: probe.agentCapabilities,
                }
                : { ok: false as const, checkedAt: probe.checkedAt, error: probe.error };
        })();

        return { ...base, acp };
    },
};
