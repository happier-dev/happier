import { describe, expect, it, vi } from 'vitest';

import type { CodeIntelligenceSnapshot } from '@/sync/domains/workspaces/languageIntelligence/createCodeIntelligenceController';
import { t } from '@/text';

import {
  formatProblemsFact,
  groupCodeProblems,
  readCodeHoverContent,
  readLanguageServerLabel,
  resolveLanguageStateNote,
} from './codeIntelligencePresentation';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const idle: CodeIntelligenceSnapshot = {
  mode: 'server',
  status: 'idle',
  selection: null,
  querySelection: null,
  kind: null,
  result: null,
};
const server = (
  state: 'starting' | 'ready' | 'crashed' | 'unavailable',
  extra: Record<string, unknown> = {},
) =>
  ({
    serverId: 'ts',
    label: 'TypeScript',
    state,
    loading: false,
    generation: 'g1',
    ...extra,
  }) as NonNullable<CodeIntelligenceSnapshot['servers']>[number];

describe('language intelligence presentation', () => {
  it('counts problems only from a confirmed answer, never while checking or empty', () => {
    expect(
      formatProblemsFact({ state: 'checking', count: null, errors: 0 }),
    ).toBeNull();
    expect(
      formatProblemsFact({ state: 'ready', count: 0, errors: 0 }),
    ).toBeNull();
    expect(
      formatProblemsFact({ state: 'unavailable', count: null, errors: 0 }),
    ).toBeNull();
    expect(
      formatProblemsFact({ state: 'ready', count: 3, errors: 3 }),
    ).not.toBeNull();
  });

  it('says one state at a time: progress while starting or loading, failure with Restart, nothing when ready', () => {
    expect(
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('ready')] },
        machineName: 'devbox',
        machineUnreachable: false,
      }),
    ).toBeNull();
    expect(
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('starting')] },
        machineName: 'devbox',
        machineUnreachable: false,
      })?.kind,
    ).toBe('progress');
    expect(
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('ready', { loading: true })] },
        machineName: 'devbox',
        machineUnreachable: false,
      })?.kind,
    ).toBe('progress');
    const crashed = resolveLanguageStateNote({
      snapshot: {
        ...idle,
        servers: [server('crashed', { stderrPreview: 'a\nb\nc\nlast' })],
      },
      machineName: 'devbox',
      machineUnreachable: false,
    });
    expect(crashed).toMatchObject({
      kind: 'failure',
      action: 'restart',
      detail: 'b\nc\nlast',
    });
    expect(
      resolveLanguageStateNote({
        snapshot: {
          ...idle,
          status: 'unavailable',
          reason: 'transport_failed',
        },
        machineName: 'devbox',
        machineUnreachable: true,
      })?.kind,
    ).toBe('failure');
  });

  it('tells starting the server apart from the running server loading the project', () => {
    const note = (servers: NonNullable<CodeIntelligenceSnapshot['servers']>) =>
      resolveLanguageStateNote({ snapshot: { ...idle, status: 'loading', servers }, machineName: 'devbox', machineUnreachable: false });
    const starting = note([server('starting')]);
    const loading = note([server('ready', { loading: true })]);
    expect(starting?.kind).toBe('progress');
    expect(loading?.kind).toBe('progress');
    expect(loading?.text).not.toBe(starting?.text);
  });

  it('surfaces a missing listener while published Machine presence still says reachable', () => {
    const note = resolveLanguageStateNote({
      snapshot: { ...idle, status: 'unavailable', reason: 'target_unavailable' },
      machineName: 'devbox',
      machineUnreachable: false,
    });
    expect(note).toMatchObject({ kind: 'failure', text: t('errors.machineNotAnsweringNamed', { machine: 'devbox' }) });
  });

  it('offers Install only for a missing server the Machine can install', () => {
    const missing = (extra: Record<string, unknown>) =>
      resolveLanguageStateNote({
        snapshot: { ...idle, servers: [server('unavailable', { reason: 'server_missing', ...extra })] },
        machineName: 'devbox',
        machineUnreachable: false,
      });
    expect(missing({ installable: { pluginId: 'happier.language.typescript', dependencyId: 'typescript' } }))
      .toMatchObject({ kind: 'failure', action: 'install' });
    expect(missing({})).toMatchObject({ kind: 'failure' });
    expect(missing({})?.action).toBeUndefined();
  });

  it('reads the signature from the first fenced block and keeps the prose as documentation', () => {
    const content = readCodeHoverContent({
      status: 'ok',
      kind: 'hover',
      sections: [
        {
          serverId: 'ts',
          label: 'TypeScript',
          markdown:
            '```typescript\nfunction retry<T>(fn: () => Promise<T>): Promise<T>\n```\n---\nRetries with backoff.',
        },
      ],
    } as CodeIntelligenceSnapshot['result']);
    expect(content).toEqual({
      signature: {
        code: 'function retry<T>(fn: () => Promise<T>): Promise<T>',
        language: 'typescript',
      },
      documentation: 'Retries with backoff.',
      serverLabel: 'TypeScript',
    });
    expect(
      readCodeHoverContent({
        status: 'ok',
        kind: 'hover',
        sections: [],
      } as CodeIntelligenceSnapshot['result']),
    ).toBeNull();
  });

  it('names the server that answered over the first server running in the root', () => {
    // The Machine reports every server in the root; a .happiernovel hover came from its own server.
    const servers = [server('ready'), { ...server('ready'), serverId: 'novel', label: 'QA Novel Language' }];
    const hover = readCodeHoverContent({ status: 'ok', kind: 'hover', sections: [
      { serverId: 'novel', label: 'QA Novel Language', markdown: '```happier-novel\nsignal qaGreeting\n```' },
    ] } as CodeIntelligenceSnapshot['result']);
    expect(readLanguageServerLabel(servers, hover?.serverLabel)).toBe('QA Novel Language');
    expect(readLanguageServerLabel(servers)).toBe(servers[0]!.label);
  });

  it('groups problems by server, then by file in reading order', () => {
    const at = (path: string, line: number, serverId = 'ts') => ({
      serverId,
      path,
      severity: 'error' as const,
      message: `m${line}`,
      range: { start: { line, character: 0 }, end: { line, character: 1 } },
    });
    const groups = groupCodeProblems(
      [at('b.ts', 4), at('a.ts', 9), at('a.ts', 2), at('a.ts', 1, 'eslint')],
      [
        server('ready'),
        { ...server('ready'), serverId: 'eslint', label: 'ESLint' },
      ],
    );
    expect(groups.map((group) => group.serverLabel)).toEqual([
      'TypeScript',
      'ESLint',
    ]);
    expect(
      groups[0].files.map((file) => [
        file.path,
        file.items.map((item) => item.range.start.line),
      ]),
    ).toEqual([
      ['a.ts', [2, 9]],
      ['b.ts', [4]],
    ]);
  });
});
