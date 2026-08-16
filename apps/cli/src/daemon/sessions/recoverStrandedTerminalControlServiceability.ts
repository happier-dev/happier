import { buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import type { Credentials } from '@/persistence';
import type { TerminalHostRegistry } from '@/integrations/terminalHost/registry';
import { resolveZellijSocketDir } from '@/integrations/zellij/socketDir';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { SessionTerminalMetadataSchema } from '@happier-dev/protocol';
import { incompleteStopSession, type StopSessionResult } from './stopSessionContract';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export async function recoverStrandedTerminalControlServiceability(params: Readonly<{
  credentials: Credentials;
  currentMachineId: string;
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId?: string;
  loadTerminalHostAdapters: () => Promise<TerminalHostRegistry>;
  fetchSession?: (input: Readonly<{ token: string; sessionId: string }>) => Promise<RawSessionRecord | null>;
  retireExactTerminalControlServiceability: (input: Readonly<{
    sessionId: string;
    attachmentId: string;
    terminalMode: 'plain' | 'tmux' | 'zellij' | 'windows_terminal' | 'windows_console';
  }>) => Promise<'retired' | 'superseded'>;
}>): Promise<StopSessionResult | null> {
  const currentMachineId = params.currentMachineId.trim();
  if (!currentMachineId) return null;

  const fetchSession = params.fetchSession ?? fetchSessionByIdCompat;
  const rawSession = await fetchSession({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) return null;

  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
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
  ) {
    return null;
  }
  if (expectedAttachmentId && attachmentId !== expectedAttachmentId) {
    return incompleteStopSession('attachment_mismatch');
  }

  const reconstructedHandle = buildTerminalHostHandleFromAttachmentMetadata(terminal);
  if (!reconstructedHandle) return incompleteStopSession('missing_topology_proof');
  const handle = reconstructedHandle.kind === 'zellij' && !reconstructedHandle.socketDir
    ? { ...reconstructedHandle, socketDir: resolveZellijSocketDir(params.happyHomeDir) }
    : reconstructedHandle;

  const adapters = await params.loadTerminalHostAdapters().catch(() => null);
  const adapter = adapters?.[handle.kind] ?? null;
  if (!adapter) return incompleteStopSession('terminal_host_adapter_unavailable');

  const probe = await evaluateTerminalHostLivenessForRecovery(adapter, handle);
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
