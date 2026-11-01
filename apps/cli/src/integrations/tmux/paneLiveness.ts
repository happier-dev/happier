import type { TerminalHostLiveness } from '../terminalHost/_types';
import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import type { TmuxCommandResult } from './types';

export type TmuxPaneLivenessExecutor = (args: readonly string[]) => Promise<TmuxCommandResult | null>;

const TMUX_PANE_LIVENESS_FORMAT = '#{pane_dead}|#{pane_pid}|#{pane_current_command}';

function parsePanePid(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePaneLivenessOutput(stdout: string): Readonly<{
  deadRaw: string;
  pidRaw: string;
  commandRaw: string;
}> | undefined {
  const output = stdout.trimEnd();
  for (const delimiter of ['|', '\t']) {
    const [deadRaw, pidRaw, commandRaw] = output.split(delimiter);
    if ((deadRaw === '0' || deadRaw === '1') && pidRaw !== undefined && commandRaw !== undefined) {
      return { deadRaw, pidRaw, commandRaw };
    }
  }

  // Some Node/macOS spawn paths have been observed to normalize literal tab separators to `_`.
  const normalizedLegacy = /^(0|1)_(\d+)_(.*)$/.exec(output);
  return normalizedLegacy
    ? { deadRaw: normalizedLegacy[1], pidRaw: normalizedLegacy[2], commandRaw: normalizedLegacy[3] }
    : undefined;
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
}>): TerminalHostLiveness {
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
}>): Promise<TerminalHostLiveness> {
  const observedAt = params.observedAt ?? Date.now();
  // display-message may return the session's current pane for a missing window.
  // Resolve existence first; a successful format expansion is not ownership proof.
  const targetProbe = await params.executor(['has-session', '-t', params.target]);
  if (!targetProbe || targetProbe.timedOut === true || targetProbe.returncode !== 0) {
    return failedProbeLiveness({
      stderr: targetProbe?.stderr,
      observedAt,
      targetAbsent: Boolean(targetProbe && !targetProbe.timedOut && isExactTmuxTargetAbsent(targetProbe.stderr)),
    });
  }
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

  const parsedOutput = parsePaneLivenessOutput(result.stdout);
  if (!parsedOutput) {
    return failedProbeLiveness({
      stderr: result.stderr,
      observedAt,
      targetAbsent: false,
    });
  }
  const { deadRaw, pidRaw, commandRaw } = parsedOutput;
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
