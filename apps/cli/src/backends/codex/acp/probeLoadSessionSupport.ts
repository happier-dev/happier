import { DefaultTransport } from '@/agent/transport';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { normalizeCapabilityProbeError } from '@/capabilities/utils/normalizeCapabilityProbeError';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { resolveCodexAcpSpawn } from './resolveCommand';
import { buildCodexAcpEnvOverrides } from './env';

export type CodexAcpLoadSessionProbeResult =
  | Readonly<{ ok: true; checkedAt: number; loadSession: boolean }>
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

    return probe.ok
      ? { ok: true as const, checkedAt: probe.checkedAt, loadSession: probe.agentCapabilities?.loadSession === true }
      : { ok: false as const, checkedAt: probe.checkedAt, error: normalizeCapabilityProbeError(probe.error) };
  } catch (e) {
    return { ok: false as const, checkedAt: Date.now(), error: normalizeCapabilityProbeError(e) };
  }
}
