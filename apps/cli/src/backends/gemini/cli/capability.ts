import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { geminiTransport } from '@/backends/gemini/acp/transport';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';

export const cliCapability: Capability = {
    descriptor: { id: 'cli.gemini', kind: 'cli', title: 'Gemini CLI' },
    detect: async ({ request, context }) => {
        const entry = context.cliSnapshot?.clis?.gemini;
        const base = buildCliCapabilityData({ request, entry });

        const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
        if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
            return base;
        }

        const probe = await probeAcpAgentCapabilities({
            command: base.resolvedPath,
            args: ['--experimental-acp'],
            cwd: process.cwd(),
            env: {
                // Keep output clean to avoid ACP stdout pollution.
                NODE_ENV: 'production',
                DEBUG: '',
            },
            transport: geminiTransport,
            timeoutMs: resolveAcpProbeTimeoutMs('gemini'),
        });

        const acp = buildAcpCapabilitySnapshot(probe);

        return { ...base, acp };
    },
};
