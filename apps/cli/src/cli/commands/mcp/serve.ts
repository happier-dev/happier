import { assertResolvedHomeTargetIdentity } from '@happier-dev/cli-common/homeTarget';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { reloadConfiguration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { enableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';
import {
  applyResolvedServerSelection,
  type EphemeralResolvedServerSelection,
} from '@/server/serverSelection';

import type { McpCommandDeps } from './deps';

function clearServerSelectionEnvOverrides(): void {
  delete process.env.HAPPIER_SERVER_URL;
  delete process.env.HAPPIER_LOCAL_SERVER_URL;
  delete process.env.HAPPIER_PUBLIC_SERVER_URL;
  delete process.env.HAPPIER_WEBAPP_URL;
  delete process.env.HAPPIER_ACTIVE_SERVER_ID;
}

export async function runMcpServeCommand(
  argv: readonly string[],
  deps: McpCommandDeps,
  explicitServerSelection?: EphemeralResolvedServerSelection,
): Promise<void> {
  enableMcpStdioConsolePatch();

  clearServerSelectionEnvOverrides();
  reloadConfiguration();
  if (explicitServerSelection) {
    const target = explicitServerSelection.homeTarget;
    await applyResolvedServerSelection({
      ...explicitServerSelection,
      serverUrl: target.canonicalAuthUrl,
      localServerUrl: target.applicationUrl === target.canonicalAuthUrl
        ? null
        : target.applicationUrl,
    });
    if (target.homeServerIdentityId) {
      const snapshot = await (deps.observeServerFeaturesSnapshot ?? observeServerFeaturesSnapshot)({
        serverUrl: target.applicationUrl,
        projection: 'public',
      });
      const observedIdentity = snapshot.status === 'ready'
        ? normalizeServerIdentityIdCapability(
            snapshot.features.capabilities.serverIdentity?.serverIdentityId,
          )
        : null;
      assertResolvedHomeTargetIdentity(target, observedIdentity ?? '');
    }
  }

  const defaultSessionId = readFlagValue(argv, '--session');
  const credentials = await deps.readStoredCredentials();
  if (!credentials) {
    throw new Error('not_authenticated');
  }
  const { machineId } = await deps.ensureMachineIdForCredentials(credentials);
  const accountSettingsContext = await deps.bootstrapAccountSettingsContext({
    credentials,
    mode: 'blocking',
    refresh: 'force',
    honorAccountSettingsModeEnv: false,
  });

  try {
    const actionsSettings = accountSettingsContext.settings.actionsSettingsV1;
    if (actionsSettings && typeof actionsSettings === 'object') {
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify(actionsSettings);
    } else {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    }
  } catch {
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  }

  const daemonControlTarget = explicitServerSelection
    ? await deps.resolveLiveDaemonControlTargetForServer?.(
        explicitServerSelection.activeServerId,
      ).catch(() => null) ?? null
    : undefined;
  const serverFeaturesSnapshot = deps.fetchServerFeaturesSnapshot
    ? await deps.fetchServerFeaturesSnapshot({
        serverUrl: resolveServerHttpBaseUrl(),
        token: credentials.token,
      })
    : undefined;
  const daemonCatalog = explicitServerSelection && !daemonControlTarget
    ? { kind: 'unavailable' as const, code: 'daemon_unavailable' }
    : await deps.readDaemonPluginCatalog?.(
        daemonControlTarget ? { target: daemonControlTarget } : undefined,
      ).catch(() => ({
        kind: 'unavailable' as const,
        code: 'daemon_unavailable',
      }));
  const createExternalMcpServer = deps.createExternalMcpServer
    ?? (await import('@/mcp/createExternalMcpServer')).createExternalMcpServer;
  const { mcp } = createExternalMcpServer({
    credentials,
    defaultSessionId,
    machineId,
    pluginToolCatalog: daemonCatalog?.kind === 'available'
      ? daemonCatalog.tools
      : Object.freeze([]),
    ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
    ...(explicitServerSelection ? { daemonControlTarget } : {}),
  });

  await deps.connectMcpStdio(mcp);
}
