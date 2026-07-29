import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCodexExternalSessionsContribution } from './contribution.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function invocation(overrides: Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
  maxSerializedBytes?: number;
}> = {}) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 30_000,
    maxSerializedBytes: overrides.maxSerializedBytes ?? 64 * 1024,
  };
}

describe('Codex public Agent External Sessions contribution', () => {
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
        activeServerDir: join(root, 'active-server'),
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
      const contribution = createCodexExternalSessionsContribution({ env, activeServerDir });
      const source = { kind: 'codexHome', home: 'user' } as const;
      const resolvedSource = await contribution.resolveSource({ source, ...invocation() });
      expect(resolvedSource).toEqual({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
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
            type: 'message',
            message: 'first public message',
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
          type: 'message',
          message: 'follow-up public message',
        },
      });
      expect(after.value.items[0]?.id).not.toBe(page.value.items[0]?.id);
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
        activeServerDir: join(root, 'active-server'),
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
      activeServerDir: '/tmp/active-server',
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
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 1 }),
    })).toMatchObject({ ok: false, code: 'invalid_request' });
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
        activeServerDir,
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
