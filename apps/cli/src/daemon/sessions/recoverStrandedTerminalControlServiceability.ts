import { isPidProvablyAbsent } from '@happier-dev/cli-common/process';
import type { TerminalHostAdapter } from '@happier-dev/agents';
import { SessionTerminalMetadataSchema } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { probeTerminalHostForRecovery } from '@/integrations/terminal/host/recoveryLiveness';
import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { buildTerminalHostProbeHandleFromMetadata } from '@/terminal/runtime/terminalMetadata';
import { incompleteStopSession, type StopSessionResult } from './stopSessionContract';
import { verifySessionMetadataMutationCurrentness, type SessionMetadataMutationCurrentness } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { TerminalControlServiceabilityRetirementTarget } from './retireTerminalControlServiceability';
import { readRetiredPlainRunnerObservation } from './plainRunnerRetirement';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { configuration } from '@/configuration';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export async function recoverStrandedTerminalControlServiceability(params: Readonly<{
  credentials: StoredCredentials;
  currentMachineId: string;
  sessionId: string;
  currentness?: SessionMetadataMutationCurrentness;
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionByIdCompat>[0]['resolveAuthorizationHeaders'];
  expectedAttachmentId?: string;
  /** Explicit Stop request evidence; observational recovery leaves lifecycle unchanged. */
  stoppedAt?: number;
  loadTerminalHostAdapters: () => Promise<Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>>;
  fetchSession?: typeof fetchSessionByIdCompat;
  resolveAccountEncryptionMode?: (token: string) => Promise<'plain' | 'e2ee'>;
  retireExactTerminalControlServiceability: (input: Readonly<{
    sessionId: string;
    stoppedAt?: number;
  }> & TerminalControlServiceabilityRetirementTarget) => Promise<'retired' | 'superseded'>;
}>): Promise<StopSessionResult | null> {
  const currentMachineId = params.currentMachineId.trim();
  if (!currentMachineId) return null;
  const fetchSession = params.fetchSession ?? fetchSessionByIdCompat;
  await verifySessionMetadataMutationCurrentness(params.currentness);
  const headers = params.resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' });
  if (params.resolveAuthorizationHeaders && !headers) throw new Error('Terminal recovery Account authorization unavailable');
  const resolveAccountEncryptionMode = params.resolveAccountEncryptionMode
    ?? (async (token: string) => (await fetchAccountEncryptionCurrentness({ token,
      ...(headers ? { authorizationHeaders: headers } : {}) })).mode);
  const [rawSession, accountEncryptionMode] = await Promise.all([
    fetchSession({ reason: 'session-control', token: params.credentials.token, sessionId: params.sessionId,
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}) }),
    resolveAccountEncryptionMode(params.credentials.token),
  ]);
  await verifySessionMetadataMutationCurrentness(params.currentness);
  if (!rawSession) return null;
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    accountEncryptionMode,
    rawSession,
  });
  if (!metadata || readNonEmptyString(metadata.machineId) !== currentMachineId) return null;

  const parsedTerminal = SessionTerminalMetadataSchema.safeParse(metadata.terminal);
  // createSessionMetadata omits terminal when no terminal runtime was requested.
  if (metadata.terminal === undefined || (parsedTerminal.success && parsedTerminal.data.mode === 'plain')) {
    if (params.expectedAttachmentId) return incompleteStopSession('attachment_mismatch');
    const pid = metadata.hostPid;
    let target: TerminalControlServiceabilityRetirementTarget;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      const expectedPlainRetirement = readRetiredPlainRunnerObservation(metadata);
      // Failed startup can leave an inactive Session before any runner or
      // control projection exists. There is nothing to retire in that case.
      const inactiveWithoutRunner = rawSession.active === false
        && pid === undefined && metadata.hostProcessStartTimeMs === undefined
        && (metadata.terminal === undefined
          || parsedTerminal.success && parsedTerminal.data.controlServiceabilityV1 === undefined);
      if (expectedPlainRetirement === null && !inactiveWithoutRunner) return incompleteStopSession('missing_topology_proof');
      if (params.stoppedAt === undefined || expectedPlainRetirement === null) {
        const attachment = await readTerminalHostAttachmentState({
          happyHomeDir: configuration.happyHomeDir, sessionId: params.sessionId,
        });
        return attachment.status === 'absent' ? { status: 'stopped' } : incompleteStopSession('missing_topology_proof');
      }
      target = { terminalMode: 'plain', expectedPlainRetirement };
    } else {
      // Only the owning machine can prove this runner absent. The RPC server captures
      // publisher authority before Stop and fences the inactive transition after this proof.
      if (!isPidProvablyAbsent(pid)) {
        // A session host outlives each hosted Session, so its retained hostPid stays live.
        // `stopped` is published only after this Session's own end (Stop retirement or
        // clean runner exit); an inactive stopped Session has nothing left to stop.
        return rawSession.active === false && metadata.lifecycleState === 'stopped'
          ? { status: 'stopped' }
          : incompleteStopSession('tracked_runner_absent');
      }
      target = { terminalMode: 'plain', expectedRunner: { pid,
        ...(typeof metadata.hostProcessStartTimeMs === 'number' ? { startTimeMs: metadata.hostProcessStartTimeMs } : {}) } };
    }
    if (params.stoppedAt === undefined) return { status: 'stopped' };
    try {
      const retirement = await params.retireExactTerminalControlServiceability({
        sessionId: params.sessionId, stoppedAt: params.stoppedAt, ...target,
      });
      return retirement === 'retired' ? { status: 'stopped' } : incompleteStopSession('attachment_mismatch');
    } catch {
      return incompleteStopSession('terminal_control_serviceability_retirement_failed');
    }
  }
  if (!parsedTerminal.success) return null;
  const terminal = parsedTerminal.data;
  const serviceability = terminal.controlServiceabilityV1;
  const attachmentId = readNonEmptyString(serviceability?.attachmentId);
  const expectedAttachmentId = readNonEmptyString(params.expectedAttachmentId);
  if (
    !serviceability
    || serviceability.v !== 1
    || !attachmentId
    || (serviceability.retired !== true
      && serviceability.state !== 'servable' && serviceability.state !== 'recoverable_unservable')
    || !terminal.mode
  ) return null;
  if (expectedAttachmentId && attachmentId !== expectedAttachmentId) {
    return incompleteStopSession('attachment_mismatch');
  }

  const handle = buildTerminalHostProbeHandleFromMetadata(terminal);
  if (!handle) return incompleteStopSession('missing_topology_proof');
  const adapters = await params.loadTerminalHostAdapters().catch(() => null);
  const adapter = adapters?.[handle.kind] ?? null;
  if (!adapter) return incompleteStopSession('terminal_host_adapter_unavailable');
  const probe = await probeTerminalHostForRecovery({ adapter, handle });
  if (probe.status === 'alive') return incompleteStopSession('tracked_runner_absent');
  if (probe.status === 'inconclusive') return incompleteStopSession('missing_topology_proof');
  if (serviceability.retired === true && params.stoppedAt === undefined) return { status: 'stopped' };

  try {
    const retirement = await params.retireExactTerminalControlServiceability({
      sessionId: params.sessionId,
      attachmentId,
      terminalMode: terminal.mode,
      ...(params.stoppedAt === undefined ? {} : { stoppedAt: params.stoppedAt }),
    });
    return retirement === 'retired'
      ? { status: 'stopped' }
      : incompleteStopSession('attachment_mismatch');
  } catch {
    return incompleteStopSession('terminal_control_serviceability_retirement_failed');
  }
}
