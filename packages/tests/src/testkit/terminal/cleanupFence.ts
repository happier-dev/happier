import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_LEGACY_STREAM_COMPATIBILITY,
  isTerminalLegacyCompatibilitySunsetReached,
  isTerminalLegacyClientFallbackAllowed,
} from '@happier-dev/protocol';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CURRENT_APP_RELEASE = (JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps/ui/package.json'), 'utf8')) as { version: string }).version;
const TERMINAL_FENCE_PATHS = [
  'apps/cli/src/daemon', 'apps/cli/src/api/machine/rpcHandlers.terminal.ts',
  'apps/ui/sources/hooks/machine/useMachineTerminalSession.ts',
  'apps/ui/sources/components/sessions/terminal', 'apps/ui/sources/components/terminal',
  'apps/ui/sources/sync/ops/machineTerminal.ts',
  'packages/protocol/src/daemon/terminal.ts', 'packages/protocol/src/terminal',
] as const;
const PLUGIN_FENCE_PATHS = [
  'apps/cli/src/plugins', 'apps/ui/sources/agents', 'packages/plugin-sdk',
  'packages/plugins', 'packages/protocol/src/plugins',
] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_SOURCE_NAMES = [/\.test\./, /\.spec\./, /\.generated\./];
const RELEASE_WINDOW_COMPATIBILITY_LINES = new Set([
  'export const DaemonTerminalStreamEventDataSchema = z.object({',
  'export type DaemonTerminalStreamEventData = z.infer<typeof DaemonTerminalStreamEventDataSchema>;',
  'DaemonTerminalStreamEventDataSchema,',
]);

export type TerminalCleanupViolation = Readonly<{
  file: string;
  line: number;
  rule: 'legacy-string-path' | 'legacy-sunset-policy' | 'duplicate-owner' | 'plugin-transport-exposure';
  source: string;
}>;

function collectSourceFiles(paths: readonly string[]): string[] {
  const output = execFileSync('rg', ['--files', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return output.split(/\r?\n/).filter((file) => file
    && SOURCE_EXTENSIONS.has(extname(file))
    && !file.includes('/__tests__/')
    && !IGNORED_SOURCE_NAMES.some((pattern) => pattern.test(file)));
}

function scan(paths: readonly string[], rule: TerminalCleanupViolation['rule'], pattern: RegExp): TerminalCleanupViolation[] {
  return collectSourceFiles(paths).flatMap((repoRelativeFile) => {
    const file = resolve(REPO_ROOT, repoRelativeFile);
    let contents: string;
    try { contents = readFileSync(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return contents.split(/\r?\n/).flatMap((source, index) => {
      if (!pattern.test(source)) return [];
      if (rule === 'legacy-string-path' && repoRelativeFile === 'packages/protocol/src/daemon/terminal.ts'
        && RELEASE_WINDOW_COMPATIBILITY_LINES.has(source.trim())
        && isTerminalLegacyClientFallbackAllowed({
          currentAppRelease: CURRENT_APP_RELEASE,
          peerByteStreamCapability: 'unknown',
        })) return [];
      return [{ file: repoRelativeFile, line: index + 1, rule, source: source.trim() }];
    });
  });
}

export function validateTerminalCompatibilitySunsetPolicy(
  currentAppRelease: string = CURRENT_APP_RELEASE,
): readonly TerminalCleanupViolation[] {
  const supportedLegacyClientReleases = TERMINAL_LEGACY_STREAM_COMPATIBILITY.supportedLegacyClientReleases as readonly string[];
  if (isTerminalLegacyCompatibilitySunsetReached(currentAppRelease)) {
    return supportedLegacyClientReleases.length === 0
      ? []
      : [{
        file: 'packages/protocol/src/terminal/compatibility.ts',
        line: 1,
        rule: 'legacy-sunset-policy',
        source: `release=${currentAppRelease} reached removal=${TERMINAL_LEGACY_STREAM_COMPATIBILITY.removalRelease} with legacy compatibility still present`,
      }];
  }
  const namedRelease = supportedLegacyClientReleases.includes(
    currentAppRelease,
  );
  const removalIsDistinct = String(TERMINAL_LEGACY_STREAM_COMPATIBILITY.removalRelease)
    !== String(currentAppRelease);
  if (namedRelease && removalIsDistinct) return [];
  return [{
    file: 'packages/protocol/src/terminal/compatibility.ts',
    line: 1,
    rule: 'legacy-sunset-policy',
    source: `release=${currentAppRelease} removal=${TERMINAL_LEGACY_STREAM_COMPATIBILITY.removalRelease}`,
  }];
}

export function validateTerminalCleanupSourceTree(): readonly TerminalCleanupViolation[] {
  return [
    ...validateTerminalCompatibilitySunsetPolicy(),
    ...scan(TERMINAL_FENCE_PATHS, 'legacy-string-path', /DaemonTerminalStreamEventDataSchema|onData\(listener:\s*\(data:\s*string\)|write\(data:\s*string\)|legacy.*data:\s*string/i),
    ...scan(TERMINAL_FENCE_PATHS, 'duplicate-owner', /terminalPty/),
    ...scan(PLUGIN_FENCE_PATHS, 'plugin-transport-exposure', /\bctx\.terminal\b|terminal[._-]?byte[._-]?stream|\bTerminalStreamFrame\b/),
  ];
}

export function assertTerminalCleanupSourceTree(): void {
  const violations = validateTerminalCleanupSourceTree();
  if (!violations.length) return;
  throw new Error(`Terminal cleanup fence failed:\n${violations.map((item) => `${item.file}:${item.line} [${item.rule}] ${item.source}`).join('\n')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertTerminalCleanupSourceTree();
}
