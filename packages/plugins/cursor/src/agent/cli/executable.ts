export type CursorAgentBinaryName = 'cursor-agent' | 'agent';

export type CursorExecutableCandidate = Readonly<{
  binaryName: CursorAgentBinaryName;
  executablePath: string;
  identifiesAsCursor: boolean;
}>;

export type CursorExecutableResolution =
  | Readonly<{
      status: 'resolved';
      source: 'configured' | 'detected';
      binaryName: CursorAgentBinaryName;
      executablePath: string;
    }>
  | Readonly<{
      status: 'unresolved';
      reason: 'not_found';
    }>;

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveCursorAgentExecutable(params: Readonly<{
  configuredPath?: string | null;
  detected: readonly CursorExecutableCandidate[];
}>): CursorExecutableResolution {
  const configuredPath = normalizePath(params.configuredPath);
  if (configuredPath) {
    return {
      status: 'resolved',
      source: 'configured',
      binaryName: 'cursor-agent',
      executablePath: configuredPath,
    };
  }

  const candidates = params.detected.filter((candidate) => (
    candidate.identifiesAsCursor && normalizePath(candidate.executablePath) !== null
  ));
  const selected = candidates.find((candidate) => candidate.binaryName === 'cursor-agent')
    ?? candidates.find((candidate) => candidate.binaryName === 'agent');
  if (!selected) {
    return { status: 'unresolved', reason: 'not_found' };
  }
  return {
    status: 'resolved',
    source: 'detected',
    binaryName: selected.binaryName,
    executablePath: selected.executablePath.trim(),
  };
}
