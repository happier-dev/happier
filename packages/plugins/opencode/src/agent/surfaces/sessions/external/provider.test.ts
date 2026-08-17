import { describe, expect, it } from 'vitest';
import type {
  AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  openCodeExternalSessionTakeoverContribution,
} from './provider.js';

describe('retained OpenCode external-session takeover leaf', () => {
  it('uses the host-selected local target instead of remote provider directory metadata', async () => {
    const contribution: AgentExternalSessionTakeoverContribution =
      openCodeExternalSessionTakeoverContribution;

    await expect(contribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-1',
      remoteSessionId: 'session-1',
      source: {
        kind: 'opencodeServer',
        baseUrl: 'https://remote.example.test',
        directory: '/remote/provider/workspace',
      },
      linkData: {
        opencodeSessionId: 'session-1',
        opencodeBackendMode: 'server',
      },
      targetDirectory: '/local/selected/workspace',
    })).resolves.toEqual({
      ok: true,
      value: {
        directory: '/local/selected/workspace',
        backendModeHint: 'server',
      },
    });
  });

  it('rejects a non-OpenCode source before returning a launch plan', async () => {
    await expect(openCodeExternalSessionTakeoverContribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-1',
      remoteSessionId: 'session-1',
      source: { kind: 'differentSource' },
      linkData: {},
      targetDirectory: '/local/selected/workspace',
    })).resolves.toMatchObject({
      ok: false,
      code: 'source_invalid',
    });
  });
});
