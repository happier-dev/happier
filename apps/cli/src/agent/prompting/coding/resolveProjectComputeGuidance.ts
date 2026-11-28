import type { ProjectComputeAgentGuidanceInputV1 } from '@happier-dev/protocol/workspaces/projectAgentGuidanceV1';
import { isManagedWorkspaceRefV2, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkerDestinationV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { raceWithAbort } from '@happier-dev/cli-common/plugins/http';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { readProjectManifest } from '@/workspaces/projectSetup/projectManifestFile';

function formatDestinationLabel(destination: WorkerDestinationV1 | undefined): string | undefined {
  if (!destination) return undefined;
  return destination.kind === 'machine'
    ? destination.machineId
    : `pool ${destination.poolId} (${destination.selection})`;
}

/**
 * Best-effort checkout compute-guidance fact collector for coding sessions.
 *
 * Reuses the already-resolved `workspaceRef` (or known `workspaceId`) when
 * available, reads local `.happier/project.json` portable script declarations,
 * and opportunistically reads saved worker preferences under a bounded timeout
 * reusing the canonical session HTTP budget without ever blocking or failing
 * session startup.
 */
export async function resolveSessionProjectComputeGuidance(params: Readonly<{
  directory?: string | null;
  serverId: string;
  machineId: string;
  workspaceRef?: WorkspaceRefV1 | null;
  workspaceId?: string | null;
  credentials?: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
  signal?: AbortSignal;
  /** Optional bound override (defaults to canonical `configuration.sessionControlHttpTimeoutMs`). */
  timeoutMs?: number;
}>): Promise<ProjectComputeAgentGuidanceInputV1 | null> {
  if (params.signal?.aborted) return null;
  const directory = typeof params.directory === 'string' ? params.directory.trim() : '';
  const machineWorkspaceRef = params.workspaceRef && !isManagedWorkspaceRefV2(params.workspaceRef)
    ? params.workspaceRef
    : null;
  const workspaceId = machineWorkspaceRef?.id ?? (
    typeof params.workspaceId === 'string' && params.workspaceId.trim().length > 0
      ? params.workspaceId.trim()
      : null
  );
  const workspaceServerId = machineWorkspaceRef?.serverId ?? params.serverId;
  const rootPath = machineWorkspaceRef?.rootPath ?? directory;
  if (!rootPath) return null;

  const timeoutMs = params.timeoutMs ?? configuration.sessionControlHttpTimeoutMs;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const requestSignal = params.signal && timeoutSignal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : params.signal ?? timeoutSignal;

  const [manifestResult, preferenceResult] = await Promise.all([
    directory
      ? readProjectManifest({ root: directory }).catch(() => null)
      : Promise.resolve(null),
    workspaceId && params.credentials
      ? (async () => {
          try {
            const fetchPreference = async () => {
              const client = await createAccountServerWorkspaceWorkerPreferenceClient({
                token: params.credentials!.token,
                credentials: params.credentials,
                serverHttpBaseUrl: params.operationContext?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
                signal: requestSignal,
                encryptionModeUsage: 'identity',
                context: { surface: 'agent' },
                actionId: 'projects.worker.preferences.get',
                operationContext: params.operationContext,
                resolveRequestHeaders: () => ({ Authorization: `Bearer ${params.credentials!.token}` }),
              });
              if (!client) return null;
              return await client.get({
                workspace: { serverId: workspaceServerId, refId: workspaceId },
              });
            };
            return await raceWithAbort(fetchPreference(), requestSignal);
          } catch {
            return null;
          }
        })()
      : Promise.resolve(null),
  ]);

  if (params.signal?.aborted) return null;

  const portableScripts = manifestResult?.document?.status === 'valid'
    ? Object.entries(manifestResult.document.manifest.scripts ?? {})
        .filter(([, declaration]) => declaration.execution === 'portable')
        .map(([name]) => ({ name }))
    : [];

  const readyPreference = preferenceResult?.status === 'ready' ? preferenceResult.preference : null;
  const workerPreferences = readyPreference
    ? {
        enabled: readyPreference.enabled,
        allowAdHoc: readyPreference.allowAdHoc,
        ...(formatDestinationLabel(readyPreference.destination)
          ? { destinationLabel: formatDestinationLabel(readyPreference.destination) }
          : {}),
        unavailable: readyPreference.unavailable,
      }
    : { enabled: false, allowAdHoc: false };

  if (portableScripts.length === 0 && !workerPreferences.enabled) {
    return null;
  }

  return {
    workspace: {
      serverId: workspaceServerId,
      ...(workspaceId ? { workspaceId } : {}),
      machineId: machineWorkspaceRef?.machineId ?? params.machineId,
      rootPath,
    },
    portableScripts,
    workerPreferences,
  };
}
