import type { TerminalHostLivenessV1 } from '@happier-dev/agents';

import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import type { TmuxCommandResult } from './types';

export type TmuxPaneLivenessExecutor = (args: readonly string[]) => Promise<TmuxCommandResult | null>;

const TMUX_PANE_LIVENESS_FORMAT = '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}';

function parsePanePid(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isExactTmuxTargetAbsent(stderr: string): boolean {
  const message = stderr.trim();
  return /^error connecting to .+ \(no such file or directory\)$/i.test(message)
    || /^no server running on .+$/i.test(message)
    || /^(?:can't|can not) find (?:session|window|pane): .+$/i.test(message);
}

function failedProbeLiveness(params: Readonly<{
  stderr?: string;
  observedAt: number;
  targetAbsent: boolean;
}>): TerminalHostLivenessV1 {
  return {
    paneAlive: false,
    ...(params.targetAbsent ? { paneDead: true } : { probeInconclusive: true }),
    ...(params.stderr ? { paneScreenDumpError: sanitizeTerminalHostDiagnosticText(params.stderr) } : {}),
    observedAt: params.observedAt,
  };
}

export async function evaluateTmuxPaneLiveness(params: Readonly<{
  executor: TmuxPaneLivenessExecutor;
  target: string;
  observedAt?: number;
}>): Promise<TerminalHostLivenessV1> {
  const observedAt = params.observedAt ?? Date.now();
  const result = await params.executor([
    'display-message',
    '-p',
    '-t',
    params.target,
    TMUX_PANE_LIVENESS_FORMAT,
  ]);

  if (!result || result.timedOut === true) {
    return failedProbeLiveness({ observedAt, targetAbsent: false });
  }
  if (result.returncode !== 0) {
    return failedProbeLiveness({
      stderr: result.stderr,
      observedAt,
      targetAbsent: isExactTmuxTargetAbsent(result.stderr),
    });
  }

  const [deadRaw, pidRaw, commandRaw] = result.stdout.trimEnd().split('\t');
  if (deadRaw !== '0' && deadRaw !== '1') {
    // `tmux display-message` can return rc=0 with empty format fields for a missing
    // target. Ask tmux's target resolver before deciding that the exact pane died.
    const targetProbe = await params.executor(['has-session', '-t', params.target]);
    if (
      targetProbe
      && targetProbe.timedOut !== true
      && targetProbe.returncode !== 0
      && isExactTmuxTargetAbsent(targetProbe.stderr)
    ) {
      return failedProbeLiveness({
        stderr: targetProbe.stderr,
        observedAt,
        targetAbsent: true,
      });
    }
    return failedProbeLiveness({
      stderr: targetProbe?.stderr || result.stderr,
      observedAt,
      targetAbsent: false,
    });
  }
  const paneDead = deadRaw === '1';
  const panePid = parsePanePid(pidRaw);
  return {
    paneAlive: !paneDead,
    paneDead,
    ...(panePid !== undefined ? { panePid } : {}),
    ...(commandRaw ? { paneCurrentCommand: sanitizeTerminalHostDiagnosticText(commandRaw) } : {}),
    observedAt,
  };
}
