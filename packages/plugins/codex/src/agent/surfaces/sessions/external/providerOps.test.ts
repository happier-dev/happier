import { describe, expect, it } from 'vitest';

import {
  createCodexExternalSessionSurface,
  resolveCodexExternalSessionFallbackHome,
  resolveCodexExternalSessionTakeoverSpawnPlan,
} from './providerOps.js';

describe('Codex external-session provider operation policy', () => {
  it('builds takeover spawn options only when directory and Codex home are available', () => {
    expect(resolveCodexExternalSessionTakeoverSpawnPlan({
      sessionId: 'happy-session-1',
      remoteSessionId: 'codex-session-1',
      directory: ' /repo/project ',
      codexHome: ' /home/user/.codex ',
      codexBackendMode: 'appServer',
    })).toEqual({
      directory: '/repo/project',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      existingSessionId: 'happy-session-1',
      resume: 'codex-session-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
      codexBackendMode: 'appServer',
      environmentVariables: {
        CODEX_HOME: '/home/user/.codex',
      },
    });

    expect(resolveCodexExternalSessionTakeoverSpawnPlan({
      sessionId: 'happy-session-1',
      remoteSessionId: 'codex-session-1',
      directory: null,
      codexHome: '/home/user/.codex',
      codexBackendMode: null,
    })).toBeNull();
    expect(resolveCodexExternalSessionTakeoverSpawnPlan({
      sessionId: 'happy-session-1',
      remoteSessionId: 'codex-session-1',
      directory: '/repo/project',
      codexHome: ' ',
      codexBackendMode: null,
    })).toBeNull();
  });

  it('uses exactly one fallback Codex home and refuses ambiguous choices', () => {
    expect(resolveCodexExternalSessionFallbackHome([{ codexHome: '/one' }])).toBe('/one');
    expect(resolveCodexExternalSessionFallbackHome([])).toBeNull();
    expect(resolveCodexExternalSessionFallbackHome([{ codexHome: '/one' }, { codexHome: '/two' }])).toBeNull();
    expect(resolveCodexExternalSessionFallbackHome([{ codexHome: ' ' }])).toBeNull();
  });

  it('lists candidates through the host runtime candidate service after source validation', async () => {
    const calls: unknown[] = [];
    const surface = createCodexExternalSessionSurface({
      baseProcessEnv: {
        HOME: '/home/user',
      },
    });
    const runtime = {
      signal: new AbortController().signal,
      directories: {
        activeServerDir: '/server',
      },
      external: {
        candidates: {
          listViaChildHost: async (input: unknown) => {
            calls.push(input);
            return {
              candidates: [{
                remoteSessionId: 'codex-session-1',
                createdAtMs: 1,
                updatedAtMs: 2,
                archived: false,
              }],
              nextCursor: null,
            };
          },
        },
      },
      diagnostics: {
        issue: () => undefined,
      },
    };

    const resolved = await surface.resolveSource({
      source: { kind: 'codexHome', home: 'user' },
      runtime,
    });
    expect(resolved).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex',
        },
      },
    });

    await expect(surface.listCandidates({
      source: { kind: 'codexHome', home: 'user' },
      limit: 5,
      searchTerm: 'project',
      searchMode: 'full',
      runtime,
    })).resolves.toEqual({
      ok: true,
      value: {
        candidates: [{
          remoteSessionId: 'codex-session-1',
          createdAtMs: 1,
          updatedAtMs: 2,
          archived: false,
        }],
        nextCursor: null,
      },
    });
    expect(calls).toEqual([{
      providerId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex',
      },
      limit: 5,
      searchTerm: 'project',
      searchMode: 'full',
    }]);
  });

  it('resolves takeover launch hints through host transcript metadata services', async () => {
    const surface = createCodexExternalSessionSurface({
      baseProcessEnv: {
        HOME: '/home/user',
      },
    });
    const runtime = {
      signal: new AbortController().signal,
      external: {
        transcripts: {
          getWorkingDirectory: async () => '/repo/project',
          getProviderHome: async () => '/home/user/.codex',
        },
      },
      diagnostics: {
        issue: () => undefined,
      },
    };

    await expect(surface.resolveTakeoverLaunch?.({
      linkedSessionId: 'happier-session-1',
      providerSessionId: 'codex-session-1',
      source: { kind: 'codexHome', home: 'user', homePath: '/home/user/.codex' },
      metadata: {},
      runtime,
    })).resolves.toEqual({
      ok: true,
      value: {
        providerSessionId: 'codex-session-1',
        source: { kind: 'codexHome', home: 'user', homePath: '/home/user/.codex' },
        launch: {
          directory: '/repo/project',
          environmentVariables: {
            CODEX_HOME: '/home/user/.codex',
          },
        },
      },
    });
  });
});
