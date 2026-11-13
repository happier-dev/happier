import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { configuration } from '@/configuration';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { resolveReviewCommentHostPluginAuthority, type ReviewCommentHostPluginAuthority } from './hostActionMaterializer';

export type ReviewHostPluginAuthority = ReviewCommentHostPluginAuthority & Readonly<{
  caller: PluginMachineMaterializationRefV1 | null;
}>;
export type ReviewHostPluginAuthorityReader = (pluginId: string) => Promise<ReviewHostPluginAuthority | null>;

/** Read serving authority, never a retained executable snapshot's historical grant. */
export async function readCurrentReviewHostPluginAuthority(
  pluginId: string,
  controller?: PluginReloadController,
): Promise<ReviewHostPluginAuthority | null> {
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller });
    const authority = resolveReviewCommentHostPluginAuthority({ pluginId,
      current: lease.registry.pluginFinalPolicyCurrentRuntimesById?.get(pluginId) ?? null,
      sourceCustody: lease.registry.readPluginSourceCustody?.(pluginId) ?? null });
    if (!authority) return null;
    const caller = lease.registry.resolveCurrentPluginMaterializationRef?.(pluginId) ?? null;
    return { ...authority, caller: caller?.pluginId === pluginId ? caller : null };
  } catch {
    return null;
  } finally {
    await lease?.release();
  }
}

/** Session composition binds this reader to its existing tracked-runner service. */
export function createRunnerReviewHostPluginAuthorityReader(sessionId: string): ReviewHostPluginAuthorityReader {
  const environment = sessionProcessEnvironment();
  return async pluginId => {
    const path = environment[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
    if (!path) return null;
    try {
      const current = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: sessionId });
      if (!current) return null;
      const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({
        authority: { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          path, sessionId, runner: current.runner, retainedAgent: current.retainedAgent },
        timeoutMs: null,
        createRequest: token => ({ v: 1, context: { token, sessionId },
          operation: { kind: 'execution_run.review_plugin_authority.resolve_v1', pluginId } }),
      });
      return response.ok && response.result.kind === 'execution_run.review_plugin_authority'
        ? response.result.authority : null;
    } catch {
      return null;
    }
  };
}
