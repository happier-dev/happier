import { describe, expect, it } from 'vitest';

import {
  piExternalSessionTakeoverContribution,
  resolvePiExternalSessionTakeoverPlan,
} from './takeover.js';

function request(overrides: Record<string, unknown> = {}) {
  return {
    source: {
      kind: 'piAgentDir',
      agentDir: '/home/lee/.pi/agent',
      sessionFile: '/home/lee/.pi/agent/sessions/pi-session-1.jsonl',
    },
    remoteSessionId: 'pi-session-1',
    linkData: {
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'pi',
        agent: {
          resumeStrategy: 'sessionFileAbsolutePreferred',
          providerSessionId: 'pi-session-1',
          sessionFile: '/home/lee/.pi/agent/sessions/pi-session-1.jsonl',
        },
      },
    },
    linkedSessionId: 'happier-session-1',
    targetDirectory: '/workspace/current',
    linkedDirectory: '/workspace/original',
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes: 64 * 1024,
    ...overrides,
  } as never;
}

describe('Pi external-session takeover', () => {
  it('resolves the existing Pi session for native resume in the selected workspace', async () => {
    expect(resolvePiExternalSessionTakeoverPlan(request())).toEqual({
      directory: '/workspace/original',
      environmentVariables: {
        PI_CODING_AGENT_DIR: '/home/lee/.pi/agent',
      },
    });

    await expect(piExternalSessionTakeoverContribution.resolveLaunch(
      request(),
    )).resolves.toEqual({
      ok: true,
      value: {
        directory: '/workspace/original',
        environmentVariables: {
          PI_CODING_AGENT_DIR: '/home/lee/.pi/agent',
        },
      },
    });
  });

  it('rejects a mismatched runtime descriptor rather than resuming another Pi store', async () => {
    const mismatched = request({
      linkData: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'pi',
          agent: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            providerSessionId: 'other-session',
            sessionFile: '/home/lee/.pi/agent/sessions/pi-session-1.jsonl',
          },
        },
      },
    });

    expect(resolvePiExternalSessionTakeoverPlan(mismatched)).toBeNull();
    await expect(piExternalSessionTakeoverContribution.resolveLaunch(
      mismatched,
    )).resolves.toEqual({ ok: false, code: 'source_invalid' });
  });
});
