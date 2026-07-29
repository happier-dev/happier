import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/experimental/sessions';

const candidatesMock = vi.hoisted(() => ({
  getVerifiedWorkingDirectory: vi.fn(),
}));

vi.mock('./candidates.js', () => ({
  getOpenCodeExternalSessionVerifiedWorkingDirectory:
    candidatesMock.getVerifiedWorkingDirectory,
}));

import {
  openCodeExternalSessionTakeoverContribution,
} from './provider.js';

const source = {
  kind: 'opencodeServer' as const,
  baseUrl: 'http://127.0.0.1:49196',
  directory: '/tmp/project',
};

describe('retained OpenCode external-session takeover leaf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives only the bounded native launch plan from the fresh linked identity', async () => {
    const contribution: AgentExternalSessionTakeoverContribution =
      openCodeExternalSessionTakeoverContribution;
    candidatesMock.getVerifiedWorkingDirectory.mockResolvedValueOnce('/tmp/project');

    await expect(contribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-1',
      remoteSessionId: 'session-1',
      source,
      linkData: {
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
      },
    })).resolves.toEqual({
      ok: true,
      value: {
        directory: '/tmp/project',
        backendModeHint: 'server',
      },
    });
    expect(candidatesMock.getVerifiedWorkingDirectory).toHaveBeenCalledWith({
      source,
      providerSessionId: 'session-1',
      signal: expect.any(AbortSignal),
      baseUrlAuthority: 'canonical',
    });
  });

  it('uses fresh source identity before the host-linked directory fallback', async () => {
    candidatesMock.getVerifiedWorkingDirectory.mockResolvedValueOnce(null);

    await expect(openCodeExternalSessionTakeoverContribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-1',
      remoteSessionId: 'session-1',
      source,
      linkData: {},
      linkedDirectory: '/tmp/stale-host-directory',
    })).resolves.toMatchObject({
      ok: true,
      value: {
        directory: '/tmp/project',
        backendModeHint: 'server',
      },
    });
  });

  it('falls back to the admitted linked directory when the source has no directory', async () => {
    candidatesMock.getVerifiedWorkingDirectory.mockResolvedValueOnce(null);

    await expect(openCodeExternalSessionTakeoverContribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-1',
      remoteSessionId: 'session-1',
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196',
      },
      linkData: {},
      linkedDirectory: '/tmp/admitted-host-directory',
    })).resolves.toMatchObject({
      ok: true,
      value: {
        directory: '/tmp/admitted-host-directory',
        backendModeHint: 'server',
      },
    });
  });

  it('fails without exposing host spawn state when no working directory is derivable', async () => {
    candidatesMock.getVerifiedWorkingDirectory.mockResolvedValueOnce(null);

    await expect(openCodeExternalSessionTakeoverContribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-1',
      remoteSessionId: 'session-1',
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196',
      },
      linkData: {},
    })).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      message: 'OpenCode external-session takeover requires a working directory.',
    });
  });
});
