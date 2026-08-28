import { describe, expect, it } from 'vitest';

import {
  codexExternalSessionTakeoverContribution,
  resolveCodexExternalSessionTakeoverPlan,
} from './takeover.js';

describe('Codex External Sessions takeover launch derivation', () => {
  it('returns only the fresh Codex home, native backend mode, and linked directory', () => {
    const plan = resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: ' /srv/happier/codex-home ',
      },
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/srv/happier/codex-home',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'native-session-current',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'profile-1',
            homePath: '/srv/happier/codex-home',
          },
        },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: ' /repo/project ',
    });

    expect(plan).toMatchObject({
      directory: '/repo/project',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'native-session-current',
          home: 'connectedService',
          homePath: '/srv/happier/codex-home',
        },
      },
      environmentVariables: {
        CODEX_HOME: '/srv/happier/codex-home',
      },
    });
    expect(plan).not.toHaveProperty('existingSessionId');
    expect(plan).not.toHaveProperty('resume');
    expect(plan).not.toHaveProperty('backendTarget');
    expect(plan).not.toHaveProperty('transcriptStorage');
  });

  it('fails closed on an incomplete home, inconsistent fresh source, or unsupported mode', () => {
    expect(resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: { kind: 'codexHome', home: 'user' },
      linkData: {
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: '/repo/project',
    })).toBeNull();

    expect(resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex-current',
      },
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex-stale',
        },
        codexBackendMode: 'appServer',
      },
      linkedDirectory: '/repo/project',
    })).toBeNull();

    expect(resolveCodexExternalSessionTakeoverPlan({
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex-current',
      },
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex-current',
        },
        codexBackendMode: 'not-a-codex-mode',
      },
      linkedDirectory: '/repo/project',
    })).toBeNull();
  });

  it('exposes the exact one-callback contribution and maps only the bounded plan', async () => {
    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 15_000,
        maxSerializedBytes: 262_144,
        linkedSessionId: 'happier-session-1',
        remoteSessionId: 'native-session-current',
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/home/user/.codex',
        },
        linkData: {
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: '/home/user/.codex',
          },
          codexBackendMode: 'acp',
        },
        targetDirectory: '/local/selected/workspace',
        linkedDirectory: '/repo/project',
      }),
    )).resolves.toMatchObject({
      ok: true,
      value: {
        directory: '/repo/project',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'acp',
          },
        },
        environmentVariables: {
          CODEX_HOME: '/home/user/.codex',
        },
      },
    });
    expect(Object.keys(codexExternalSessionTakeoverContribution)).toEqual([
      'resolveLaunch',
    ]);
  });

  it('distinguishes invalid fresh identity from an unavailable linked directory', async () => {
    const base = {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 15_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'happier-session-1',
      remoteSessionId: 'native-session-current',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/home/user/.codex-current',
      },
      targetDirectory: '/local/selected/workspace',
    } as const;

    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        linkData: {
          source: {
            kind: 'codexHome',
            home: 'user',
            homePath: '/home/user/.codex-stale',
          },
          codexBackendMode: 'appServer',
        },
        linkedDirectory: '/repo/project',
      }),
    )).resolves.toEqual({ ok: false, code: 'source_invalid' });
    await expect(Promise.resolve(
      codexExternalSessionTakeoverContribution.resolveLaunch({
        ...base,
        linkData: {
          source: base.source,
          codexBackendMode: 'appServer',
        },
      }),
    )).resolves.toEqual({ ok: false, code: 'unavailable' });
  });
});
