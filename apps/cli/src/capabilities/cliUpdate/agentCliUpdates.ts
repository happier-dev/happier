import {
  classifyAgentCliInstall,
  fetchAgentCliLatestVersion,
  resolveAgentCliLatestVersionSource,
  resolvePlatformFromNodePlatform,
  type AgentCliInstallSource,
  type AgentCliLatestVersionFacts,
  type AgentCliResolutionSource,
  type AgentCliUpdateFacts,
  type AgentCliRuntimeDescriptor,
  type AgentCliSourcePolicy,
  type AgentInstallProgressCallback,
} from '@happier-dev/cli-common/agents';
import { compareVersions } from '@happier-dev/cli-common/update';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';

import { configuration } from '@/configuration';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { invalidateCliSnapshots } from '@/capabilities/snapshots/cliSnapshot';
import type { Capability, CapabilitiesDetectContextBuilder } from '@/capabilities/service';
import type { CapabilitiesInvokeResponse, CapabilityDetectRequest } from '@/capabilities/types';
import { invokeAgentCliInstall } from '@/packagedRuntime/managedTools/invokeAgentCliInstall';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { logger } from '@/ui/logger';
import { fetchGitHubLatestRelease } from './githubReleaseLookup';

type InstalledCli = Readonly<{
  command: string;
  source: AgentCliResolutionSource;
  readOnly?: true;
  version: string | null;
}>;

export type AgentCliUpdatesDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  sourcePolicy?: AgentCliSourcePolicy;
  nodePlatform?: string;
  buildContext?: CapabilitiesDetectContextBuilder;
  /** The agent's CLI descriptor, projected from its plugin manifest (`cli.install` update facts). */
  resolveRuntimeSpec?: (agentId: string) => AgentCliRuntimeDescriptor;
  fetchLatestVersion?: (
    runtimeSpec: AgentCliRuntimeDescriptor,
    installSource: AgentCliInstallSource,
    npmPackageName?: string,
  ) => Promise<AgentCliLatestVersionFacts>;
  latestVersionTtlMs?: number;
  signal?: AbortSignal;
  onProgress?: AgentInstallProgressCallback;
  installerDeps?: Parameters<typeof invokeAgentCliInstall>[0]['installerDeps'];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInstalledCli(data: unknown): InstalledCli | null {
  if (!isRecord(data) || data.available !== true || typeof data.resolvedPath !== 'string') return null;
  const source = data.resolutionSource;
  if (source !== 'system' && source !== 'managed' && source !== 'override') return null;
  return {
    command: data.resolvedPath,
    source,
    ...(data.resolutionReadOnly === true ? { readOnly: true as const } : {}),
    version: typeof data.version === 'string' ? data.version : null,
  };
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? 'a day' : `${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'an hour' : `${minutes / 60} hours`;
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/** Public capability probes expose update facts, never the daemon job's mutation path. */
export function withAgentCliUpdateFacts(cap: Capability, agentId: string, deps: AgentCliUpdatesDeps = {}): Capability {
  return { ...cap, detect: withAgentCliUpdates(cap, agentId, deps).detect };
}

/**
 * Adds agent-CLI update facts (contract K6) to a `cli.<agentId>` capability:
 *
 * - detect: `installSource`, `updateSupported`, `updateCommand` for the executable the capability
 *   reports, plus `latestVersion` when `includeLatestVersion` is requested (cached per daemon for
 *   the installables update-check interval; exhausted GitHub limits wait until their reset).
 * - invoke `install` with `intent: 'update'`: updates that exact executable through the agent
 *   install owner and succeeds only when a fresh detect reports a different version.
 *
 * Every other request passes through unchanged. The variation between agents lives in their
 * manifest facts, never in an agent-id branch here.
 */
export function withAgentCliUpdates(cap: Capability, agentId: string, deps: AgentCliUpdatesDeps = {}): Capability {
  const env = deps.env ?? process.env;
  const nodePlatform = deps.nodePlatform ?? process.platform;
  const platform = resolvePlatformFromNodePlatform(nodePlatform);
  const resolveRuntimeSpec = (): AgentCliRuntimeDescriptor | null => {
    try {
      return (deps.resolveRuntimeSpec ?? resolveAgentCliRuntimeSpecForLookupId)(agentId);
    } catch {
      return null;
    }
  };
  const fetchLatestVersion = deps.fetchLatestVersion
    ?? ((runtimeSpec: AgentCliRuntimeDescriptor, installSource: AgentCliInstallSource, npmPackageName?: string) =>
      fetchAgentCliLatestVersion({ runtimeSpec, installSource, npmPackageName, env, signal: deps.signal,
        deps: { fetchGitHubLatestRelease: (params) => fetchGitHubLatestRelease({ ...params,
          cacheTtlMs: deps.latestVersionTtlMs ?? configuration.installablesRuntimeAutoUpdateCheckIntervalMs }) },
      }));
  const latestVersionCache = new AsyncTtlCache<AgentCliLatestVersionFacts>({
    successTtlMs: deps.latestVersionTtlMs ?? configuration.installablesRuntimeAutoUpdateCheckIntervalMs,
    errorTtlMs: 0,
  });

  // Managed installs follow the release-age rule; external installs retain their
  // proven package, including when a user switches between legacy and current packages.
  const readLatestVersion = async (
    runtimeSpec: AgentCliRuntimeDescriptor,
    install: AgentCliUpdateFacts,
    bypassCache: boolean,
  ): Promise<AgentCliLatestVersionFacts | null> => {
    const load = async (): Promise<AgentCliLatestVersionFacts | null> => {
      try {
        return await fetchLatestVersion(runtimeSpec, install.installSource, install.npmPackageName);
      } catch (error) {
        deps.signal?.throwIfAborted();
        logger.debug(`[capabilities] latest version lookup failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };
    // GitHub reads (including refreshes) use the same owner as dependencies and
    // installers. This cache is only for npm's source-specific release-age facts.
    if (resolveAgentCliLatestVersionSource(runtimeSpec, install)?.kind === 'github_release') return load();
    const key = JSON.stringify([install.installSource === 'managed' ? 'managed' : 'registry', install.npmPackageName ?? null]);
    const cached = latestVersionCache.get(key);
    if (!bypassCache && cached?.kind === 'success' && latestVersionCache.isFresh(cached)) return cached.value;
    return await latestVersionCache.runDedupe(key, async () => {
      const facts = await load();
      if (facts) latestVersionCache.setSuccess(key, facts);
      return facts;
    });
  };

  const detect: Capability['detect'] = async (args) => {
    const data = await cap.detect(args);
    const installed = readInstalledCli(data);
    const runtimeSpec = installed && platform ? resolveRuntimeSpec() : null;
    if (!installed || !platform || !runtimeSpec || !isRecord(data)) return data;

    const params = args.request.params ?? {};
    const facts = classifyAgentCliInstall({
      runtimeSpec,
      command: installed.command,
      source: installed.source,
      ...(installed.readOnly ? { readOnly: installed.readOnly } : {}),
      platform,
      env,
    });
    return {
      ...data,
      installSource: facts.installSource,
      updateSupported: facts.updateSupported,
      updateCommand: facts.updateCommand,
      ...(params.includeLatestVersion === true
        ? { latestVersion: (await readLatestVersion(runtimeSpec, facts, params.bypassCache === true))?.latestVersion ?? null }
        : {}),
    };
  };

  const detectFresh = async (): Promise<InstalledCli | null> => {
    // A fresh probe with the verification budget: the update's outcome is decided by this read.
    const request: CapabilityDetectRequest = { id: cap.descriptor.id, params: { bypassCache: true, verifyVersion: true } };
    const context = await (deps.buildContext ?? buildDetectContext)([request]);
    return readInstalledCli(await cap.detect({ request, context }));
  };

  const update = async (params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CapabilitiesInvokeResponse> => {
    signal?.throwIfAborted();
    const runtimeSpec = resolveRuntimeSpec();
    const before = await detectFresh();
    if (!before || !runtimeSpec) {
      return { ok: false, error: { message: `${agentId} is not installed on this machine.`, code: 'update-not-available' } };
    }

    const result = await invokeAgentCliInstall({
      agentId,
      runtimeSpec,
      params: {
        intent: 'update',
        updateTarget: { command: before.command, source: before.source },
        // Consent is explicit here: a vendor updater runs only after the person confirmed it.
        allowVendorRecipeExecution: params?.allowVendorRecipeExecution === true,
      },
      env,
      nodePlatform,
      sourcePolicy: deps.sourcePolicy,
      signal,
      onProgress: deps.onProgress,
      installerDeps: deps.installerDeps,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: { message: result.errorMessage, code: result.errorCode },
        ...(result.logPath ? { logPath: result.logPath } : {}),
      };
    }

    // The install changed what is on disk: no cached snapshot may answer the next detect.
    invalidateCliSnapshots();
    const after = await detectFresh();
    const afterInstall = after && platform
      ? classifyAgentCliInstall({ runtimeSpec, command: after.command, source: after.source, platform, env })
      : null;
    const afterInstallSource = afterInstall?.installSource ?? null;
    const latest = afterInstall ? await readLatestVersion(runtimeSpec, afterInstall, true) : null;
    if (after?.version && after.version === before.version) {
      const held = latest?.heldVersion ?? null;
      if (held && held.version !== after.version) {
        const age = describeAge(held.minimumReleaseAgeMs);
        return {
          ok: false,
          error: {
            message: `${held.version} is less than ${age} old; Happier installs it once it's ${age} old.`,
            code: 'update-held-by-release-age',
          },
          ...(result.logPath ? { logPath: result.logPath } : {}),
        };
      }
      // A clean run that left an installed version at or past the owner's latest is "already
      // up to date" (e.g. `claude update` → "Claude Code is up to date (2.1.283)").
      if (latest?.latestVersion && compareVersions(after.version, latest.latestVersion) >= 0) {
        return {
          ok: true,
          result: {
            previousVersion: before.version,
            version: after.version,
            latestVersion: latest.latestVersion,
            alreadyCurrent: true,
            installSource: afterInstallSource,
            logPath: result.logPath,
          },
        };
      }
    }
    if (!after?.version || after.version === before.version) {
      return {
        ok: false,
        error: {
          message: after?.version
            ? `The update finished, but ${agentId} still reports version ${after.version}.`
            : `The update finished, but ${agentId} no longer reports a version.`,
          code: 'update-not-verified',
        },
        ...(result.logPath ? { logPath: result.logPath } : {}),
      };
    }

    return {
      ok: true,
      result: {
        previousVersion: before.version,
        version: after.version,
        latestVersion: latest?.latestVersion ?? null,
        alreadyCurrent: false,
        installSource: afterInstallSource,
        logPath: result.logPath,
      },
    };
  };

  const invoke: Capability['invoke'] = async (args) => {
    if (args.method === 'install' && args.params?.intent === 'update') {
      return await update(args.params, args.signal ?? deps.signal);
    }
    if (cap.invoke) return await cap.invoke(args);
    return { ok: false, error: { message: `Unsupported method: ${args.method}`, code: 'unsupported-method' } };
  };

  return { ...cap, detect, invoke };
}
