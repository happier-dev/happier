import { parseAndStripTerminalRuntimeFlags, type TerminalRuntimeFlags } from '../terminal/runtime/terminalRuntimeFlags';

function isCliEntrypointPath(arg: string): boolean {
    const normalized = String(arg ?? '').trim().replaceAll('\\', '/');
    if (!normalized) return false;
    const relativeNormalized = normalized.replace(/^\.\//, '');
    return (
        normalized.endsWith('/package-dist/index.mjs') ||
        normalized.endsWith('/dist/index.mjs') ||
        normalized.endsWith('/apps/cli/src/index.ts') ||
        relativeNormalized === 'src/index.ts' ||
        relativeNormalized === 'apps/cli/src/index.ts'
    );
}

export function normalizeCliArgv(argv: readonly string[]): string[] {
    if (argv.length === 0) return [];
    return isCliEntrypointPath(argv[0] ?? '') ? [...argv.slice(1)] : [...argv];
}

export function parseCliArgs(argv: string[]): Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}> {
  const parsed = parseAndStripTerminalRuntimeFlags(normalizeCliArgv(argv));
  return { args: parsed.argv, terminalRuntime: parsed.terminal };
}
