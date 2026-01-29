import type { Capability } from '@/capabilities/service';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { normalizeCapabilityProbeError } from '@/capabilities/utils/normalizeCapabilityProbeError';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { kimiTransport } from '@/backends/kimi/acp/transport';

export const cliCapability: Capability = {
  descriptor: { id: 'cli.kimi', kind: 'cli', title: 'Kimi CLI' },
  detect: async ({ request, context }) => {
    const entry = context.cliSnapshot?.clis?.kimi;
    const base = buildCliCapabilityData({ request, entry });

    const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
    if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
      return base;
    }

    const probe = await probeAcpAgentCapabilities({
      command: base.resolvedPath,
      args: ['acp'],
      cwd: process.cwd(),
      env: {
        // Keep output clean to avoid ACP stdout pollution.
        NODE_ENV: 'production',
        DEBUG: '',
      },
      transport: kimiTransport,
      timeoutMs: resolveAcpProbeTimeoutMs('kimi'),
    });

    const acp = probe.ok
      ? { ok: true, checkedAt: probe.checkedAt, loadSession: probe.agentCapabilities?.loadSession === true }
      : { ok: false, checkedAt: probe.checkedAt, error: normalizeCapabilityProbeError(probe.error) };

    return { ...base, acp };
  },
};

