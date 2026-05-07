import type {
  NativeSshAuthPromptEvent,
  NativeSshHostKeyPromptEvent,
  NativeSshProgressEvent,
} from './HappierSshNative.types';

const PROGRESS_PHASES = new Set<NativeSshProgressEvent['phase']>([
  'connecting',
  'verifying-host-key',
  'authenticating',
  'executing',
  'closing',
]);

export function normalizeNativeSshHostKeyPromptEvent(value: unknown): NativeSshHostKeyPromptEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<NativeSshHostKeyPromptEvent>;
  const requestId = readNonEmptyString(event.requestId);
  const promptId = readNonEmptyString(event.promptId);
  const host = readNonEmptyString(event.host);
  const port = readPort(event.port);
  const algorithm = readNonEmptyString(event.algorithm);
  const fingerprintSha256 = readNonEmptyString(event.fingerprintSha256);
  const status = event.status === 'unknown' || event.status === 'changed' ? event.status : null;
  if (!requestId || !promptId || !host || port === null || !algorithm || !fingerprintSha256 || !status) return null;

  const existingFingerprintSha256 = readNonEmptyString(event.existingFingerprintSha256);
  return existingFingerprintSha256
    ? { requestId, promptId, host, port, algorithm, fingerprintSha256, status, existingFingerprintSha256 }
    : { requestId, promptId, host, port, algorithm, fingerprintSha256, status };
}

export function normalizeNativeSshProgressEvent(value: unknown): NativeSshProgressEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<NativeSshProgressEvent>;
  const requestId = readNonEmptyString(event.requestId);
  const phase = event.phase;
  const host = readNonEmptyString(event.host);
  const port = readPort(event.port);
  if (!requestId || !phase || !PROGRESS_PHASES.has(phase) || !host || port === null) return null;
  return { requestId, phase, host, port };
}

export function normalizeNativeSshAuthPromptEvent(value: unknown): NativeSshAuthPromptEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<NativeSshAuthPromptEvent>;
  const requestId = readNonEmptyString(event.requestId);
  const promptId = readNonEmptyString(event.promptId);
  const host = readNonEmptyString(event.host);
  const port = readPort(event.port);
  const username = readNonEmptyString(event.username);
  if (!requestId || !promptId || !host || port === null || !username) return null;

  if (event.kind === 'private-key-passphrase') {
    const keyLabel = readNonEmptyString(event.keyLabel);
    const attemptsRemaining = typeof event.attemptsRemaining === 'number'
      && Number.isInteger(event.attemptsRemaining)
      && event.attemptsRemaining > 0
      ? event.attemptsRemaining
      : undefined;
    return {
      requestId,
      promptId,
      kind: 'private-key-passphrase',
      host,
      port,
      username,
      ...(keyLabel ? { keyLabel } : {}),
      ...(attemptsRemaining ? { attemptsRemaining } : {}),
    };
  }

  if (event.kind === 'keyboard-interactive') {
    const prompts: Array<{ id: string; label: string; echo: boolean }> = (Array.isArray(event.prompts) ? event.prompts : []).flatMap((prompt) => {
      if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return [];
      const item = prompt as { id?: unknown; label?: unknown; echo?: unknown };
      const id = readNonEmptyString(item.id);
      const label = readNonEmptyString(item.label);
      if (!id || !label) return [];
      return [{ id, label, echo: item.echo === true }];
    });
    return {
      requestId,
      promptId,
      kind: 'keyboard-interactive',
      host,
      port,
      username,
      prompts,
      ...(readNonEmptyString(event.name) ? { name: readNonEmptyString(event.name)! } : {}),
      ...(readNonEmptyString(event.instruction) ? { instruction: readNonEmptyString(event.instruction)! } : {}),
    };
  }

  return null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : null;
  return port !== null && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}
