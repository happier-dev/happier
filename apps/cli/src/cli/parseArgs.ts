import { parseAndStripTerminalRuntimeFlags, type TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

export function parseCliArgs(argv: string[]): Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}> {
  const parsed = parseAndStripTerminalRuntimeFlags(argv);
  return { args: parsed.argv, terminalRuntime: parsed.terminal };
}

