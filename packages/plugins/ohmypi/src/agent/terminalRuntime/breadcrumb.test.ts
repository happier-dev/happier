import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import {
  createOhMyPiTerminalRuntimeBreadcrumbResolver,
  parseOhMyPiTerminalRuntimeSessionId,
} from './breadcrumb.js';

type DescriptorModule = Readonly<{
  OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1?: Readonly<{
    productId: string;
    defaultAgentDirSegments: readonly string[];
    agentDirEnvVar: string;
    legacySessionDirEnvVars: readonly string[];
    readsSettingsSessionDir: boolean;
    configDirName: string;
    encodeCwdSubdir: ((cwd: string) => string) | null;
  }>;
}>;

describe('OhMyPi terminal runtime breadcrumb', () => {
  it('resolves OhMyPi breadcrumbs through the shared terminal breadcrumb resolver seam', () => {
    const agentDir = resolve('/tmp/happier-ohmypi-terminal-breadcrumb-test/agent');
    const cwd = resolve('/tmp/happier-ohmypi-terminal-breadcrumb-test/workspace');
    const sessionFilePath = join(agentDir, 'sessions', 'workspace', '1710000000000_session-one.jsonl');
    const readPaths: string[] = [];
    const resolver = createOhMyPiTerminalRuntimeBreadcrumbResolver({
      readTextFile: (path) => {
        readPaths.push(path);
        return `${cwd}\n${sessionFilePath}\n`;
      },
    });

    expect(resolver({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv,
      terminalId: 'pts-3',
    })).toEqual({
      agentDir,
      breadcrumbCwd: cwd,
      sessionFilePath,
      remoteSessionId: 'session-one',
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    expect(readPaths).toEqual([join(agentDir, 'terminal-sessions', 'pts-3')]);
  });

  it('preserves OhMyPi first-underscore session id parsing instead of the shared last-underscore codec', () => {
    expect(parseOhMyPiTerminalRuntimeSessionId('/tmp/2026-04-10T10-00-00-000Z_b_c.jsonl')).toBe('b_c');
    expect(parseOhMyPiTerminalRuntimeSessionId('/tmp/1710000000000_b_c.jsonl')).toBe('b_c');
    expect(parseOhMyPiTerminalRuntimeSessionId('/tmp/session-b_c.jsonl')).toBe('c');
    expect(parseOhMyPiTerminalRuntimeSessionId('/tmp/not-json.txt')).toBeNull();
  });

  it('owns OhMyPi product facts in a plugin leaf descriptor', async () => {
    const loaded = await import('../sessionFileStoreDescriptor.js').catch((error: unknown) => error);
    expect(loaded).not.toBeInstanceOf(Error);
    const descriptor = (loaded as DescriptorModule).OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1;

    expect(descriptor).toEqual(expect.objectContaining({
      productId: 'ohmypi',
      defaultAgentDirSegments: ['.omp', 'agent'],
      agentDirEnvVar: 'PI_CODING_AGENT_DIR',
      legacySessionDirEnvVars: [],
      readsSettingsSessionDir: false,
      configDirName: '.omp',
      encodeCwdSubdir: null,
    }));
  });
});
