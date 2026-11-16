import type { TransportHandler } from '@/agent/transport';
import { filterJsonObjectOrArrayLine } from '@/agent/transport/utils/jsonStdoutFilter';
import { probeAcpAgentCapabilities, type AcpProbeResult } from '@/capabilities/probes/acpProbe';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';

import type {
    PluginExecSystemToolAcpFingerprint,
    PluginExecSystemToolReadiness,
} from './definitions';

export type SystemToolFingerprintMatch = 'current' | 'legacy' | 'unknown';

export type SystemToolReadinessVerdict =
    | Readonly<{ kind: 'selected'; executablePath: string }>
    | Readonly<{ kind: 'legacy'; observedPath: string }>
    | Readonly<{ kind: 'unidentified'; observedPath: string }>
    | Readonly<{ kind: 'missing' }>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function hasObjectField(value: Record<string, unknown>, key: string): boolean {
    return asRecord(value[key]) !== null;
}

function matchesFingerprint(
    agentCapabilities: Record<string, unknown>,
    fingerprint: PluginExecSystemToolAcpFingerprint,
): boolean {
    if (agentCapabilities.loadSession !== fingerprint.loadSession) return false;
    const sessions = asRecord(agentCapabilities.sessionCapabilities);
    const mcp = asRecord(agentCapabilities.mcpCapabilities);
    if (!sessions || !mcp) return false;
    for (const key of fingerprint.sessionCapabilities) {
        if (!hasObjectField(sessions, key)) return false;
    }
    for (const key of fingerprint.absentSessionCapabilities) {
        if (sessions[key] !== undefined) return false;
    }
    return mcp.http === fingerprint.mcpHttp && mcp.sse === fingerprint.mcpSse;
}

/**
 * Classifies one observed ACP `initialize` capability set against the
 * provider-declared current/legacy fingerprints. Version strings are never
 * read: a superseded release with a higher semver still mismatches the current
 * fingerprint. Anything unrecognized stays `unknown` so the caller fails
 * truthfully instead of launching a guessed generation.
 */
export function matchSystemToolAcpFingerprint(
    agentCapabilities: unknown,
    fingerprints: Readonly<{
        current: PluginExecSystemToolAcpFingerprint;
        legacy: PluginExecSystemToolAcpFingerprint;
    }>,
): SystemToolFingerprintMatch {
    const capabilities = asRecord(agentCapabilities);
    if (!capabilities) return 'unknown';
    if (matchesFingerprint(capabilities, fingerprints.current)) return 'current';
    if (matchesFingerprint(capabilities, fingerprints.legacy)) return 'legacy';
    return 'unknown';
}

export function classifySystemToolProbe(
    probe: AcpProbeResult,
    fingerprints: Readonly<{
        current: PluginExecSystemToolAcpFingerprint;
        legacy: PluginExecSystemToolAcpFingerprint;
    }>,
): SystemToolFingerprintMatch {
    if (!probe.ok) return 'unknown';
    return matchSystemToolAcpFingerprint(probe.agentCapabilities, fingerprints);
}

function readinessProbeTransport(toolId: string): TransportHandler {
    return {
        agentName: `system-tool-readiness:${toolId}`,
        filterStdoutLine: (line: string) => filterJsonObjectOrArrayLine(line),
    } as TransportHandler;
}

type ProbedCandidate = Readonly<{
    command: string;
    fingerprint: SystemToolFingerprintMatch;
    supportsCommandSurface: boolean;
}>;

async function probeCandidate(params: Readonly<{
    toolId: string;
    command: string;
    cwd: string;
    env: Record<string, string | undefined>;
    readiness: PluginExecSystemToolReadiness;
    signal?: AbortSignal;
}>): Promise<ProbedCandidate> {
    const transport = readinessProbeTransport(params.toolId);
    const [probe, surface] = await Promise.all([
        probeAcpAgentCapabilities({
            command: params.command,
            args: [...params.readiness.acpProbeArgs],
            cwd: params.cwd,
            env: params.env,
            transport,
            timeoutMs: null,
            signal: params.signal,
        }),
        runCliCommandBestEffort({
            resolvedPath: params.command,
            args: [...params.readiness.commandSurfaceArgs],
            processEnv: params.env,
            cwd: params.cwd,
            timeoutMs: null,
            signal: params.signal,
        }),
    ]);
    return {
        command: params.command,
        fingerprint: classifySystemToolProbe(probe, {
            current: params.readiness.currentFingerprint,
            legacy: params.readiness.legacyFingerprint,
        }),
        supportsCommandSurface: surface.ok === true && surface.exitCode === 0,
    };
}

/**
 * Selects the runnable candidate to launch from observed command behavior.
 * A current fingerprint always wins over an earlier legacy one without
 * comparing versions. An explicit preferred-path candidate only selects which
 * binary is classified; it never bypasses classification, and an
 * unresponsive explicit binary fails as unidentified rather than inheriting
 * the environment's legacy verdict. A PATH-discovered candidate that answers
 * neither fingerprint is unidentified, not evidence of a legacy runtime.
 * Provider-owned migration guidance applies only when the separately declared
 * legacy executable was actually discovered.
 */
export async function resolveSystemToolReadiness(params: Readonly<{
    toolId: string;
    readiness: PluginExecSystemToolReadiness;
    candidates: readonly string[];
    explicitCandidate: boolean;
    legacyCandidates: readonly string[];
    cwd: string;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
}>): Promise<SystemToolReadinessVerdict> {
    if (params.candidates.length === 0) {
        const legacy = params.legacyCandidates[0];
        return legacy
            ? { kind: 'legacy', observedPath: legacy }
            : { kind: 'missing' };
    }
    const firstCandidate = params.candidates[0];
    if (firstCandidate === undefined) return { kind: 'missing' };
    const probed = await Promise.all(params.candidates.map((command) => probeCandidate({
        toolId: params.toolId,
        command,
        cwd: params.cwd,
        env: params.env,
        readiness: params.readiness,
        signal: params.signal,
    })));
    const current = probed.find((candidate) => candidate.fingerprint === 'current');
    if (current) return { kind: 'selected', executablePath: current.command };
    const legacy = probed.find((candidate) => candidate.fingerprint === 'legacy');
    if (legacy) return { kind: 'legacy', observedPath: legacy.command };
    if (params.explicitCandidate) {
        return { kind: 'unidentified', observedPath: probed[0]?.command ?? firstCandidate };
    }
    const responsive = probed.find((candidate) => candidate.supportsCommandSurface);
    if (responsive) {
        return { kind: 'unidentified', observedPath: responsive.command };
    }
    const legacyName = params.legacyCandidates[0];
    return legacyName
        ? { kind: 'legacy', observedPath: legacyName }
        : { kind: 'unidentified', observedPath: probed[0]?.command ?? firstCandidate };
}
