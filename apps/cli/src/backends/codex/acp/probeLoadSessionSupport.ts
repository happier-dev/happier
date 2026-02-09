import { DefaultTransport } from '@/agent/transport';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { normalizeCapabilityProbeError } from '@/capabilities/utils/normalizeCapabilityProbeError';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { resolveCodexAcpSpawn } from './resolveCommand';
import { buildCodexAcpEnvOverrides } from './env';

export type CodexAcpLoadSessionProbeResult =
  | Readonly<{
      ok: true;
      checkedAt: number;
      loadSession: boolean;
      agentCapabilities: {
        loadSession: boolean;
        sessionCapabilities: Record<string, unknown>;
        promptCapabilities: {
          image: boolean;
          audio: boolean;
          embeddedContext: boolean;
        };
        mcpCapabilities: {
          http: boolean;
          sse: boolean;
        };
      };
    }>
  | Readonly<{ ok: false; checkedAt: number; error: ReturnType<typeof normalizeCapabilityProbeError> }>;

export async function probeCodexAcpLoadSessionSupport(): Promise<CodexAcpLoadSessionProbeResult> {
  try {
    const spawn = resolveCodexAcpSpawn();
    const probe = await probeAcpAgentCapabilities({
      command: spawn.command,
      args: spawn.args,
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
        DEBUG: '',
        ...buildCodexAcpEnvOverrides(),
      },
      transport: new DefaultTransport('codex'),
      timeoutMs: resolveAcpProbeTimeoutMs('codex'),
    });

    if (!probe.ok) {
      return { ok: false as const, checkedAt: probe.checkedAt, error: normalizeCapabilityProbeError(probe.error) };
    }

    const capabilities = probe.agentCapabilities ?? {};
    const loadSession = capabilities.loadSession === true;
    const promptCapabilitiesRaw = (capabilities as any).promptCapabilities;
    const promptCapabilities =
      promptCapabilitiesRaw && typeof promptCapabilitiesRaw === 'object'
        ? {
            image: (promptCapabilitiesRaw as any).image === true,
            audio: (promptCapabilitiesRaw as any).audio === true,
            embeddedContext: (promptCapabilitiesRaw as any).embeddedContext === true,
          }
        : { image: false, audio: false, embeddedContext: false };
    const mcpCapabilitiesRaw = (capabilities as any).mcpCapabilities;
    const mcpCapabilities =
      mcpCapabilitiesRaw && typeof mcpCapabilitiesRaw === 'object'
        ? {
            http: (mcpCapabilitiesRaw as any).http === true,
            sse: (mcpCapabilitiesRaw as any).sse === true,
          }
        : { http: false, sse: false };
    const sessionCapabilitiesRaw = (capabilities as any).sessionCapabilities;
    const sessionCapabilities =
      sessionCapabilitiesRaw && typeof sessionCapabilitiesRaw === 'object' && !Array.isArray(sessionCapabilitiesRaw)
        ? (sessionCapabilitiesRaw as Record<string, unknown>)
        : {};

    return {
      ok: true as const,
      checkedAt: probe.checkedAt,
      loadSession,
      agentCapabilities: {
        loadSession,
        sessionCapabilities,
        promptCapabilities,
        mcpCapabilities,
      },
    };
  } catch (e) {
    return { ok: false as const, checkedAt: Date.now(), error: normalizeCapabilityProbeError(e) };
  }
}
