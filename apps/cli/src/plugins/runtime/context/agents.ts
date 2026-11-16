import type { AgentCliReadinessService as PluginAgentCliReadinessService } from '@happier-dev/plugin-sdk/exec';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { probeResolvedAgentCliVersion, type RunResolvedAgentCliVersionCommand } from '@/capabilities/snapshots/cliSnapshot';
import { resolveAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec';
import type { AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

type ReadinessOptionsForHost = Readonly<{
    processEnv?: Readonly<NodeJS.ProcessEnv>;
    runVersionCommand?: RunResolvedAgentCliVersionCommand;
    environment?: Readonly<Record<string, string>>;
}>;

export type PluginAgentCliReadinessServiceForHost = Readonly<{
    checkReadiness(
        request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0],
        options?: ReadinessOptionsForHost,
    ): ReturnType<PluginAgentCliReadinessService['checkReadiness']>;
}>;

export type CreatePluginAgentCliReadinessServiceParams = Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin agent CLI readiness check was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function uniqueCandidates(candidates: readonly string[]): readonly string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const value = candidate.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        normalized.push(value);
    }
    return Object.freeze(normalized);
}

function resolveCurrentLaunchableAgentCli(agentId: string, processEnv: NodeJS.ProcessEnv) {
    try {
        return resolveAgentCliLaunchSpec(agentId, { processEnv });
    } catch {
        // An installed Agent without current runtime metadata is not launchable. Keep
        // the readiness boundary fail-closed instead of substituting another Agent.
        return null;
    }
}

async function readVersionObservationIdentity(launch: AgentCliLaunchSpec, processEnv: NodeJS.ProcessEnv,
    environment: ReadinessOptionsForHost['environment']) {
    try {
        const paths = [...new Set([launch.resolvedPath, launch.command, ...launch.args.filter(isAbsolute)])];
        const files = await Promise.all(paths.map(async path => {
            const file = await stat(path, { bigint: true });
            return [path, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String);
        }));
        // Retain no extra copy of credentials that may be present in either environment.
        return createHash('sha256').update(JSON.stringify([
            launch, files, Object.entries(processEnv).sort(), Object.entries(environment ?? {}).sort(),
        ])).digest('hex');
    } catch {
        // An unreadable executable cannot establish reusable version facts.
        return null;
    }
}

export function createPluginAgentCliReadinessService(
    params: CreatePluginAgentCliReadinessServiceParams = {},
): PluginAgentCliReadinessServiceForHost {
    // One observation per Agent for this registry lifetime, not an automatic
    // probe loop. Resolve/stat on every demand so replacement or env changes
    // invalidate the observation. Failures and incomplete probes are not retained.
    const versions = new Map<string, Readonly<{ identity: string; version: string }>>();
    return Object.freeze({
        async checkReadiness(
            request: Parameters<PluginAgentCliReadinessService['checkReadiness']>[0],
            options?: ReadinessOptionsForHost,
        ) {
            assertNotAborted(request.signal);
            const processEnv = params.processEnv ?? options?.processEnv ?? sessionProcessEnvironment();
            const launchable: Array<Readonly<{ agentId: string; version?: string }>> = [];
            for (const agentId of uniqueCandidates(request.candidates)) {
                assertNotAborted(request.signal);
                const launch = resolveCurrentLaunchableAgentCli(agentId, processEnv);
                if (!launch) { versions.delete(agentId); continue; }
                if (request.includeVersion === true && !options?.runVersionCommand) {
                    throw new PluginError({
                        code: 'plugin_exec_agent_cli_version_unavailable',
                        message: 'Authorized Agent CLI version execution is unavailable',
                    });
                }
                let version: string | null = null;
                if (request.includeVersion === true && options?.runVersionCommand) {
                    const identity = await readVersionObservationIdentity(launch, processEnv, options.environment);
                    assertNotAborted(request.signal);
                    const previous = versions.get(agentId);
                    if (identity !== null && previous?.identity === identity) version = previous.version;
                    else {
                        versions.delete(agentId);
                        version = await probeResolvedAgentCliVersion({
                            agentId,
                            launch,
                            runVersionCommand: options.runVersionCommand,
                            env: processEnv,
                            signal: request.signal,
                        });
                        assertNotAborted(request.signal);
                        const currentIdentity = version && identity !== null
                            ? await readVersionObservationIdentity(launch, processEnv, options.environment) : null;
                        assertNotAborted(request.signal);
                        if (version && identity !== null && identity === currentIdentity) {
                            versions.set(agentId, { identity, version });
                        }
                    }
                }
                launchable.push(Object.freeze({ agentId, ...(version ? { version } : {}) }));
            }
            assertNotAborted(request.signal);
            return Object.freeze({ launchable: Object.freeze(launchable) });
        },
    });
}
