import type { TerminalHostLivenessV1 } from '@happier-dev/agents';

import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import type { TmuxCommandResult } from './types';

export type TmuxPaneLivenessExecutor = (args: readonly string[]) => Promise<TmuxCommandResult | null>;

const TMUX_PANE_LIVENESS_FORMAT = '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}';

function parsePanePid(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

  if (!result || result.returncode !== 0 || result.timedOut === true) {
    return {
      paneAlive: false,
      probeInconclusive: true,
      ...(result?.stderr ? { paneScreenDumpError: sanitizeTerminalHostDiagnosticText(result.stderr) } : {}),
      observedAt,
    };
  }

  const [deadRaw, pidRaw, commandRaw] = result.stdout.trimEnd().split('\t');
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
