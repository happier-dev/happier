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
  it('resolves the existing Pi session for native resume without requiring the optional linkedDirectory', async () => {
    const expectedPlan = {
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'pi',
        agent: {
          resumeStrategy: 'sessionFileAbsolutePreferred',
          providerSessionId: 'pi-session-1',
          sessionFile: '/home/lee/.pi/agent/sessions/pi-session-1.jsonl',
        },
      },
      environmentVariables: {
        PI_CODING_AGENT_DIR: '/home/lee/.pi/agent',
      },
    };

    expect(resolvePiExternalSessionTakeoverPlan(request())).toEqual(expectedPlan);

    await expect(piExternalSessionTakeoverContribution.resolveLaunch(
      request(),
    )).resolves.toEqual({ ok: true, value: expectedPlan });

    // linkedDirectory is optional host context: its absence must not fail a
    // takeover whose exact identity is the canonical sessionFile descriptor.
    await expect(piExternalSessionTakeoverContribution.resolveLaunch(
      request({ linkedDirectory: undefined }),
    )).resolves.toEqual({ ok: true, value: expectedPlan });
  });

  it('carries the selected canonical file in the public descriptor when two Pi files share an id', async () => {
    const selectedSessionFile = '/home/lee/.pi/agent/sessions/workspace-a/pi-shared.jsonl';
    const siblingSessionFile = '/home/lee/.pi/agent/sessions/workspace-b/pi-shared.jsonl';
    const resolved = await piExternalSessionTakeoverContribution.resolveLaunch(request({
      source: {
        kind: 'piAgentDir',
        agentDir: '/home/lee/.pi/agent',
        sessionFile: selectedSessionFile,
      },
      remoteSessionId: 'pi-shared',
      linkData: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'pi',
          agent: {
            resumeStrategy: 'sessionFileAbsolutePreferred',
            providerSessionId: 'pi-shared',
            sessionFile: selectedSessionFile,
          },
        },
      },
    }));

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        runtimeDescriptorV1: {
          agent: {
            providerSessionId: 'pi-shared',
            sessionFile: selectedSessionFile,
          },
        },
      },
    });
    expect(resolved).not.toMatchObject({
      value: {
        runtimeDescriptorV1: {
          agent: { sessionFile: siblingSessionFile },
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
