import { DefaultTransport } from '@/agent/transport';
import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import { normalizeCapabilityProbeError } from '@/capabilities/utils/normalizeCapabilityProbeError';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { resolveCodexAcpSpawn } from './resolveCommand';
import { buildCodexAcpEnvOverrides } from './env';

export type CodexAcpLoadSessionProbeResult = ReturnType<typeof buildAcpCapabilitySnapshot>;

export async function probeCodexAcpLoadSessionSupport(opts?: { signal?: AbortSignal | null }): Promise<CodexAcpLoadSessionProbeResult> {
  const signal = opts?.signal ?? null;
  if (signal?.aborted) {
    return { ok: false as const, checkedAt: Date.now(), error: normalizeCapabilityProbeError(new Error('Aborted')) };
  }
  try {
    type ProbeResult = Awaited<ReturnType<typeof probeAcpAgentCapabilities>>;

    const probePromise: Promise<ProbeResult> = (async () => {
      const spawn = resolveCodexAcpSpawn({ disableUserMcpServers: true });
      return await probeAcpAgentCapabilities({
        command: spawn.command,
        args: spawn.args,
        cwd: process.cwd(),
        env: buildCodexAcpEnvOverrides({
          baseEnv: {
          NODE_ENV: 'production',
          DEBUG: '',
          },
        }),
        transport: new DefaultTransport('codex'),
        timeoutMs: resolveAcpProbeTimeoutMs('codex'),
      });
    })();

    const probe = await (async () => {
      if (!signal) return await probePromise;
      return await Promise.race([
        probePromise,
        new Promise<ProbeResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve({
                ok: false,
                checkedAt: Date.now(),
                error: new Error('Aborted'),
              } as ProbeResult);
            },
            { once: true },
          );
        }),
      ]);
    })();

    return buildAcpCapabilitySnapshot(probe);
  } catch (e) {
    return { ok: false as const, checkedAt: Date.now(), error: normalizeCapabilityProbeError(e) };
  }
}
