import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createHttpStatusError } from '@/api/client/httpStatusError';
import { encodeBase64, encrypt } from '@/api/encryption';
import type { FileBackedTranscriptSessionStore } from '@/api/session/fileBackedTranscripts/store';
import {
  createSessionTranscriptFollowLeaseRegistry,
  type SessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

import { createCliActionExecutor } from './createCliActionExecutor';
import { executeCliTranscriptAction } from './executeCliTranscriptAction';

type TranscriptItem = Readonly<{
  id: string;
  text?: string;
  content?: unknown;
}>;

type TranscriptExecutorTestParams = Parameters<typeof createCliActionExecutor>[0] & Readonly<{
  transcriptStore: FileBackedTranscriptSessionStore<TranscriptItem>;
  transcriptFollowLeaseRegistry?: SessionTranscriptFollowLeaseRegistry;
  writeTranscriptItems?: (
    sessionId: string,
    items: readonly TranscriptItem[],
  ) => Promise<Readonly<{ imported: number; cursor: string | null }>>;
  sessionLogAccess?: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
  }>;
}>;

function createTranscriptStore(
  overrides: Partial<FileBackedTranscriptSessionStore<TranscriptItem>>,
): FileBackedTranscriptSessionStore<TranscriptItem> {
  return {
    warm: async () => undefined,
    dispose: async () => undefined,
    setLifecycleState: async () => undefined,
    pageOlder: async () => ({ items: [], nextCursor: null, hasMore: false, tailCursor: null, truncated: false }),
    readAfter: async () => ({ items: [], nextCursor: null, truncated: false }),
    getTailCursor: () => 'tail',
    subscribe: () => () => undefined,
    getTitle: async () => null,
    getWorkingDirectory: async () => null,
    getActivity: async () => null,
    getPreview: async () => null,
    ...overrides,
  };
}

function createTranscriptExecutor(params: Partial<TranscriptExecutorTestParams>) {
  const encryptionKey = new Uint8Array(32).fill(7);
  return createCliActionExecutor({
    token: 'token-1',
    sessionId: 'session-1',
    ctx: { encryptionKey, encryptionVariant: 'dataKey' },
    transcriptStore: createTranscriptStore({}),
    ...params,
  } as TranscriptExecutorTestParams);
}

describe('createCliActionExecutor transcript actions', () => {
  it('executes transcript page/readAfter/search/follow through bounded transcript stores', async () => {
    const pageOlder = vi.fn(async () => ({
      items: [{ id: 'older', text: 'older row' }],
      nextCursor: 'before-1',
      hasMore: true,
      tailCursor: 'tail-1',
      truncated: false,
    }));
    const readAfter = vi.fn(async () => ({
      items: [{ id: 'newer', text: 'needle row' }],
      nextCursor: 'after-1',
      truncated: false,
    }));
    const store = createTranscriptStore({ pageOlder, readAfter });
    const executor = createTranscriptExecutor({
      transcriptStore: store,
      transcriptFollowLeaseRegistry: createSessionTranscriptFollowLeaseRegistry({ maxLeases: 2, idleTtlMs: 1000 }),
    });

    await expect(executor.execute('transcript.page', {
      sessionId: 'session-1',
      cursor: 'before-0',
      maxBytes: 4096,
      maxItems: 25,
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, items: [{ id: 'older', text: 'older row' }], nextCursor: 'before-1' },
    });
    await expect(executor.execute('transcript.readAfter', {
      sessionId: 'session-1',
      cursor: 'tail',
      maxBytes: 2048,
      maxItems: 10,
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, items: [{ id: 'newer', text: 'needle row' }], nextCursor: 'after-1' },
    });
    await expect(executor.execute('transcript.search', {
      sessionId: 'session-1',
      query: 'needle',
      cursor: 'tail',
      maxItems: 5,
      maxReads: 1,
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, items: [{ id: 'newer', text: 'needle row' }], nextCursor: 'after-1' },
    });
    await expect(executor.execute('transcript.follow', {
      sessionId: 'session-1',
      cursor: 'tail',
      leaseId: 'lease-1',
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, leaseId: 'lease-1' },
    });

    expect(pageOlder).toHaveBeenCalledWith({ cursor: 'before-0', maxBytes: 4096, maxItems: 25 });
    expect(readAfter).toHaveBeenCalledWith({ cursor: 'tail', maxBytes: 2048, maxItems: 10 });
  });

  it('preserves plain and encrypted transcript envelopes through page and import actions', async () => {
    const encryptionKey = new Uint8Array(32).fill(9);
    const plainContent = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'plain row' } } };
    const encryptedContent = {
      t: 'encrypted',
      c: encodeBase64(encrypt(encryptionKey, 'dataKey', {
        role: 'agent',
        content: { type: 'text', text: 'encrypted row' },
      })),
    };
    const store = createTranscriptStore({
      pageOlder: async () => ({
        items: [
          { id: 'plain', content: plainContent },
          { id: 'encrypted', content: encryptedContent },
        ],
        nextCursor: null,
        hasMore: false,
        tailCursor: 'tail',
        truncated: false,
      }),
    });
    const writeTranscriptItems = vi.fn(async (
      _sessionId: string,
      _items: readonly TranscriptItem[],
    ) => ({ imported: 2, cursor: 'tail-import' }));
    const executor = createCliActionExecutor({
      token: 'token-1',
      sessionId: 'session-1',
      mode: 'e2ee',
      ctx: { encryptionKey, encryptionVariant: 'dataKey' },
      transcriptStore: store,
      writeTranscriptItems,
    } as TranscriptExecutorTestParams);

    const page = await executor.execute('transcript.page', {}, { surface: 'rpc', defaultSessionId: 'session-1' });
    expect(page).toMatchObject({ ok: true });
    expect((page as { result: { items: readonly TranscriptItem[] } }).result.items.map((item) => item.content)).toEqual([
      plainContent,
      encryptedContent,
    ]);

    await expect(executor.execute('transcript.import', {
      items: [
        { id: 'plain', content: plainContent },
        { id: 'encrypted', content: encryptedContent },
      ],
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, imported: 2, cursor: 'tail-import' },
    });
    expect(writeTranscriptItems).toHaveBeenCalledTimes(1);
    expect(writeTranscriptItems.mock.calls[0]?.[0]).toBe('session-1');
    expect(writeTranscriptItems.mock.calls[0]?.[1].map((item) => item.content)).toEqual([
      plainContent,
      encryptedContent,
    ]);
  });

  it('returns the existing upgrade_required result when transcript.import reaches a pre-adapter server', async () => {
    const writeTranscriptItems = vi.fn(async () => {
      throw createHttpStatusError(404, 'Server upgrade required before transcript import.', 'upgrade_required');
    });
    const executor = createTranscriptExecutor({ writeTranscriptItems });

    await expect(executor.execute('transcript.import', {
      items: [{
        id: 'history-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } },
      }],
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        errorCode: 'upgrade_required',
        message: 'Server upgrade required before transcript import.',
      },
    });

    expect(writeTranscriptItems).toHaveBeenCalledOnce();
  });

  it('admits plugin transcript imports through the canonical caller policy before writing', async () => {
    const writeTranscriptItems = vi.fn(async (
      _sessionId: string,
      _items: readonly TranscriptItem[],
    ) => ({ imported: 1, cursor: 'tail-import' }));
    const executor = createTranscriptExecutor({ writeTranscriptItems });
    const input = {
      items: [{
        id: 'history-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'one' } } },
      }],
    };

    await expect(executor.execute('transcript.import', input, {
      surface: 'plugin',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(writeTranscriptItems).not.toHaveBeenCalled();

    await expect(executor.execute('transcript.import', input, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'happier.agent.acme',
        contributionLocalId: 'acme.sample',
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, imported: 1, cursor: 'tail-import' },
    });
    expect(writeTranscriptItems).toHaveBeenCalledTimes(1);
  });

  it('namespaces generated transcript import ids per import operation', async () => {
    const plainContent = { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'imported row' } } };
    const writeTranscriptItems = vi.fn(async (
      _sessionId: string,
      _items: readonly TranscriptItem[],
    ) => ({ imported: 1, cursor: 'tail-import' }));
    const executor = createCliActionExecutor({
      token: 'token-1',
      sessionId: 'session-1',
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'dataKey' },
      transcriptStore: createTranscriptStore({}),
      writeTranscriptItems,
    } as TranscriptExecutorTestParams);

    await expect(executor.execute('transcript.import', {
      items: [{ content: plainContent }],
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(executor.execute('transcript.import', {
      items: [{ content: plainContent }],
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(executor.execute('transcript.import', {
      items: [{ id: 'explicit-row', content: plainContent }],
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
    });

    const firstGeneratedId = writeTranscriptItems.mock.calls[0]?.[1][0]?.id;
    const secondGeneratedId = writeTranscriptItems.mock.calls[1]?.[1][0]?.id;
    expect(firstGeneratedId).toMatch(/^import:[0-9a-f-]{36}:0$/u);
    expect(secondGeneratedId).toMatch(/^import:[0-9a-f-]{36}:0$/u);
    expect(secondGeneratedId).not.toBe(firstGeneratedId);
    expect(writeTranscriptItems.mock.calls[2]?.[1][0]?.id).toBe('explicit-row');
  });

  it('tails session logs with offset and maxBytes bounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-session-log-tail-'));
    const logPath = join(dir, 'session.log');
    await writeFile(logPath, '0123456789abcdef', 'utf8');
    const executor = createTranscriptExecutor({
      sessionLogAccess: {
        workingDirectory: dir,
        accessPolicy: { kind: 'restrictedRoots', roots: [dir] },
      },
    });

    await expect(executor.execute('session.log.tail', {
      path: logPath,
      offset: 4,
      maxBytes: 6,
    }, { surface: 'rpc' })).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        path: logPath,
        tail: '456789',
        offset: 4,
        nextOffset: 10,
        truncated: true,
      },
    });
  });

  it('defaults transcript follow leases to the accepted 10 minute floor', async () => {
    vi.useFakeTimers();
    const executorUnsubscribe = vi.fn();
    const directUnsubscribe = vi.fn();
    const store = createTranscriptStore({
      readAfter: async () => ({ items: [], nextCursor: 'tail-2', truncated: false }),
      subscribe: () => executorUnsubscribe,
    });
    const executor = createTranscriptExecutor({ transcriptStore: store });
    const directStore = createTranscriptStore({
      readAfter: async () => ({ items: [], nextCursor: 'tail-3', truncated: false }),
      subscribe: () => directUnsubscribe,
    });

    try {
      await expect(executor.execute('transcript.follow', {
        sessionId: 'session-1',
        cursor: 'tail',
        leaseId: 'lease-default-floor',
      }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, leaseId: 'lease-default-floor' },
      });

      await expect(executeCliTranscriptAction({
        actionId: 'transcript.follow',
        input: {
          sessionId: 'session-1',
          cursor: 'tail',
          leaseId: 'lease-direct-default-floor',
        },
        context: { surface: 'rpc', defaultSessionId: 'session-1' },
        defaultSessionId: 'session-1',
        options: { transcriptStore: directStore },
      })).resolves.toMatchObject({
        ok: true,
        result: { ok: true, leaseId: 'lease-direct-default-floor' },
      });

      await vi.advanceTimersByTimeAsync(60_001);
      expect(executorUnsubscribe).not.toHaveBeenCalled();
      expect(directUnsubscribe).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(540_000);
      expect(executorUnsubscribe).toHaveBeenCalledTimes(1);
      expect(directUnsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
