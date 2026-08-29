import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
  ohMyPiExternalSessionTakeoverContribution,
} from './semantics.js';

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('Oh My Pi external-session auxiliary semantics', () => {
  it('derives only the bounded native launch plan from the fresh linked identity', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-takeover-'));
    const canonicalAgentDir = await realpath(agentDir);
    roots.add(agentDir);

    const contribution: AgentExternalSessionTakeoverContribution =
      ohMyPiExternalSessionTakeoverContribution;
    await expect(contribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-session',
      // The resolved identity carries the session file on the source; link data
      // stays empty because the host projects it into strict owner metadata.
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir,
        sessionFilePath: '/does/not/need/to/exist.jsonl',
      },
      remoteSessionId: 'takeover-session',
      linkData: {},
      targetDirectory: '/local/selected/workspace',
    })).resolves.toEqual({
      ok: true,
      value: {
        environmentVariables: { PI_CODING_AGENT_DIR: canonicalAgentDir },
      },
    });
  });

  it('carries no launch-cwd authority from the linked directory or transcript header', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-takeover-'));
    const canonicalAgentDir = await realpath(agentDir);
    roots.add(agentDir);

    await expect(ohMyPiExternalSessionTakeoverContribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-session',
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId: 'takeover-session',
      linkData: { sessionFilePath: '/does/not/need/to/exist.jsonl' },
      targetDirectory: '/local/selected/workspace',
      linkedDirectory: '/repo/from-linked-session',
    })).resolves.toEqual({
      ok: true,
      value: {
        environmentVariables: { PI_CODING_AGENT_DIR: canonicalAgentDir },
      },
    });
  });
});
