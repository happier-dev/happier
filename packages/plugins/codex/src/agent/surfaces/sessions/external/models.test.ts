import { TranscriptRawRecordV1Schema as TranscriptRawRecordSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  CodexExternalSessionHandoffSourceSchema,
  projectAgentExternalSessionSourceToCodex,
  projectCodexExternalSessionCandidateToAgent,
  projectCodexExternalSessionSourceToAgent,
  projectCodexExternalSessionTranscriptPageToAgent,
} from './models.js';

describe('Codex External Sessions package-local models', () => {
  it('round-trips the Codex source fields while dropping unrelated contribution authority', () => {
    const source = projectAgentExternalSessionSourceToCodex({
      kind: 'codexHome',
      home: 'connectedService',
      homePath: ' /srv/happier/codex-home ',
      connectedServiceId: ' openai-codex ',
      connectedServiceProfileId: ' profile-1 ',
      connectedServiceGroupId: ' group-1 ',
      privateHostAuthority: 'must-not-cross',
    });

    expect(source).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      homePath: '/srv/happier/codex-home',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
    });
    expect(source && projectCodexExternalSessionSourceToAgent(source)).toEqual(source);
  });

  it('keeps handoff source affinity portable and recipient-safe', () => {
    expect(CodexExternalSessionHandoffSourceSchema.parse({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
      homePath: '/source-machine/codex-home',
      machineId: 'machine-private',
    })).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'profile-1',
      connectedServiceGroupId: 'group-1',
    });
  });

  it('projects rich candidate and transcript source records to contribution DTOs', () => {
    expect(projectCodexExternalSessionCandidateToAgent({
      remoteSessionId: 'thread-1',
      title: 'Candidate',
      updatedAtMs: 123,
      createdAtMs: 100,
      activity: 'idle',
      archived: false,
      details: {
        cwd: '/private/worktree',
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/srv/happier/codex-home',
          privateHostAuthority: 'must-not-cross',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
        codexBackendMode: 'appServer',
      },
    })).toEqual({
      remoteSessionId: 'thread-1',
      title: 'Candidate',
      updatedAtMs: 123,
      createdAtMs: 100,
      archived: false,
      linkData: {
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/srv/happier/codex-home',
        },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
        codexBackendMode: 'appServer',
      },
    });

    expect(projectCodexExternalSessionTranscriptPageToAgent({
      items: [{
        id: 'item-1',
        createdAtMs: 456,
        localId: 'local-1',
        sidechainId: 'sidechain-1',
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: { type: 'message', message: 'safe transcript content' },
          },
          sourcePath: '/private/rollout.jsonl',
          machineId: 'machine-private',
        },
      }],
      nextCursor: 'cursor-2',
      tailCursor: 'cursor-tail',
      hasMore: true,
      truncated: false,
    })).toEqual({
      items: [{
        id: 'item-1',
        createdAtMs: 456,
        localId: 'local-1',
        sidechainId: 'sidechain-1',
        messageRole: 'agent',
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: { type: 'message', message: 'safe transcript content' },
          },
        },
      }],
      nextCursor: 'cursor-2',
      tailCursor: 'cursor-tail',
      hasMore: true,
      truncated: false,
    });
  });

  it('emits transcript rows the canonical transcript raw-record contract accepts for both roles', () => {
    const page = projectCodexExternalSessionTranscriptPageToAgent({
      items: [
        {
          id: 'user-1',
          createdAtMs: 1,
          raw: {
            role: 'user',
            content: { type: 'text', text: 'hello from the rollout' },
            sourcePath: '/private/rollout.jsonl',
            machineId: 'machine-private',
          },
        },
        {
          id: 'agent-1',
          createdAtMs: 2,
          raw: {
            role: 'agent',
            content: {
              type: 'codex',
              data: { type: 'message', message: 'assistant reply' },
            },
            sourcePath: '/private/rollout.jsonl',
          },
        },
        {
          id: 'tool-1',
          createdAtMs: 3,
          raw: {
            role: 'agent',
            content: {
              type: 'codex',
              data: { type: 'tool-call', callId: 'call-1', name: 'shell', input: { command: 'ls' }, id: 'tool-1' },
            },
          },
        },
      ],
      nextCursor: null,
    });

    expect(page?.items).toHaveLength(3);
    for (const item of page!.items) {
      // The UI transcript normalizer parses this exact contract; anything else renders as
      // "[Unparsed agent message]" instead of the real Codex transcript.
      expect(TranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
      // Owner-private source facts must never cross the contribution boundary.
      expect(Object.keys(item.raw as Record<string, unknown>).sort()).toEqual(['content', 'role']);
    }
    expect(page!.items.map((item) => item.messageRole)).toEqual(['user', 'agent', 'event']);
  });

  it('rejects transcript pages whose projected user record is not canonical text content', () => {
    expect(projectCodexExternalSessionTranscriptPageToAgent({
      items: [{
        id: 'invalid-user-1',
        createdAtMs: 1,
        raw: {
          role: 'user',
          content: {
            type: 'codex',
            data: { type: 'message', message: 'not canonical user content' },
          },
        },
      }],
      nextCursor: null,
    })).toBeNull();
  });
});
