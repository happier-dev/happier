import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExternalSessionTakeoverContribution,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  ohMyPiExternalSessionTakeoverContribution,
} from './semantics.js';

const roots = new Set<string>();

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('Oh My Pi external-session auxiliary semantics', () => {
  it('derives only the bounded native launch plan from the fresh linked identity', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-takeover-'));
    const canonicalAgentDir = await realpath(agentDir);
    roots.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    const sessionFilePath = join(
      sessionRoot,
      '2026-07-23T10-00-00-000Z_takeover-session.jsonl',
    );
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      sessionFilePath,
      [
        jsonlLine({
          type: 'session',
          id: 'takeover-session',
          timestamp: '2026-07-23T10:00:00.000Z',
          cwd: '/repo/from-transcript',
        }),
        jsonlLine({
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-07-23T10:00:01.000Z',
          message: { role: 'user', content: 'resume' },
        }),
      ].join(''),
      'utf8',
    );

    const contribution: AgentExternalSessionTakeoverContribution =
      ohMyPiExternalSessionTakeoverContribution;
    await expect(contribution.resolveLaunch({
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() + 1_000,
      maxSerializedBytes: 262_144,
      linkedSessionId: 'linked-session',
      source: { kind: 'ohMyPiAgentDir', agentDir },
      remoteSessionId: 'takeover-session',
      linkData: { sessionFilePath },
    })).resolves.toEqual({
      ok: true,
      value: {
        directory: '/repo/from-transcript',
        environmentVariables: { PI_CODING_AGENT_DIR: canonicalAgentDir },
      },
    });
  });

  it('uses the admitted linked directory without adding backend or host-state hints', async () => {
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
      linkedDirectory: '/repo/from-linked-session',
    })).resolves.toEqual({
      ok: true,
      value: {
        directory: '/repo/from-linked-session',
        environmentVariables: { PI_CODING_AGENT_DIR: canonicalAgentDir },
      },
    });
  });
});
