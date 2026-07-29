import { isDeepStrictEqual } from 'node:util';

import {
  PluginLocalServicesBridgeControlRequestV1Schema,
  PluginLocalServicesBridgeControlResponseV1Schema,
  type PluginLocalServicesBridgeControlRequestV1,
  type PluginLocalServicesBridgeControlResponseV1,
} from '@/daemon/local/services/pluginBridgeProtocol';
import type { DaemonResolvedToolV1 } from '@/daemon/spawnHooks';
import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createPluginExecService } from '@/plugins/runtime/exec/hostService';
import { createAllowedEnvKeySet, isAllowedEnvKey } from '@/utils/env/envKeyAllowlist';
import {
  createProviderErrorV1,
  parseProviderContributionIdentityV1,
} from '@happier-dev/protocol';

export type ProviderManagedLocalServicesDispatchInput = Readonly<{
  request: PluginLocalServicesBridgeControlRequestV1;
  resolvedTool: Extract<DaemonResolvedToolV1, { ok: true }>;
  expected: Readonly<{
    machineId: string;
    pluginId: string;
    contributionKey: string;
    providerName: string;
    fixedArgs: readonly string[];
  }>;
}>;

export type ProviderManagedLocalServicesDispatch = (
  input: ProviderManagedLocalServicesDispatchInput,
) => Promise<PluginLocalServicesBridgeControlResponseV1>;

const PROVIDER_MANAGED_LOCAL_SERVICE_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERNAME',
]);

export function selectProviderManagedLocalServicesEnvironment(
  processEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  const allowedKeys = createAllowedEnvKeySet(PROVIDER_MANAGED_LOCAL_SERVICE_ENV_KEYS, platform);
  const selectedEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (
      isAllowedEnvKey(key, allowedKeys, platform)
      && typeof value === 'string'
      && value.length > 0
    ) {
      selectedEnvironment[key] = value;
    }
  }
  return Object.freeze(selectedEnvironment);
}

export function createProviderManagedLocalServicesExec(input: Readonly<{
  processEnv: Readonly<Record<string, string | undefined>>;
  executablePath: string;
  signal?: AbortSignal;
  allowPathRuntimeNames?: readonly string[];
}>): ReturnType<typeof createPluginExecService> {
  return createPluginExecService({
    baseEnv: selectProviderManagedLocalServicesEnvironment(input.processEnv),
    allowedExecutablePaths: [input.executablePath],
    signal: input.signal,
    allowPathRuntimeNames: input.allowPathRuntimeNames,
  });
}

export function createProviderManagedLocalServicesDispatch(input: Readonly<{
  startTrusted: LocalServicesDaemonRuntime['trustedManagedLocalServices']['start'];
  processEnv: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  allowPathRuntimeNames?: readonly string[];
}>): ProviderManagedLocalServicesDispatch {
  return async ({ request, resolvedTool, expected }) => {
    if (!expected) {
      return { ok: false, errorCode: 'managed_service_executable_authorization_invalid' };
    }
    const operation = request.operation;
    const expectedRequest = buildManagedProviderStartRequest({
      ...expected,
      executablePath: resolvedTool.command,
      executableArgs: resolvedTool.args,
    });
    if (
      operation.kind !== 'start'
      || !isDeepStrictEqual(request, expectedRequest)
    ) {
      return { ok: false, errorCode: 'managed_service_executable_authorization_invalid' };
    }
    const snapshot = await input.startTrusted({
      context: expectedRequest.context,
      declaration: operation.declaration,
      exec: createProviderManagedLocalServicesExec({
        processEnv: input.processEnv,
        executablePath: resolvedTool.command,
        signal: input.signal,
        allowPathRuntimeNames: input.allowPathRuntimeNames,
      }),
    });
    return PluginLocalServicesBridgeControlResponseV1Schema.parse({ ok: true, snapshot });
  };
}

export function createManagedProviderStart(input: Readonly<{
  resolveSystemTool: (request: Readonly<{
    toolId: string;
    lookupNames: readonly string[];
    reason: string;
  }>) => Promise<DaemonResolvedToolV1>;
  dispatch: ProviderManagedLocalServicesDispatch;
}>): (request: Readonly<{
  machineId: string;
  contributionKey: string;
  pluginId: string;
  providerName: string;
  lookupNames: readonly string[];
  fixedArgs: readonly string[];
}>) => Promise<Readonly<{ status: 'detecting' | 'running' }>> {
  return async (request) => {
    const resolved = await input.resolveSystemTool({
      toolId: `provider-managed-start:${request.contributionKey}`,
      lookupNames: request.lookupNames,
      reason: 'provider managed local start',
    });
    if (!resolved.ok) {
      throw createProviderErrorV1('provider_endpoint_unavailable', { machineId: request.machineId });
    }
    const bridgeRequest = buildManagedProviderStartRequest({
      machineId: request.machineId,
      pluginId: request.pluginId,
      contributionKey: request.contributionKey,
      providerName: request.providerName,
      executablePath: resolved.command,
      executableArgs: resolved.args,
      fixedArgs: request.fixedArgs,
    });
    let response: PluginLocalServicesBridgeControlResponseV1;
    try {
      response = await input.dispatch({
        request: bridgeRequest,
        resolvedTool: resolved,
        expected: {
          machineId: request.machineId,
          pluginId: request.pluginId,
          contributionKey: request.contributionKey,
          providerName: request.providerName,
          fixedArgs: request.fixedArgs,
        },
      });
    } catch {
      throw createProviderErrorV1('provider_endpoint_unavailable', { machineId: request.machineId });
    }
    const phase = response.ok ? response.snapshot?.phase : null;
    if (phase !== 'detecting' && phase !== 'running' && phase !== 'unhealthy') {
      throw createProviderErrorV1('provider_endpoint_unavailable', { machineId: request.machineId });
    }
    return { status: phase === 'detecting' ? 'detecting' : 'running' };
  };
}

export function buildManagedProviderStartRequest(input: Readonly<{
  machineId: string;
  pluginId: string;
  contributionKey: string;
  providerName: string;
  executablePath: string;
  executableArgs: readonly string[];
  fixedArgs: readonly string[];
}>): PluginLocalServicesBridgeControlRequestV1 {
  const parsedIdentity = parseProviderContributionIdentityV1(input.contributionKey);
  if (!parsedIdentity || parsedIdentity.identity.pluginId !== input.pluginId) {
    throw new TypeError('Managed Provider start requires one exact Provider contribution identity');
  }
  return PluginLocalServicesBridgeControlRequestV1Schema.parse({
    protocolVersion: 1,
    context: {
      pluginId: input.pluginId,
      contributionId: parsedIdentity.identity.localId,
      sessionId: `provider-local:${input.machineId}`,
      title: input.providerName,
    },
    operation: {
      kind: 'start',
      declaration: {
        id: 'provider-managed',
        launch: {
          kind: 'binary',
          executablePath: input.executablePath,
          args: [...input.executableArgs, ...input.fixedArgs],
        },
        launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
        hostPolicy: { kind: 'loopback' },
        name: { strategy: 'derived', base: input.providerName },
        healthCheck: { kind: 'none' },
        restart: { kind: 'never' },
        cleanup: { staleAfterMs: 60_000 },
      },
    },
  });
}
