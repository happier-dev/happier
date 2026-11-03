import type { AgentId, ProviderCliInstallSource } from '@happier-dev/agents';
import {
  classifyProviderCliInstall,
  fetchProviderCliLatestVersion,
  resolvePlatformFromNodePlatform,
  type ProviderCliLatestVersionFacts,
  type ProviderCliResolutionSource,
  type ProviderCliUpdateFacts,
} from '@happier-dev/cli-common/providers';
import { AsyncTtlCache } from '@happier-dev/protocol';
import { compareVersions } from '@happier-dev/cli-common/update';

import { configuration } from '@/configuration';
import { buildDetectContext } from '@/capabilities/context/buildDetectContext';
import { invalidateCliSnapshots } from '@/capabilities/snapshots/cliSnapshot';
import type { Capability, CapabilitiesDetectContextBuilder } from '@/capabilities/service';
import type { CapabilitiesInvokeResponse, CapabilityDetectRequest } from '@/capabilities/types';
import { invokeProviderCliInstall } from '@/runtime/managedTools/invokeProviderCliInstall';
import { logger } from '@/ui/logger';

type InstalledCli = Readonly<{
  command: string;
  source: ProviderCliResolutionSource;
  version: string | null;
}>;

export type ProviderCliUpdatesDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  nodePlatform?: string;
  buildContext?: CapabilitiesDetectContextBuilder;
  installProviderCli?: Parameters<typeof invokeProviderCliInstall>[0]['installProviderCli'];
  fetchLatestVersion?: (agentId: AgentId, installSource: ProviderCliInstallSource, npmPackageName?: string) => Promise<ProviderCliLatestVersionFacts>;
  latestVersionTtlMs?: number;
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
    version: typeof data.version === 'string' ? data.version : null,
  };
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % (24 * 60) === 0) return minutes === 24 * 60 ? 'a day' : `${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'an hour' : `${minutes / 60} hours`;
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/**
 * Adds agent-CLI update facts (contract K6) to a `cli.<agentId>` capability:
 *
 * - detect: `installSource`, `updateSupported`, `updateCommand` for the executable the
 *   capability reports, plus `latestVersion` when `includeLatestVersion` is requested
 *   (cached per daemon for the installables update-check interval; failures are not cached).
 * - invoke `install` with `intent: 'update'`: updates that exact executable through the
 *   provider install owner and succeeds only when a fresh detect reports a different version.
 *
 * Every other request passes through unchanged, so provider-specific capabilities keep
 * their own detect/invoke behavior.
 */
export function withProviderCliUpdates(cap: Capability, agentId: AgentId, deps: ProviderCliUpdatesDeps = {}): Capability {
  const env = deps.env ?? process.env;
  const nodePlatform = deps.nodePlatform ?? process.platform;
  const platform = resolvePlatformFromNodePlatform(nodePlatform);
  const fetchLatestVersion = deps.fetchLatestVersion
    ?? ((id: AgentId, installSource: ProviderCliInstallSource, npmPackageName?: string) => fetchProviderCliLatestVersion({ providerId: id, installSource, npmPackageName, env }));
  const latestVersionCache = new AsyncTtlCache<ProviderCliLatestVersionFacts>({
    successTtlMs: deps.latestVersionTtlMs ?? configuration.installablesRuntimeAutoUpdateCheckIntervalMs,
    errorTtlMs: 0,
  });

  // Managed installs follow the release-age rule; external installs retain their
  // proven package, including when a user switches between legacy and current packages.
  const readLatestVersion = async (
    install: ProviderCliUpdateFacts,
    bypassCache: boolean,
  ): Promise<ProviderCliLatestVersionFacts | null> => {
    const key = JSON.stringify([install.installSource === 'managed' ? 'managed' : 'registry', install.npmPackageName ?? null]);
    const cached = latestVersionCache.get(key);
    if (!bypassCache && cached?.kind === 'success' && latestVersionCache.isFresh(cached)) return cached.value;
    return await latestVersionCache.runDedupe(key, async () => {
      try {
        const facts = await fetchLatestVersion(agentId, install.installSource, install.npmPackageName);
        latestVersionCache.setSuccess(key, facts);
        return facts;
      } catch (error) {
        logger.debug(`[capabilities] latest version lookup failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
  };

  const detect: Capability['detect'] = async (args) => {
    const data = await cap.detect(args);
    const installed = readInstalledCli(data);
    if (!installed || !platform || !isRecord(data)) return data;

    const params = args.request.params ?? {};
    const facts = classifyProviderCliInstall({
      providerId: agentId,
      command: installed.command,
      source: installed.source,
      platform,
      env,
    });
    return {
      ...data,
      installSource: facts.installSource,
      updateSupported: facts.updateSupported,
      updateCommand: facts.updateCommand,
      ...(params.includeLatestVersion === true
        ? { latestVersion: (await readLatestVersion(facts, params.bypassCache === true))?.latestVersion ?? null }
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
    const before = await detectFresh();
    if (!before) {
      return { ok: false, error: { message: `${agentId} is not installed on this machine.`, code: 'update-not-available' } };
    }

    const result = await invokeProviderCliInstall({
      agentId,
      params: {
        intent: 'update',
        updateTarget: { command: before.command, source: before.source },
        allowVendorRecipeExecution: params?.allowVendorRecipeExecution === true,
      },
      env,
      nodePlatform,
      signal,
      ...(deps.installProviderCli ? { installProviderCli: deps.installProviderCli } : {}),
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
      ? classifyProviderCliInstall({ providerId: agentId, command: after.command, source: after.source, platform, env })
      : null;
    const afterInstallSource = afterInstall?.installSource ?? null;
    const latest = afterInstall ? await readLatestVersion(afterInstall, true) : null;
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
      return await update(args.params, args.signal);
    }
    if (cap.invoke) return await cap.invoke(args);
    return { ok: false, error: { message: `Unsupported method: ${args.method}`, code: 'unsupported-method' } };
  };

  return { ...cap, detect, invoke };
}
