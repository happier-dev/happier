import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type TerminalBreadcrumbValidationContext<TInput> = Readonly<{
  input: TInput;
  agentDir: string;
  sessionsRoot: string;
  breadcrumbCwd: string;
}>;

type TerminalBreadcrumbProjectionContext<TInput> =
  TerminalBreadcrumbValidationContext<TInput> & Readonly<{
    terminalId: string;
    sessionFilePath: string;
    remoteSessionId: string;
  }>;

type TerminalBreadcrumbResolverConfig<TInput, TSource> = Readonly<{
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

type FileStoresModule = Readonly<{
  createTerminalBreadcrumbResolver<TInput, TSource>(
    config: TerminalBreadcrumbResolverConfig<TInput, TSource>,
  ): (input: TInput) => TSource | undefined;
}>;

type Input = Readonly<{
  cwd: string;
  terminalId?: string | null;
}>;

type Source = Readonly<{
  agentDir: string;
  remoteSessionId: string;
  sessionFilePath: string;
  terminalId: string;
}>;

async function loadFileStores(): Promise<FileStoresModule> {
  const loaded = await import('./index.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as FileStoresModule;
}

function createConfig(
  overrides?: Partial<TerminalBreadcrumbResolverConfig<Input, Source>>,
): TerminalBreadcrumbResolverConfig<Input, Source> {
  const root = resolve('/tmp/happier-terminal-breadcrumb-sdk-test');
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'workspace');
  const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');

  return {
    agentDir,
    resolveTerminalId: (input) => input.terminalId,
    breadcrumbSubdir: 'terminal-sessions',
    sessionsSubdir: 'sessions',
    parseSessionId: (path) => {
      const fileName = basename(path);
      return fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length).split('_')[1] : null;
    },
    validateCwd: (candidateCwd, input) => resolve(candidateCwd) === resolve(input.cwd),
    validateSessionFile: () => true,
    projectSource: (context) => ({
      agentDir: context.agentDir,
      remoteSessionId: context.remoteSessionId,
      sessionFilePath: context.sessionFilePath,
      terminalId: context.terminalId,
    }),
    readTextFile: () => `${cwd}\n${sessionFilePath}\n`,
    canonicalizePath: (path) => resolve(path),
    ...overrides,
  };
}

describe('terminal breadcrumb resolver', () => {
  it('resolves a valid two-line breadcrumb through provider-supplied projection', async () => {
    const fileStores = await loadFileStores();
    const root = resolve('/tmp/happier-terminal-breadcrumb-sdk-test');
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'workspace');
    const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');
    const readPaths: string[] = [];

    const resolver = fileStores.createTerminalBreadcrumbResolver(createConfig({
      readTextFile: (path) => {
        readPaths.push(path);
        return `${cwd}\n${sessionFilePath}\n`;
      },
    }));

    expect(resolver({ cwd, terminalId: 'pts-3' })).toEqual({
      agentDir,
      remoteSessionId: 'remote-123',
      sessionFilePath,
      terminalId: 'pts-3',
    });
    expect(readPaths).toEqual([join(agentDir, 'terminal-sessions', 'pts-3')]);
  });

  it('rejects invalid breadcrumbs before provider projection', async () => {
    const fileStores = await loadFileStores();
    const root = resolve('/tmp/happier-terminal-breadcrumb-sdk-test');
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'workspace');
    const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');
    const outsideSessionFilePath = join(root, 'outside', '1710000000000_remote-123.jsonl');
    const projected: Source[] = [];

    const cases: readonly [string, Input, Partial<TerminalBreadcrumbResolverConfig<Input, Source>>][] = [
      ['missing terminal id', { cwd, terminalId: null }, {}],
      ['missing breadcrumb file', { cwd, terminalId: 'pts-3' }, { readTextFile: () => { throw new Error('missing'); } }],
      ['extra non-empty lines', { cwd, terminalId: 'pts-3' }, { readTextFile: () => `${cwd}\n${sessionFilePath}\nextra\n` }],
      ['cwd mismatch', { cwd, terminalId: 'pts-3' }, { readTextFile: () => `${join(root, 'other')}\n${sessionFilePath}\n` }],
      ['outside sessions root', { cwd, terminalId: 'pts-3' }, { readTextFile: () => `${cwd}\n${outsideSessionFilePath}\n` }],
      ['invalid session file', { cwd, terminalId: 'pts-3' }, { validateSessionFile: () => false }],
      ['invalid session id', { cwd, terminalId: 'pts-3' }, { parseSessionId: () => null }],
    ];

    for (const [, input, overrides] of cases) {
      const resolver = fileStores.createTerminalBreadcrumbResolver(createConfig({
        ...overrides,
        projectSource: (context) => {
          const source = {
            agentDir: context.agentDir,
            remoteSessionId: context.remoteSessionId,
            sessionFilePath: context.sessionFilePath,
            terminalId: context.terminalId,
          };
          projected.push(source);
          return source;
        },
      }));

      expect(resolver(input)).toBeUndefined();
    }

    expect(projected).toEqual([]);
  });

  it('rejects terminal ids that escape the breadcrumb directory', async () => {
    const fileStores = await loadFileStores();
    const root = resolve('/tmp/happier-terminal-breadcrumb-sdk-test');
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'workspace');
    const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_remote-123.jsonl');
    const readPaths: string[] = [];

    const resolver = fileStores.createTerminalBreadcrumbResolver(createConfig({
      readTextFile: (path) => {
        readPaths.push(path);
        return `${cwd}\n${sessionFilePath}\n`;
      },
    }));

    expect(resolver({ cwd, terminalId: '../sessions/workspace/1710000000000_remote-123.jsonl' })).toBeUndefined();
    expect(readPaths).toEqual([]);
  });
});
