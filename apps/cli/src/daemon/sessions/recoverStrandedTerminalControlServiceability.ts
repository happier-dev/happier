import type { TerminalHostAdapter } from '@happier-dev/agents';
import { SessionTerminalMetadataSchema } from '@happier-dev/protocol';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { probeTerminalHostForRecovery } from '@/integrations/terminal/host/recoveryLiveness';
import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';
import { buildTerminalHostProbeHandleFromMetadata } from '@/terminal/runtime/terminalMetadata';
import { incompleteStopSession, type StopSessionResult } from './stopSessionContract';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export async function recoverStrandedTerminalControlServiceability(params: Readonly<{
  credentials: StoredCredentials;
  currentMachineId: string;
  sessionId: string;
  expectedAttachmentId?: string;
  loadTerminalHostAdapters: () => Promise<Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>>;
  fetchSession?: (input: Readonly<{ token: string; sessionId: string }>) => Promise<RawSessionRecord | null>;
  resolveAccountEncryptionMode?: (token: string) => Promise<'plain' | 'e2ee'>;
  retireExactTerminalControlServiceability: (input: Readonly<{
    sessionId: string;
    attachmentId: string;
    terminalMode: TerminalMode;
  }>) => Promise<'retired' | 'superseded'>;
}>): Promise<StopSessionResult | null> {
  const currentMachineId = params.currentMachineId.trim();
  if (!currentMachineId) return null;
  const fetchSession = params.fetchSession ?? fetchSessionByIdCompat;
  const resolveAccountEncryptionMode = params.resolveAccountEncryptionMode
    ?? (async (token: string) => (await fetchAccountEncryptionCurrentness({ token })).mode);
  const [rawSession, accountEncryptionMode] = await Promise.all([
    fetchSession({ token: params.credentials.token, sessionId: params.sessionId }),
    resolveAccountEncryptionMode(params.credentials.token),
  ]);
  if (!rawSession) return null;
  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials: params.credentials,
    accountEncryptionMode,
    rawSession,
  });
  if (!metadata || readNonEmptyString(metadata.machineId) !== currentMachineId) return null;

  const parsedTerminal = SessionTerminalMetadataSchema.safeParse(metadata.terminal);
  if (!parsedTerminal.success) return null;
  const terminal = parsedTerminal.data;
  const serviceability = terminal.controlServiceabilityV1;
  const attachmentId = readNonEmptyString(serviceability?.attachmentId);
  const expectedAttachmentId = readNonEmptyString(params.expectedAttachmentId);
  if (
    !serviceability
    || serviceability.v !== 1
    || !attachmentId
    || (serviceability.state !== 'servable' && serviceability.state !== 'recoverable_unservable')
    || !terminal.mode
    || terminal.mode === 'plain'
    || (serviceability.retired === true && !expectedAttachmentId)
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
  if (serviceability.retired === true) return { status: 'stopped' };

  try {
    const retirement = await params.retireExactTerminalControlServiceability({
      sessionId: params.sessionId,
      attachmentId,
      terminalMode: terminal.mode,
    });
    return retirement === 'retired'
      ? { status: 'stopped' }
      : incompleteStopSession('attachment_mismatch');
  } catch {
    return incompleteStopSession('terminal_control_serviceability_retirement_failed');
  }
}
