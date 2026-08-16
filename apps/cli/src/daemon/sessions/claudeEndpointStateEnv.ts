import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import {
  evaluateTerminalHostLivenessForRecovery,
} from '@/integrations/terminalHost/livenessPolicy';
import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  readClaudeEndpointDescriptor as readDefaultClaudeEndpointDescriptor,
  type AttachmentBoundClaudeEndpointState,
} from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';
import {
  resolveClaudeAdoptEndpointRecoveryForState as resolveDefaultClaudeAdoptEndpointRecoveryForState,
  type ClaudeAdoptEndpointRecovery,
} from '@/backends/claude/endpointRecovery/claudeEndpointRecovery';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/backends/catalog';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import {
  executeConfirmedDeadTerminalAttachmentRetirement,
  executeTerminalHostDisposition,
} from '@/terminal/attachment/terminalHostDisposition';
import { buildLegacyTerminalAttachmentHostHandle } from '@/terminal/attachment/legacyTerminalAttachmentHandle';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { logger } from '@/ui/logger';
import {
  requireExactTerminalControlServiceabilityRetirement,
  type ExactTerminalControlServiceabilityRetirement,
} from './retireTerminalControlServiceability';

import {
  readSessionMarkerForPid as readDefaultSessionMarkerForPid,
  type DaemonSessionMarker,
} from '../sessionRegistry';

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

export type ClaudeEndpointRecoveryFenceReason =
  | 'live_attachment_adoption_unavailable'
  | 'recovery_probe_inconclusive'
  | 'serviceability_retirement_failed';

export class ClaudeEndpointRecoveryFenceError extends Error {
  readonly code = 'claude_endpoint_recovery_fenced';

  constructor(readonly reason: ClaudeEndpointRecoveryFenceReason) {
    super(reason === 'recovery_probe_inconclusive'
      ? 'Claude terminal attachment liveness could not be established safely'
      : reason === 'serviceability_retirement_failed'
        ? 'Claude terminal attachment retirement could not be committed safely'
        : 'Claude terminal attachment is alive but its exact adoption proof is unavailable');
    this.name = 'ClaudeEndpointRecoveryFenceError';
  }
}

function isClaudeSpawnOptions(spawnOptions: SpawnSessionOptions): boolean {
  return spawnOptions.backendTarget?.kind === 'builtInAgent'
    && spawnOptions.backendTarget.agentId === 'claude';
}

export function buildClaudeEndpointStateEnvironmentVariables(
  state: AttachmentBoundClaudeEndpointState,
): Record<string, string> {
  return {
    [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(state),
  };
}

export function mergeClaudeEndpointStateIntoSpawnOptions(
  spawnOptions: SpawnSessionOptions,
  state: AttachmentBoundClaudeEndpointState | null | undefined,
): SpawnSessionOptions {
  if (!state || !isClaudeSpawnOptions(spawnOptions)) return spawnOptions;
  return {
    ...spawnOptions,
    environmentVariables: {
      ...(spawnOptions.environmentVariables ?? {}),
      ...buildClaudeEndpointStateEnvironmentVariables(state),
    },
  };
}

function clearClaudeEndpointStateFromSpawnOptions(spawnOptions: SpawnSessionOptions): SpawnSessionOptions {
  const environmentVariables = spawnOptions.environmentVariables;
  if (!environmentVariables || !(HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY in environmentVariables)) {
    return spawnOptions;
  }
  const {
    [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: _staleClaudeEndpointState,
    ...retainedEnvironmentVariables
  } = environmentVariables;
  return {
    ...spawnOptions,
    environmentVariables: retainedEnvironmentVariables,
  };
}

export async function resolveClaudeEndpointRecoverySpawnOptions(params: Readonly<{
  previousPid?: number;
  happyHomeDir?: string;
  sessionId: string;
  defaultOptions: SpawnSessionOptions;
  readSessionMarkerForPid?: (pid: number) => Promise<DaemonSessionMarker | null>;
  readTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<TerminalAttachmentInfo | null>;
  readClaudeEndpointDescriptor?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentId: string;
  }>) => Promise<AttachmentBoundClaudeEndpointState | null>;
  removeTerminalAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId?: string;
    expectedLegacyAttachment?: Extract<TerminalAttachmentInfo, Readonly<{ version: 1 }>>;
    expectedTerminal?: TerminalAttachmentInfo['terminal'];
  }>) => Promise<boolean>;
  terminalHostAdapters?: TerminalHostAdapters;
  loadTerminalHostAdapters?: () => Promise<TerminalHostAdapters>;
  resolveAdoptEndpointRecovery?: (
    state: AttachmentBoundClaudeEndpointState,
  ) => Promise<ClaudeAdoptEndpointRecovery | null>;
  proveExactSessionRunnerAbsent?: () => Promise<boolean>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
}>): Promise<SpawnSessionOptions> {
  if (!isClaudeSpawnOptions(params.defaultOptions)) return params.defaultOptions;
  const freshSpawnOptions = clearClaudeEndpointStateFromSpawnOptions(params.defaultOptions);

  let happyHomeDir = params.happyHomeDir?.trim() || null;
  if (!happyHomeDir && params.previousPid !== undefined) {
    const readSessionMarkerForPid = params.readSessionMarkerForPid ?? readDefaultSessionMarkerForPid;
    const marker = await readSessionMarkerForPid(params.previousPid).catch(() => null);
    if (!marker || marker.happySessionId !== params.sessionId) return freshSpawnOptions;
    happyHomeDir = marker.happyHomeDir;
  }
  if (!happyHomeDir) return freshSpawnOptions;

  const readTerminalAttachmentInfo = params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo;
  const attachmentInfo = await readTerminalAttachmentInfo({
    happyHomeDir,
    sessionId: params.sessionId,
  });
  if (!attachmentInfo) return freshSpawnOptions;

  const endpointState = attachmentInfo.version === 2
    ? await (params.readClaudeEndpointDescriptor ?? readDefaultClaudeEndpointDescriptor)({
        happyHomeDir,
        sessionId: params.sessionId,
        attachmentId: attachmentInfo.attachmentId,
      })
    : null;

  const handle = attachmentInfo.version === 2
    ? attachmentInfo.handle
    : buildLegacyTerminalAttachmentHostHandle(attachmentInfo, happyHomeDir);
  if (!handle) return freshSpawnOptions;

  const terminalHostAdapters = params.terminalHostAdapters ?? await params.loadTerminalHostAdapters?.();
  const adapter = terminalHostAdapters?.[handle.kind];
  if (!adapter) return freshSpawnOptions;
  const beforeDescriptorRetirement = params.retireExactTerminalControlServiceability
    ? async ({ attachmentInfo: currentAttachmentInfo }: Readonly<{
        attachmentInfo: BoundTerminalAttachmentInfo;
      }>): Promise<void> => {
        const retirement = await params.retireExactTerminalControlServiceability!({
          happyHomeDir,
          sessionId: params.sessionId,
          attachmentInfo: currentAttachmentInfo,
        });
        requireExactTerminalControlServiceabilityRetirement(retirement);
      }
    : undefined;

  const probe = await evaluateTerminalHostLivenessForRecovery(adapter, handle);
  if (probe.status === 'alive') {
    if (
      attachmentInfo.version !== 2
      || !endpointState
      || endpointState.attachmentId !== attachmentInfo.attachmentId
    ) {
      throw new ClaudeEndpointRecoveryFenceError('live_attachment_adoption_unavailable');
    }
    const adoptEndpointRecovery = await (
      params.resolveAdoptEndpointRecovery ?? resolveDefaultClaudeAdoptEndpointRecoveryForState
    )(endpointState).catch(() => null);
    if (adoptEndpointRecovery) {
      return mergeClaudeEndpointStateIntoSpawnOptions(freshSpawnOptions, endpointState);
    }

    const exactSessionRunnerAbsent = await params.proveExactSessionRunnerAbsent?.().catch(() => false) ?? false;
    if (!exactSessionRunnerAbsent) {
      throw new ClaudeEndpointRecoveryFenceError('live_attachment_adoption_unavailable');
    }

    const disposition = await executeTerminalHostDisposition({
      happyHomeDir,
      sessionId: params.sessionId,
      expectedAttachmentId: attachmentInfo.attachmentId,
      intent: { kind: 'destroy_owned_host', reason: 'unrecoverable_control_recovery' },
      adapter,
      readAttachmentInfo: params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo,
      removeAttachmentInfo: params.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo,
      beforeDescriptorRetirement,
    }).catch(() => ({ status: 'parked' as const, reason: 'destroy_failed' as const }));
    if (disposition.status !== 'destroyed' || disposition.descriptorRetained) {
      throw new ClaudeEndpointRecoveryFenceError('live_attachment_adoption_unavailable');
    }
    await (params.onExactTerminalAttachmentRetired ?? notifyTerminalAttachmentRetiredThroughCatalog)({
      happyHomeDir,
      sessionId: params.sessionId,
      attachmentInfo,
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Unusable terminal host destroyed; Claude endpoint cleanup remains pending', {
        sessionId: params.sessionId,
        attachmentId: attachmentInfo.attachmentId,
        error,
      });
    });
    return freshSpawnOptions;
  }

  if (probe.status === 'inconclusive') {
    throw new ClaudeEndpointRecoveryFenceError('recovery_probe_inconclusive');
  }

  if (probe.status === 'dead') {
    const disposition = await executeConfirmedDeadTerminalAttachmentRetirement({
      happyHomeDir,
      sessionId: params.sessionId,
      expectedAttachmentInfo: attachmentInfo,
      readAttachmentInfo: params.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo,
      removeAttachmentInfo: params.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo,
      ...(attachmentInfo.version === 2 && beforeDescriptorRetirement
        ? { beforeDescriptorRetirement }
        : {}),
    }).catch(() => ({ status: 'parked' as const, reason: 'destroy_failed' as const }));
    if (disposition.status !== 'retired') {
      throw new ClaudeEndpointRecoveryFenceError('serviceability_retirement_failed');
    }
    if (attachmentInfo.version === 2) {
      await (params.onExactTerminalAttachmentRetired ?? notifyTerminalAttachmentRetiredThroughCatalog)({
        happyHomeDir,
        sessionId: params.sessionId,
        attachmentInfo,
      }).catch((error) => {
        logger.debug('[DAEMON RUN] Terminal host retired; Claude endpoint cleanup remains pending', {
          sessionId: params.sessionId,
          attachmentId: attachmentInfo.attachmentId,
          error,
        });
      });
    }
  }

  return freshSpawnOptions;
}
