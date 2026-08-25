import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  ExecService,
  PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';
import type {
  PluginJsonRpcClient,
  PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';

import { createCodexExternalSessionsContribution } from './contribution.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function processResult(stdout: string): PluginProcessResult {
  return {
    termination: {
      observed: { kind: 'exit', exitCode: 0 },
      requestedBy: { kind: 'none' },
    },
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createThreadListingExec(
  requests: string[],
  threads: readonly Readonly<{
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    cwd: string;
  }>[] = [{
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Native app-server thread',
    createdAt: 1_768_000_000,
    updatedAt: 1_768_000_100,
    cwd: '/repo/native',
  }],
): ExecService {
  const never = new Promise<PluginProcessResult>(() => undefined);
  const client: PluginJsonRpcClient = {
    async request(method) {
      requests.push(method);
      if (method === 'thread/list') {
        return { data: threads };
      }
      return {};
    },
    async notify() {},
    onNotification: () => ({ dispose: () => undefined }),
    onRequest: () => ({ dispose: () => undefined }),
    dispose: async () => undefined,
  };
  const handle: PluginProtocolClientHandle<'jsonRpc'> = {
    client,
    process: {
      pid: 123,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => never,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
    wait: () => never,
    dispose: async () => undefined,
  };
  return {
    agentCli: { checkReadiness: async () => ({ launchable: [] }) },
    systemTools: {
      resolve: async () => ({
        executable: { kind: 'systemTool', id: 'codex-cli' },
        executablePath: '/fixture/codex',
      }),
    },
    run: vi.fn(async (request: Parameters<ExecService['run']>[0]) => (
      request.args?.[0] === '--version'
        ? processResult('codex-cli 0.145.0\n')
        : processResult('realtime_conversation                under development  false\n')
    )),
    spawn: vi.fn(async () => {
      throw new Error('The native app-server path must use exec.clients.spawn');
    }),
    clients: {
      spawn: async () => handle,
    },
  } as unknown as ExecService;
}

const emptyThreadListingExec = createThreadListingExec([], []);

function invocation(overrides: Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
  maxSerializedBytes?: number;
  exec?: ExecService;
}> = {}) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 30_000,
    maxSerializedBytes: overrides.maxSerializedBytes ?? 64 * 1024,
    exec: overrides.exec ?? emptyThreadListingExec,
  };
}

describe('Codex public Agent External Sessions contribution', () => {
  it('uses the invocation ExecService to list native app-server threads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-native-threads-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const requests: string[] = [];
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user' },
        maxItems: 10,
        searchMode: 'full',
        ...invocation({ exec: createThreadListingExec(requests) }),
      })).resolves.toMatchObject({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId: '33333333-3333-3333-3333-333333333333',
            title: 'Native app-server thread',
          }],
        },
      });

      expect(requests.filter((method) => method === 'thread/list')).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['tail', 'a missing source'],
    [
      'eyJ2IjoyLCJraW5kIjoiY29kZXhGb3J3YXJkQXBwU2VydmVyIiwidXBkYXRlZEF0TXMiOjE3MzYwMDAxMDAwMDAsInByZXZpZXdUZXh0IjoiUmVsZWFzZWQgcHJldmlldyJ9',
      'a disappeared released app-server source',
    ],
  ])('forwards source_unavailable for %s (%s)', async (cursor) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unavailable-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.readAfterTranscript({
        source: { kind: 'codexHome', home: 'user' },
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        cursor,
        maxItems: 20,
        ...invocation(),
      })).resolves.toEqual({
        ok: true,
        value: { outcome: 'source_unavailable' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a typed failure instead of a cursor when a current rollout record is unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unsupported-record-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({ type: 'unsupported_record', payload: { ignored: true } }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

      await expect(contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: false,
        code: 'agent_error',
        retryable: false,
      });

      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial item' }],
          },
        }),
      ].join(''), 'utf8');
      const initial = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      });
      if (!initial.ok || !initial.value.tailCursor) {
        throw new Error('Expected a valid Codex transcript cursor');
      }

      await appendFile(rolloutPath, jsonl({
        type: 'response_item',
        payload: { type: 'unrecognized_current_shape' },
      }));
      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: initial.value.tailCursor,
        maxItems: 20,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: false,
        code: 'agent_error',
        retryable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns typed unsupported rather than an authoritative empty page for newer paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-newer-unsupported-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T09-00-00-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            payload: { id: remoteSessionId, cwd: '/repo' },
          }),
          jsonl({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'older-only history' }],
            },
          }),
        ].join(''),
        'utf8',
      );
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.pageTranscript({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        remoteSessionId,
        direction: 'newer',
        maxItems: 10,
        ...invocation(),
      })).resolves.toEqual({
        ok: false,
        code: 'unsupported',
        message: 'Codex external-session newer paging is not supported.',
        retryable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the rollout owners candidate, link identity, transcript, and cursor semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-external-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const firstSessionId = '11111111-1111-1111-1111-111111111111';
      const secondSessionId = '22222222-2222-2222-2222-222222222222';
      const firstFile = join(sessionsDir, `rollout-2026-07-23T08-00-00-${firstSessionId}.jsonl`);
      await writeFile(firstFile, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: { id: firstSessionId, timestamp: '2026-07-23T08:00:00.000Z', cwd: '/repo/first' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:01:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first public message' }],
          },
        }),
      ].join(''), 'utf8');
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T09-00-00-${secondSessionId}.jsonl`),
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T09:00:00.000Z',
          payload: { id: secondSessionId, timestamp: '2026-07-23T09:00:00.000Z', cwd: '/repo/second' },
        }),
        'utf8',
      );

      const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
      const activeServerDir = join(root, 'active-server');
      const contribution = createCodexExternalSessionsContribution({ env });
      const source = { kind: 'codexHome', home: 'user' } as const;
      const resolvedSource = await contribution.resolveSource({ source, ...invocation() });
      expect(resolvedSource).toEqual({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          transcriptMediaReadRoots: [codexHome],
        },
      });
      if (!resolvedSource.ok) throw new Error('Expected resolved Codex source');

      const listed = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 1,
        searchMode: 'fast',
        ...invocation(),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          candidates: [{ remoteSessionId: secondSessionId }],
          nextCursor: expect.any(String),
        },
      });
      if (!listed.ok) throw new Error('Expected Codex candidates');
      expect(listed.value.candidates).toHaveLength(1);
      expect(listed.value.candidates[0]?.linkData).toMatchObject({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
      });

      const firstCandidate = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 10,
        searchTerm: firstSessionId,
        searchMode: 'fast',
        ...invocation(),
      });
      if (!firstCandidate.ok) throw new Error('Expected first Codex candidate');

      const fullSearch = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 10,
        searchTerm: 'first public message',
        searchMode: 'full',
        ...invocation(),
      });
      expect(fullSearch).toMatchObject({
        ok: true,
        value: {
          candidates: [{ remoteSessionId: firstSessionId }],
          nextCursor: null,
        },
      });
      if (!fullSearch.ok) throw new Error('Expected complete Codex rollout search');
      expect(fullSearch.value.searchIncomplete).toBeUndefined();

      const identity = await contribution.resolveLinkIdentity({
        source: resolvedSource.value.source,
        remoteSessionId: firstSessionId,
        linkData: firstCandidate.value.candidates[0]?.linkData,
        ...invocation(),
      });
      expect(identity).toMatchObject({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          remoteSessionId: firstSessionId,
          transcriptMediaReadRoots: [codexHome],
          linkData: {
            source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          },
        },
      });
      if (!identity.ok) throw new Error('Expected Codex identity');

      const page = await contribution.pageTranscript({
        source: identity.value.source,
        remoteSessionId: identity.value.remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      expect(page).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ id: expect.any(String) })],
          tailCursor: expect.any(String),
        },
      });
      if (!page.ok) throw new Error('Expected Codex transcript');
      expect(page.value.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          messageRole: 'agent',
          raw: {
            role: 'agent',
            content: {
              type: 'codex',
              data: {
                type: 'message',
                message: 'first public message',
              },
            },
          },
        }),
      ]));

      await appendFile(firstFile, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T08:02:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'follow-up public message' }],
        },
      }), 'utf8');
      const after = await contribution.readAfterTranscript({
        source: identity.value.source,
        remoteSessionId: firstSessionId,
        cursor: page.value.tailCursor!,
        maxItems: 10,
        ...invocation(),
      });
      expect(after).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ id: expect.any(String) })],
        },
      });
      if (!after.ok) throw new Error('Expected Codex transcript continuation');
      expect(after.value.items[0]).toMatchObject({
        id: expect.any(String),
        messageRole: 'agent',
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'message',
              message: 'follow-up public message',
            },
          },
        },
      });
      expect(after.value.items[0]?.id).not.toBe(page.value.items[0]?.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a bounded nonempty appended suffix as a gap instead of accepting a partial cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-read-after-bound-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:01:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial' }],
          },
        }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
      const initial = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      if (!initial.ok || !initial.value.tailCursor) {
        throw new Error('Expected a Codex tail cursor');
      }

      await appendFile(rolloutPath, [
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:02:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first appended item' }],
          },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:03:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'second appended item' }],
          },
        }),
      ].join(''), 'utf8');

      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: initial.value.tailCursor,
        maxItems: 1,
        ...invocation(),
      })).resolves.toEqual({
        ok: true,
        value: { outcome: 'gap_or_cursor_expired' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('advances malformed UTF-8 diagnostics through the public read-after result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-malformed-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T10:00:00.000Z',
          payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T10:00:01.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial' }],
          },
        }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
      const page = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      if (!page.ok || !page.value.tailCursor) throw new Error('Expected Codex tail cursor');

      const before = (await readFile(rolloutPath)).byteLength;
      const prefix = Buffer.from(
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"',
        'utf8',
      );
      await appendFile(
        rolloutPath,
        Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}}\n', 'utf8')]),
      );

      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: page.value.tailCursor,
        maxItems: 10,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: 'advanced',
          items: [],
          nextCursor: expect.any(String),
          boundary: expect.any(String),
          diagnostics: [{
            code: 'malformed_source_utf8',
            count: 1,
            positions: [before + prefix.byteLength],
          }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for cancellation, deadlines, invalid item limits, and unfit byte bounds', async () => {
    const controller = new AbortController();
    controller.abort();
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: '/tmp/codex-public-bounds' } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user' } as const;

    expect(await contribution.resolveSource({
      source,
      ...invocation({ signal: controller.signal }),
    })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await contribution.resolveSource({
      source,
      ...invocation({ deadlineAtMs: Date.now() - 1 }),
    })).toMatchObject({ ok: false, code: 'timeout' });
    await expect(contribution.listCandidates({
      source,
      maxItems: 0,
      searchMode: 'fast',
      ...invocation(),
    })).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    // A byte bound that is not a positive size is a MALFORMED inbound request.
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 0 }),
    })).toMatchObject({ ok: false, code: 'invalid_request' });
    // A well-formed bound the Agent's own OUTPUT cannot fit is not a caller
    // mistake to correct: it is a nonretryable Agent-side failure, and it is the
    // same classification the host's bounded-invocation owner already applies
    // when a leaf overruns the identical budget.
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 1 }),
    })).toMatchObject({ ok: false, code: 'agent_error', retryable: false });
  });

  it('keeps connected-service home identity qualified through candidates and persisted links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-connected-home-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const codexHome = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'openai-codex',
        'profile-1',
        'codex',
        'codex-home',
      );
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`),
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T10:00:00.000Z',
          payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo/connected' },
        }),
        'utf8',
      );
      const contribution = createCodexExternalSessionsContribution({
        env: {} as NodeJS.ProcessEnv,
      });
      const source = {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: codexHome,
      } as const;
      const canonicalSource = {
        ...source,
        homePath: await realpath(codexHome),
      };

      const listed = await contribution.listCandidates({
        source,
        maxItems: 10,
        searchMode: 'fast',
        ...invocation(),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId,
            linkData: { source: canonicalSource },
          }],
        },
      });
      if (!listed.ok) throw new Error('Expected connected-service Codex candidate');

      const linked = await contribution.resolveLinkedIdentity({
        source,
        remoteSessionId,
        linkData: listed.value.candidates[0]?.linkData ?? {},
        ...invocation(),
      });
      expect(linked).toMatchObject({
        ok: true,
        value: {
          source: canonicalSource,
          remoteSessionId,
          linkData: { source: canonicalSource },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the host-admitted connected-service home before granting media read roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-media-read-roots-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const verifiedHome = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'openai-codex',
        'profile-1',
        'codex',
        'codex-home',
      );
      await mkdir(join(verifiedHome, 'sessions'), { recursive: true });
      const contribution = createCodexExternalSessionsContribution({
        env: {} as NodeJS.ProcessEnv,
      });
      const unstampedSource = {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
      } as const;

      await expect(contribution.resolveSource({
        source: unstampedSource,
        ...invocation(),
      })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });

      const resolvedVerified = await contribution.resolveSource({
        source: { ...unstampedSource, homePath: verifiedHome },
        ...invocation(),
      });
      if (!resolvedVerified.ok) throw new Error('Expected a resolved Codex source');
      expect(resolvedVerified.value.transcriptMediaReadRoots).toEqual([await realpath(verifiedHome)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('canonicalizes supported backend-mode aliases and rejects unsupported link identity modes', async () => {
    const codexHome = '/tmp/codex-public-link-identity';
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'thread-alias',
      linkData: { codexBackendMode: 'mcp_resume' },
      ...invocation(),
    })).toMatchObject({
      ok: true,
      value: {
        remoteSessionId: 'thread-alias',
        linkData: {
          codexBackendMode: 'acp',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'acp',
              providerSessionId: 'thread-alias',
            },
          },
        },
      },
    });

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'thread-invalid',
      linkData: { codexBackendMode: 'unsupported-mode' },
      ...invocation(),
    })).toMatchObject({
      ok: false,
      code: 'source_invalid',
      message: 'codex_backend_mode_unsupported',
    });
    expect(await contribution.resolveLinkedIdentity({
      source,
      remoteSessionId: 'thread-invalid',
      linkData: { codexBackendMode: 'unsupported-mode' },
      ...invocation(),
    })).toMatchObject({
      ok: false,
      code: 'source_invalid',
      message: 'codex_backend_mode_unsupported',
    });
  });
});
