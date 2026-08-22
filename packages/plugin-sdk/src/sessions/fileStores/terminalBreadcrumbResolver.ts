import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/cli-common/path';

export type TerminalBreadcrumbValidationContext<TInput> = Readonly<{
  input: TInput;
  agentDir: string;
  sessionsRoot: string;
  breadcrumbCwd: string;
}>;

export type TerminalBreadcrumbProjectionContext<TInput> =
  TerminalBreadcrumbValidationContext<TInput> & Readonly<{
    terminalId: string;
    sessionFilePath: string;
    remoteSessionId: string;
  }>;

export type TerminalBreadcrumbResolverConfig<TInput, TSource> = Readonly<{
  agentDir: string | ((input: TInput) => string);
  resolveTerminalId: (input: TInput) => string | null | undefined;
  breadcrumbSubdir: string;
  sessionsSubdir: string;
  parseSessionId: (sessionFilePath: string) => string | null | undefined;
  validateCwd: (candidateCwd: string, input: TInput) => boolean;
  validateSessionFile: (
    sessionFilePath: string,
    context: TerminalBreadcrumbValidationContext<TInput>,
  ) => boolean;
  projectSource: (context: TerminalBreadcrumbProjectionContext<TInput>) => TSource;
  readTextFile?: (path: string) => string;
  canonicalizePath?: (path: string) => string;
}>;

export type TerminalBreadcrumbResolver<TInput, TSource> = (input: TInput) => TSource | undefined;

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function resolveAgentDir<TInput>(agentDir: string | ((input: TInput) => string), input: TInput): string {
  return typeof agentDir === 'function' ? agentDir(input) : agentDir;
}

function parseBreadcrumbLines(content: string): readonly [string, string] | undefined {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 2) return undefined;
  return [lines[0]!, lines[1]!];
}

export function createTerminalBreadcrumbResolver<TInput, TSource>(
  config: TerminalBreadcrumbResolverConfig<TInput, TSource>,
): TerminalBreadcrumbResolver<TInput, TSource> {
  return (input) => {
    const terminalId = config.resolveTerminalId(input);
    if (!terminalId) return undefined;

    const canonicalizePath = config.canonicalizePath ?? resolve;
    const agentDir = canonicalizePath(resolveAgentDir(config.agentDir, input));
    const breadcrumbRoot = canonicalizePath(join(agentDir, config.breadcrumbSubdir));
    const breadcrumbPath = canonicalizePath(join(breadcrumbRoot, terminalId));
    if (!isCanonicalAbsolutePathInsideRoot(breadcrumbRoot, breadcrumbPath)) return undefined;
    const contentReader = config.readTextFile ?? readTextFile;

    let content: string;
    try {
      content = contentReader(breadcrumbPath);
    } catch {
      return undefined;
    }

    const lines = parseBreadcrumbLines(content);
    if (!lines) return undefined;

    const [candidateCwdRaw, sessionFileRaw] = lines;
    const breadcrumbCwd = canonicalizePath(candidateCwdRaw);
    if (!config.validateCwd(breadcrumbCwd, input)) return undefined;

    const sessionsRoot = canonicalizePath(join(agentDir, config.sessionsSubdir));
    const sessionFilePath = canonicalizePath(sessionFileRaw);
    if (!isCanonicalAbsolutePathInsideRoot(sessionsRoot, sessionFilePath)) return undefined;

    const context: TerminalBreadcrumbValidationContext<TInput> = {
      input,
      agentDir,
      sessionsRoot,
      breadcrumbCwd,
    };
    if (!config.validateSessionFile(sessionFilePath, context)) return undefined;

    const remoteSessionId = config.parseSessionId(sessionFilePath)?.trim();
    if (!remoteSessionId) return undefined;

    return config.projectSource({
      ...context,
      terminalId,
      sessionFilePath,
      remoteSessionId,
    });
  };
}
