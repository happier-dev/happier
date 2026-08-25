import { appendFile, mkdir, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawJSONLines } from '../types';
import { getProjectPath } from '../utils/path';
import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';
import { createClaudeUnifiedTranscriptBridge } from './createClaudeUnifiedTranscriptBridge';
import { createReplayableHookSubscription } from './createReplayableHookSubscription';

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendJsonl(path: string, message: RawJSONLines): Promise<void> {
  await appendFile(path, `${JSON.stringify(message)}\n`);
}

async function appendRawJsonl(path: string, message: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(message)}\n`);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createClaudeUnifiedTranscriptBridge', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('forwards new Claude transcript rows through the remote message callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_1.jsonl');
    await writeFile(transcriptPath, '');

    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_1',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'assistant_1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from transcript' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'assistant',
        uuid: 'assistant_1',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('observes internal queued-command transcript rows without emitting them as visible messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-raw-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_raw.jsonl');
    await writeFile(transcriptPath, '');

    const onRawTranscriptValue = vi.fn();
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_raw',
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue,
      onMessage,
      onTranscriptMessage,
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await appendRawJsonl(transcriptPath, {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        sessionId: 'sess_raw',
        content: 'Please continue from the current point.',
      });

      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 1);
      expect(onRawTranscriptValue).toHaveBeenCalledWith(expect.objectContaining({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'Please continue from the current point.',
      }), { historicalReplay: false });
      expect(onMessage).not.toHaveBeenCalled();
      expect(onTranscriptMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.dispose();
    }
  });

  it('does not forward historical raw rows after the known-resume raw follower resets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-raw-reset-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_raw_reset.jsonl');
    await writeFile(transcriptPath, '');

    const onRawTranscriptValue = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_raw_reset',
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue,
      subscribeClaudeSessionHooks: () => () => {},
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await appendRawJsonl(transcriptPath, {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date().toISOString(),
        sessionId: 'sess_raw_reset',
        content: 'initial live raw row',
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length >= 1);

      const replacementPath = `${transcriptPath}.replacement`;
      await writeFile(
        replacementPath,
        [
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            sessionId: 'sess_raw_reset',
            content: 'old raw row after replacement',
          }),
          JSON.stringify({
            type: 'queue-operation',
            operation: 'enqueue',
            timestamp: new Date(Date.now() + 1000).toISOString(),
            sessionId: 'sess_raw_reset',
            content: 'fresh raw row after replacement',
          }),
        ].join('\n') + '\n',
      );
      await rename(replacementPath, transcriptPath);

      await waitUntil(() => onRawTranscriptValue.mock.calls.some(([value]) => (
        (value as { content?: unknown } | null)?.content === 'fresh raw row after replacement'
      )));
      const contents = onRawTranscriptValue.mock.calls.map(([value]) => (
        (value as { content?: unknown } | null)?.content
      ));
      expect(contents).toContain('initial live raw row');
      expect(contents).toContain('fresh raw row after replacement');
      expect(contents).not.toContain('old raw row after replacement');
    } finally {
      await bridge.dispose();
    }
  });

  it('routes exact known-resume acceptance through the trusted proof before SessionStart or scanner startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-known-resume-proof-'));
    tempDirs.push(dir);
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let resolveBaseline: (() => void) | undefined;
    const baselineBarrier = new Promise<void>((resolve) => {
      resolveBaseline = resolve;
    });
    const prompt = 'the exact queued steer';
    const enqueuedAt = '2026-07-22T13:10:47.992Z';
    const acceptedPromptDiscovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => Date.parse(enqueuedAt),
    });
    acceptedPromptDiscovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: Date.parse(enqueuedAt),
      deliveryIdentity: { localIds: ['current-queued-steer-local-id'], userMessageSeq: 93 },
    });
    const acceptedMatches: unknown[] = [];
    const onRawTranscriptValue = vi.fn();
    const onSessionFound = vi.fn();
    const proveAcceptedMainTranscript = vi.fn((value: unknown) => {
      const match = acceptedPromptDiscovery.findMatchingTranscript([value]);
      if (!match) return false;
      acceptedMatches.push(match);
      return acceptedPromptDiscovery.consumeAcceptedPromptMatch(match);
    });
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId,
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue,
      onSessionFound,
      proveAcceptedMainTranscript,
      loadCommittedClaudeJsonlMessageBaseline: async () => {
        await baselineBarrier;
        return { keys: new Set<string>(), complete: true, oldestCoveredAtMs: null };
      },
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    const startPromise = bridge.start({ abortSignal: new AbortController().signal });
    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      await appendRawJsonl(transcriptPath, {
        parentUuid: 'wrong-session-parent',
        isSidechain: false,
        type: 'attachment',
        uuid: 'wrong-session-queued-command',
        timestamp: enqueuedAt,
        sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: enqueuedAt,
        },
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 1);
      expect(proveAcceptedMainTranscript).not.toHaveBeenCalled();

      await appendRawJsonl(transcriptPath, {
        parentUuid: 'sidechain-parent',
        isSidechain: true,
        type: 'attachment',
        uuid: 'sidechain-queued-command',
        timestamp: enqueuedAt,
        sessionId,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: enqueuedAt,
        },
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 2);
      expect(acceptedMatches).toHaveLength(0);

      await appendRawJsonl(transcriptPath, {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: enqueuedAt,
        sessionId,
        content: prompt,
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 3);
      expect(acceptedMatches).toHaveLength(0);

      await appendRawJsonl(transcriptPath, {
        type: 'queue-operation',
        operation: 'remove',
        timestamp: '2026-07-22T13:10:50.783Z',
        sessionId,
        content: prompt,
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 4);
      expect(acceptedMatches).toHaveLength(0);

      await appendRawJsonl(transcriptPath, {
        parentUuid: 'main-chain-parent',
        isSidechain: false,
        type: 'attachment',
        uuid: 'known-resume-queued-command',
        timestamp: enqueuedAt,
        sessionId,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: enqueuedAt,
        },
      });

      await waitUntil(() => acceptedMatches.length === 1);
      expect(proveAcceptedMainTranscript).toHaveBeenCalledWith(expect.objectContaining({
        type: 'attachment',
        uuid: 'known-resume-queued-command',
      }));
      expect(acceptedMatches).toEqual([expect.objectContaining({
        deliveryIdentity: { localIds: ['current-queued-steer-local-id'], userMessageSeq: 93 },
        transcriptUuid: 'known-resume-queued-command',
      })]);
      expect(onSessionFound).not.toHaveBeenCalled();

      const proofCallsBeforeRotation = proveAcceptedMainTranscript.mock.calls.length;
      subscribedHook?.({
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        transcript_path: join(dir, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl'),
      });
      expect(onSessionFound).toHaveBeenCalledTimes(1);

      await appendRawJsonl(transcriptPath, {
        parentUuid: 'stale-known-resume-parent',
        isSidechain: false,
        type: 'attachment',
        uuid: 'stale-known-resume-queued-command',
        timestamp: enqueuedAt,
        sessionId,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: enqueuedAt,
        },
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length === 6);
      expect(proveAcceptedMainTranscript).toHaveBeenCalledTimes(proofCallsBeforeRotation);
    } finally {
      resolveBaseline?.();
      await startPromise;
      await bridge.dispose();
    }
  });

  it('binds a known resumed session to the canonical transcript path when no transcriptPath or SessionStart is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-known-canonical-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const sessionId = 'sess_known_canonical';
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onTranscriptMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      expect(subscribedHook).toBeTypeOf('function');
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'known_canonical_assistant_row',
        timestamp: new Date().toISOString(),
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from known canonical transcript' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onTranscriptMessage.mock.calls.length === 1);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'assistant',
        uuid: 'known_canonical_assistant_row',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not let historical compact replay drive lifecycle before a known resumed session becomes live', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-known-resume-lifecycle-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const sessionId = 'sess_known_resume_lifecycle';
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'historical_compact_boundary',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      sessionId,
      compactMetadata: { trigger: 'auto' },
    })}\n`);

    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onTranscriptMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set<string>(),
        complete: true,
        oldestCoveredAtMs: null,
      }),
      subscribeClaudeSessionHooks: () => () => {},
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await waitMs(100);
      expect(onTranscriptMessage).not.toHaveBeenCalled();

      await appendJsonl(transcriptPath, {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'live_compact_boundary',
        timestamp: new Date().toISOString(),
        sessionId,
        compactMetadata: { trigger: 'auto' },
      } as RawJSONLines);

      await waitUntil(() => onTranscriptMessage.mock.calls.length === 1);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'live_compact_boundary',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('suppresses historical resume rows in a fresh Happier session while emitting the newly accepted prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-resume-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_resume.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    const historicalMessage = {
      type: 'user',
      uuid: 'historical_user_prompt',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      sessionId: 'sess_resume',
      message: {
        role: 'user',
        content: 'old prompt from the resumed Claude transcript',
      },
    } as RawJSONLines;
    await appendJsonl(transcriptPath, historicalMessage);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      onTranscriptMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_resume',
        transcript_path: transcriptPath,
      });

      await appendJsonl(transcriptPath, {
        type: 'user',
        uuid: 'live_user_prompt_after_resume',
        timestamp: new Date(Date.now() + 10_000).toISOString(),
        sessionId: 'sess_resume',
        message: {
          role: 'user',
          content: 'new prompt accepted after Happier resumed Claude',
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.some(([message]) => message?.uuid === 'live_user_prompt_after_resume'));
      expect(onMessage.mock.calls.map(([message]) => message?.uuid)).toEqual(['live_user_prompt_after_resume']);
      await waitUntil(() => onTranscriptMessage.mock.calls.length === 1);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'live_user_prompt_after_resume',
      }));

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'live_assistant_end_turn',
        timestamp: new Date(Date.now() + 10_000).toISOString(),
        sessionId: 'sess_resume',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'live response' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onTranscriptMessage.mock.calls.length === 2);
      expect(onTranscriptMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'live_assistant_end_turn',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('ignores sidechain SessionStart hooks: a subagent must never re-key the session/resume identity (A4-MED-2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_main.jsonl');
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onSessionFound = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onSessionFound,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('hook subscription missing');

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_sidechain',
        transcript_path: join(dir, 'sess_sidechain.jsonl'),
        agent_id: 'subagent-1',
      });
      expect(onSessionFound).not.toHaveBeenCalled();

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_main',
        transcript_path: transcriptPath,
      });
      expect(onSessionFound).toHaveBeenCalledTimes(1);
      expect(onSessionFound).toHaveBeenCalledWith('sess_main', expect.objectContaining({ session_id: 'sess_main' }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not pre-mark a known hook-driven resume transcript before Claude announces SessionStart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-known-resume-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_known_resume.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'missed_during_runner_restart',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: 'sess_known_resume',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'completed while the Happier runner was down' }],
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_known_resume',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      onTranscriptMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      expect(onMessage).not.toHaveBeenCalled();

      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_known_resume',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'missed_during_runner_restart',
      }));
      expect(onTranscriptMessage).not.toHaveBeenCalled();
    } finally {
      await bridge.dispose();
    }
  });

  it('feeds provider Activity only from the live tail of the exact current SessionStart binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-live-activity-'));
    tempDirs.push(dir);
    const firstTranscriptPath = join(dir, 'activity-session-1.jsonl');
    const secondTranscriptPath = join(dir, 'activity-session-2.jsonl');
    await writeFile(firstTranscriptPath, `${JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      session_id: 'activity-session-1',
      task_id: 'historical-task',
    })}\n`);
    await writeFile(secondTranscriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const onLiveProviderTaskJsonlValue = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      onLiveProviderTaskJsonlValue,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'activity-session-1',
        transcript_path: firstTranscriptPath,
      });
      await waitMs(100);
      expect(onLiveProviderTaskJsonlValue).not.toHaveBeenCalled();

      await appendRawJsonl(firstTranscriptPath, {
        type: 'system',
        subtype: 'task_started',
        session_id: 'activity-session-1',
        task_id: 'live-task',
      });
      await waitUntil(() => onLiveProviderTaskJsonlValue.mock.calls.length === 1);

      hook({
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'activity-session-2',
        transcript_path: secondTranscriptPath,
      });
      await waitMs(100);
      await appendRawJsonl(firstTranscriptPath, {
        type: 'system',
        subtype: 'task_updated',
        session_id: 'activity-session-1',
        task_id: 'live-task',
        patch: { status: 'killed' },
      });
      await appendRawJsonl(secondTranscriptPath, {
        type: 'system',
        subtype: 'task_updated',
        session_id: 'activity-session-1',
        task_id: 'live-task',
        patch: { status: 'killed' },
      });
      await waitMs(150);
      expect(onLiveProviderTaskJsonlValue).toHaveBeenCalledTimes(1);

      await appendRawJsonl(secondTranscriptPath, {
        type: 'system',
        subtype: 'task_updated',
        session_id: 'activity-session-2',
        task_id: 'live-task',
        patch: { status: 'killed' },
      });
      await waitUntil(() => onLiveProviderTaskJsonlValue.mock.calls.length === 2);
      expect(onLiveProviderTaskJsonlValue).toHaveBeenLastCalledWith({
        sessionId: 'activity-session-2',
        value: expect.objectContaining({
          subtype: 'task_updated',
          patch: { status: 'killed' },
        }),
      });

      await appendRawJsonl(secondTranscriptPath, {
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: 'activity-session-2',
        content: [
          '<task-notification>',
          '<task-id>live-task</task-id>',
          '<status>completed</status>',
          '</task-notification>',
        ].join(''),
      });
      await waitUntil(() => onLiveProviderTaskJsonlValue.mock.calls.length === 3);
      expect(onLiveProviderTaskJsonlValue).toHaveBeenLastCalledWith({
        sessionId: 'activity-session-2',
        value: expect.objectContaining({
          type: 'queue-operation',
          operation: 'enqueue',
        }),
      });
    } finally {
      await bridge.dispose();
    }
  });

  it('does not replay prior-era failed resume terminal rows as fresh visible messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-prior-failed-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_prior_failed_resume.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    const sessionId = 'sess_prior_failed_resume';
    await appendJsonl(transcriptPath, {
      type: 'user',
      uuid: 'prior_era_user_prompt',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      sessionId,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'old prompt' }],
      },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'prior_era_api_error',
      timestamp: new Date(Date.now() - 59_000).toISOString(),
      sessionId,
      isApiErrorMessage: true,
      error: 'server_error',
      message: {
        role: 'assistant',
        content: 'API Error: terminal failure from a prior runner era.',
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const onTranscriptMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId,
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      onTranscriptMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set<string>(),
        complete: true,
        oldestCoveredAtMs: null,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      expect(onMessage).not.toHaveBeenCalled();

      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: sessionId,
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.some(([message]) => message?.uuid === 'prior_era_user_prompt'));
      await waitMs(150);

      const visibleUuidsAfterResume = onMessage.mock.calls.map(([message]) => message?.uuid);
      expect(visibleUuidsAfterResume).not.toContain('prior_era_api_error');
      expect(onTranscriptMessage.mock.calls.map(([message]) => message?.uuid)).not.toContain(
        'prior_era_api_error',
      );

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'live_api_error',
        timestamp: new Date(Date.now() + 10_000).toISOString(),
        sessionId,
        isApiErrorMessage: true,
        error: 'server_error',
        message: {
          role: 'assistant',
          content: 'API Error: terminal failure observed by this runner.',
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.some(([message]) => message?.uuid === 'live_api_error'));
      await waitUntil(() =>
        onTranscriptMessage.mock.calls.some(([message]) => message?.uuid === 'live_api_error'),
      );
      await waitMs(150);

      const visibleUuidsAfterLiveFailure = onMessage.mock.calls.map(([message]) => message?.uuid);
      const lifecycleUuidsAfterLiveFailure = onTranscriptMessage.mock.calls.map(([message]) => message?.uuid);
      expect(visibleUuidsAfterLiveFailure.filter(uuid => uuid === 'live_api_error')).toHaveLength(1);
      expect(lifecycleUuidsAfterLiveFailure.filter(uuid => uuid === 'live_api_error')).toHaveLength(1);
    } finally {
      await bridge.dispose();
    }
  });

  it('replays an early SessionStart through the identity owner, then re-reports once on exact proof', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-proof-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    const exactPrompt = 'the exact Happier-injected prompt';
    const acceptedPromptDiscovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
    });
    acceptedPromptDiscovery.recordAcceptedPrompt({ message: exactPrompt });

    let upstreamHook: ((data: SessionHookData) => void) | undefined;
    const replayableHooks = createReplayableHookSubscription((callback) => {
      upstreamHook = callback;
      return () => {
        upstreamHook = undefined;
      };
    });
    const lifecycleHooks: SessionHookData[] = [];
    const emitLifecycleHook = (data: SessionHookData): void => {
      lifecycleHooks.push(data);
      const callback = upstreamHook;
      if (!callback) throw new Error('Claude upstream hook subscription was not registered');
      callback(data);
    };
    const onSessionFound = vi.fn();
    const proveAcceptedMainTranscript = vi.fn((value: unknown) => (
      acceptedPromptDiscovery.findMatchingTranscript([value]) !== null
    ));
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage: vi.fn(),
      onSessionFound,
      proveAcceptedMainTranscript,
      subscribeClaudeSessionHooks: replayableHooks.subscribe,
      transcriptMissingWarningMs: 0,
    });

    try {
      const sessionId = '12121212-1212-4212-8212-121212121212';
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      const originalSessionStart: SessionHookData = {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: sessionId,
        transcript_path: transcriptPath,
      };

      // Global hook ingress publishes before the bridge subscribes; replay preserves the event for
      // this single identity owner, which validates and reports it exactly once.
      emitLifecycleHook(originalSessionStart);
      await appendRawJsonl(transcriptPath, {
        type: 'mode',
        mode: 'normal',
        sessionId,
      });

      await bridge.start({ abortSignal: new AbortController().signal });
      expect(onSessionFound).toHaveBeenCalledTimes(1);

      emitLifecycleHook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'mismatched-user-prompt-session',
      });
      emitLifecycleHook({
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
      });
      emitLifecycleHook({
        hook_event_name: 'Stop',
        session_id: 'mismatched-stop-session',
      });
      emitLifecycleHook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sidechain-session',
        transcript_path: join(dir, 'sidechain-session.jsonl'),
        agent_id: 'subagent-1',
      });
      expect(onSessionFound).toHaveBeenCalledTimes(1);

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'unrelated_row_before_accepted_prompt',
        timestamp: new Date().toISOString(),
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
      } as RawJSONLines);
      await waitMs(100);
      expect(onSessionFound).toHaveBeenCalledTimes(1);

      await appendJsonl(transcriptPath, {
        type: 'user',
        uuid: 'accepted_main_prompt',
        promptId: 'accepted-main-prompt-id',
        timestamp: new Date().toISOString(),
        sessionId,
        isSidechain: false,
        message: { role: 'user', content: exactPrompt },
      } as RawJSONLines);
      await waitUntil(() => onSessionFound.mock.calls.length === 2);
      expect(onSessionFound).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        transcript_path: transcriptPath,
      }));
      expect(onSessionFound.mock.calls[1]?.[1]).toBe(originalSessionStart);

      await appendJsonl(transcriptPath, {
        type: 'user',
        uuid: 'repeated_accepted_main_prompt_after_proof',
        promptId: 'repeated-accepted-main-prompt-id',
        timestamp: new Date().toISOString(),
        sessionId,
        isSidechain: false,
        message: { role: 'user', content: exactPrompt },
      } as RawJSONLines);
      const proofCallsBeforeRepeatedRow = proveAcceptedMainTranscript.mock.calls.length;
      await waitUntil(() => proveAcceptedMainTranscript.mock.calls.length > proofCallsBeforeRepeatedRow);
      expect(onSessionFound).toHaveBeenCalledTimes(2);

      const compactSessionId = '13131313-1313-4131-8131-131313131313';
      const compactSessionStart: SessionHookData = {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: compactSessionId,
        transcript_path: join(projectDir, `${compactSessionId}.jsonl`),
      };
      emitLifecycleHook(compactSessionStart);
      expect(onSessionFound).toHaveBeenCalledTimes(3);
      expect(onSessionFound).toHaveBeenLastCalledWith(compactSessionId, compactSessionStart);
      expect(lifecycleHooks).toHaveLength(6);
    } finally {
      await bridge.dispose();
      replayableHooks.dispose();
    }
  });

  it('promotes an exactly classified main transcript when SessionStart never arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-main-discovery-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    const onSessionFound = vi.fn();
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      onSessionFound,
      subscribeClaudeSessionHooks: () => () => undefined,
      classifyDiscoveredSession: ({ messages }) => (
        messages.some((message) => message.uuid === 'accepted_prompt_without_hook') ? 'main' : null
      ),
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });

      const sessionId = '22222222-2222-4222-8222-222222222222';
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
      await appendJsonl(transcriptPath, {
        type: 'user',
        uuid: 'accepted_prompt_without_hook',
        timestamp: new Date().toISOString(),
        sessionId,
        message: {
          role: 'user',
          content: 'the exact Happier-injected prompt',
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      await waitUntil(() => onSessionFound.mock.calls.length === 1);
      expect(onSessionFound).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        session_id: sessionId,
        transcript_path: transcriptPath,
        source: 'transcript_discovery',
      }));

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'later_row_from_same_discovered_session',
        timestamp: new Date().toISOString(),
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'continued output' }],
        },
      } as RawJSONLines);
      await waitUntil(() => onMessage.mock.calls.length === 2);
      expect(onSessionFound).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.dispose();
    }
  });

  it('rebinds a discovered main transcript when a trusted primary SessionStart rotates the Claude identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-discovery-rotation-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onSessionFound = vi.fn();
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      onSessionFound,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      classifyDiscoveredSession: ({ messages }) => (
        messages.some((message) => message.uuid === 'accepted_prompt_before_compact') ? 'main' : null
      ),
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });

      const discoveredSessionId = '23232323-2323-4232-8232-232323232323';
      const discoveredTranscriptPath = join(projectDir, `${discoveredSessionId}.jsonl`);
      await appendJsonl(discoveredTranscriptPath, {
        type: 'user',
        uuid: 'accepted_prompt_before_compact',
        timestamp: new Date().toISOString(),
        sessionId: discoveredSessionId,
        message: { role: 'user', content: 'the exact Happier-injected prompt' },
      } as RawJSONLines);
      await waitUntil(() => onSessionFound.mock.calls.length === 1);
      await waitUntil(() => onMessage.mock.calls.length === 1);

      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const rotatedSessionId = '24242424-2424-4242-8242-242424242424';
      const rotatedTranscriptPath = join(projectDir, `${rotatedSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: rotatedSessionId,
        transcript_path: rotatedTranscriptPath,
      });
      await appendJsonl(rotatedTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_after_trusted_rotation',
        timestamp: new Date().toISOString(),
        sessionId: rotatedSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'continued after compact' }] },
      } as RawJSONLines);

      await waitUntil(() => onSessionFound.mock.calls.length === 2);
      await waitUntil(() => onMessage.mock.calls.length === 2);
      expect(onSessionFound).toHaveBeenNthCalledWith(2, rotatedSessionId, expect.objectContaining({
        session_id: rotatedSessionId,
        transcript_path: rotatedTranscriptPath,
        source: 'compact',
      }));
      expect(onMessage).toHaveBeenLastCalledWith(expect.objectContaining({
        sessionId: rotatedSessionId,
        uuid: 'assistant_after_trusted_rotation',
      }));

      await appendJsonl(discoveredTranscriptPath, {
        type: 'assistant',
        uuid: 'stale_assistant_from_discovered_transcript',
        timestamp: new Date().toISOString(),
        sessionId: discoveredSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'stale prior transcript output' }] },
      } as RawJSONLines);
      await waitMs(100);
      expect(onMessage).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.dispose();
    }
  });

  it('does not promote a discovery candidate that loses a re-entrant race to trusted SessionStart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-discovery-hook-race-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    const discoveredSessionId = '25252525-2525-4252-8252-252525252525';
    const discoveredTranscriptPath = join(projectDir, `${discoveredSessionId}.jsonl`);
    const trustedSessionId = '26262626-2626-4262-8262-262626262626';
    const trustedTranscriptPath = join(projectDir, `${trustedSessionId}.jsonl`);
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let injectedTrustedHook = false;
    const onSessionFound = vi.fn();
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      onSessionFound,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      classifyDiscoveredSession: ({ sessionId, messages }) => {
        if (sessionId !== discoveredSessionId) return null;
        if (!messages.some((message) => message.uuid === 'accepted_prompt_during_hook_race')) return null;
        if (!injectedTrustedHook) {
          injectedTrustedHook = true;
          subscribedHook?.({
            hook_event_name: 'SessionStart',
            source: 'compact',
            session_id: trustedSessionId,
            transcript_path: trustedTranscriptPath,
          });
        }
        return 'main';
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      await writeFile(trustedTranscriptPath, '');
      await appendJsonl(discoveredTranscriptPath, {
        type: 'user',
        uuid: 'accepted_prompt_during_hook_race',
        timestamp: new Date().toISOString(),
        sessionId: discoveredSessionId,
        message: { role: 'user', content: 'the exact Happier-injected prompt' },
      } as RawJSONLines);

      await waitUntil(() => onSessionFound.mock.calls.length >= 1);
      await waitMs(100);
      expect(onSessionFound).toHaveBeenCalledTimes(1);
      expect(onSessionFound).toHaveBeenCalledWith(trustedSessionId, expect.objectContaining({
        session_id: trustedSessionId,
        transcript_path: trustedTranscriptPath,
        source: 'compact',
      }));

      await appendJsonl(trustedTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_race_winning_hook',
        timestamp: new Date().toISOString(),
        sessionId: trustedSessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'trusted output' }] },
      } as RawJSONLines);
      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: trustedSessionId,
        uuid: 'assistant_from_race_winning_hook',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not let unhooked API-error discovery block trusted SessionStart binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-error-before-hook-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const unhookedSessionId = '66666666-6666-4666-8666-666666666666';
      const unhookedTranscriptPath = join(projectDir, `${unhookedSessionId}.jsonl`);
      await appendJsonl(unhookedTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_auth_failure_before_session_start',
        timestamp: new Date().toISOString(),
        sessionId: unhookedSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
        error: 'authentication_failed',
        isApiErrorMessage: true,
      } as RawJSONLines);

      const liveSessionId = '77777777-7777-4777-8777-777777777777';
      const liveTranscriptPath = join(projectDir, `${liveSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: liveSessionId,
        transcript_path: liveTranscriptPath,
      });
      await appendJsonl(liveTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_trusted_session_start',
        timestamp: new Date().toISOString(),
        sessionId: liveSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'trusted live session message' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: liveSessionId,
        uuid: 'assistant_from_trusted_session_start',
      }));
      expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        sessionId: unhookedSessionId,
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('ignores metadata probe transcripts before binding to the trusted SessionStart transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-probe-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const probeSessionId = '44444444-4444-4444-8444-444444444444';
      await appendJsonl(join(projectDir, `${probeSessionId}.jsonl`), {
        type: 'user',
        uuid: 'metadata_probe_user',
        timestamp: new Date().toISOString(),
        sessionId: probeSessionId,
        message: {
          role: 'user',
          content: 'hello',
        },
      } as RawJSONLines);

      await waitMs(1_250);
      expect(onMessage).not.toHaveBeenCalled();

      const liveSessionId = '55555555-5555-4555-8555-555555555555';
      const liveTranscriptPath = join(projectDir, `${liveSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: liveSessionId,
        transcript_path: liveTranscriptPath,
      });
      await appendJsonl(liveTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_live_tui',
        timestamp: new Date().toISOString(),
        sessionId: liveSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'LANE_T_LINUX_CONNECTED_SERVICE_OK' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: liveSessionId,
        uuid: 'assistant_from_live_tui',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('does not import later unrelated Claude sessions after binding a fresh unified transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-binding-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    await mkdir(workspaceDir, { recursive: true });
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      const firstSessionId = '22222222-2222-4222-8222-222222222222';
      const firstTranscriptPath = join(projectDir, `${firstSessionId}.jsonl`);
      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: firstSessionId,
        transcript_path: firstTranscriptPath,
      });
      await appendJsonl(firstTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_bound_session',
        timestamp: new Date().toISOString(),
        sessionId: firstSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'belongs to this Happier session' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: firstSessionId,
        uuid: 'assistant_from_bound_session',
      }));

      const secondSessionId = '33333333-3333-4333-8333-333333333333';
      const secondTranscriptPath = join(projectDir, `${secondSessionId}.jsonl`);
      await appendJsonl(secondTranscriptPath, {
        type: 'assistant',
        uuid: 'assistant_from_other_session',
        timestamp: new Date().toISOString(),
        sessionId: secondSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'belongs to a different Happier session' }],
        },
      } as RawJSONLines);

      await waitMs(1_250);
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.dispose();
    }
  });

  it('seeds hook-driven resume backfill from committed Claude JSONL keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-committed-keys-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    const transcriptPath = join(projectDir, 'sess_committed_keys.jsonl');
    await mkdir(projectDir, { recursive: true });
    await writeFile(transcriptPath, '');

    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'already_committed',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: 'sess_committed_keys',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'already in Happier' }],
      },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'missing_while_runner_was_down',
      timestamp: new Date(Date.now() - 20_000).toISOString(),
      sessionId: 'sess_committed_keys',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'missing from Happier' }],
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_committed_keys',
      transcriptPath: null,
      workingDirectory: workspaceDir,
      claudeConfigDir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set(['main:assistant:already_committed']),
        complete: true,
        oldestCoveredAtMs: null,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });

      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_committed_keys',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'missing_while_runner_was_down',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('keeps cutoff-null snapshot replay of a timestamp-less control permanently non-durable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-control-replay-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_control_replay.jsonl');
    const historicalControlRow = {
      type: 'user',
      uuid: 'historical-effort-control',
      promptId: 'historical-effort-control-prompt',
      sessionId: 'sess_control_replay',
      message: {
        role: 'user',
        content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>high</command-args>',
      },
    } satisfies RawJSONLines;
    await writeFile(transcriptPath, `${JSON.stringify(historicalControlRow)}\n`);

    let nowMs = 10_000;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => nowMs,
    });
    const rawValues: unknown[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_control_replay',
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue: (value) => {
        rawValues.push(value);
        discovery.observeControlCommandTranscript(value);
      },
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set<string>(),
        complete: true,
        oldestCoveredAtMs: null,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_control_replay',
        transcript_path: transcriptPath,
      });
      await waitUntil(() => rawValues.length > 0);

      nowMs = 10_010;
      discovery.recordAcceptedPrompt({
        message: '/effort high',
        acceptedAtMs: 10_010,
        deliveryIdentity: { localIds: ['later-durable-effort'] },
      });

      expect(discovery.findMatchingTranscript([historicalControlRow])).toBeNull();
    } finally {
      await bridge.dispose();
    }
  });

  it('does not prove a native queue episode from historical replay, then accepts the next fresh episode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-native-queue-replay-'));
    tempDirs.push(dir);
    const sessionId = 'sess_native_queue_replay';
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    const prompt = 'the exact current queued steer';
    const historicalRows = [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: new Date(1_000).toISOString(),
        sessionId,
        content: prompt,
      },
      {
        type: 'queue-operation',
        operation: 'remove',
        timestamp: new Date(1_100).toISOString(),
        sessionId,
        content: prompt,
      },
      {
        parentUuid: 'historical-parent',
        isSidechain: false,
        type: 'attachment',
        uuid: 'historical-queued-command',
        timestamp: new Date(1_050).toISOString(),
        sessionId,
        attachment: {
          type: 'queued_command',
          prompt,
          commandMode: 'prompt',
          origin: { kind: 'human' },
          timestamp: new Date(1_050).toISOString(),
        },
      },
    ] as unknown as RawJSONLines[];
    await writeFile(transcriptPath, `${historicalRows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    discovery.recordAcceptedPrompt({
      message: prompt,
      acceptedAtMs: 10_000,
      deliveryIdentity: { localIds: ['current-native-queue-attempt'] },
    });
    const onRawTranscriptValue = vi.fn();
    const acceptedMatches: unknown[] = [];
    const proveAcceptedMainTranscript = vi.fn((value: unknown) => {
      const match = discovery.findMatchingTranscript([value]);
      if (!match) return false;
      acceptedMatches.push(match);
      return discovery.consumeAcceptedPromptMatch(match);
    });
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId,
      transcriptPath,
      workingDirectory: dir,
      onRawTranscriptValue,
      proveAcceptedMainTranscript,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set<string>(),
        complete: true,
        oldestCoveredAtMs: null,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: sessionId,
        transcript_path: transcriptPath,
      });
      await waitUntil(() => onRawTranscriptValue.mock.calls.length === historicalRows.length);

      expect(proveAcceptedMainTranscript).not.toHaveBeenCalled();
      expect(acceptedMatches).toHaveLength(0);

      for (const row of [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: new Date(10_250).toISOString(),
          sessionId,
          content: prompt,
        },
        {
          type: 'queue-operation',
          operation: 'remove',
          timestamp: new Date(10_500).toISOString(),
          sessionId,
          content: prompt,
        },
        {
          parentUuid: 'fresh-parent',
          isSidechain: false,
          type: 'attachment',
          uuid: 'fresh-queued-command',
          timestamp: new Date(10_245).toISOString(),
          sessionId,
          attachment: {
            type: 'queued_command',
            prompt,
            commandMode: 'prompt',
            origin: { kind: 'human' },
            timestamp: new Date(10_245).toISOString(),
          },
        },
      ] as unknown as RawJSONLines[]) {
        await appendRawJsonl(transcriptPath, row);
      }

      await waitUntil(() => acceptedMatches.length === 1);
      expect(acceptedMatches).toEqual([expect.objectContaining({
        deliveryIdentity: { localIds: ['current-native-queue-attempt'] },
        transcriptUuid: 'fresh-queued-command',
      })]);
    } finally {
      await bridge.dispose();
    }
  });

  // Lane N4 (incident pid-44935): a same-session resume re-sent 104 historical rows because the
  // committed-keys baseline only covers the most recent transcript window. Rows OLDER than the
  // baseline coverage cannot be proven uncommitted, so they must never replay-as-new; rows newer
  // than the coverage (written while the runner was down) still backfill.
  it('does not replay snapshot rows older than the committed baseline coverage window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-coverage-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_coverage.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    const nowMs = Date.now();
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'older_than_coverage',
      timestamp: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
      sessionId: 'sess_coverage',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old committed history' }] },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'missed_during_downtime',
      timestamp: new Date(nowMs - 20_000).toISOString(),
      sessionId: 'sess_coverage',
      message: { role: 'assistant', content: [{ type: 'text', text: 'missing from Happier' }] },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_coverage',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({
        keys: new Set<string>(),
        complete: false,
        oldestCoveredAtMs: nowMs - 60_000,
      }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_coverage',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length >= 1);
      await waitMs(150);
      expect(onMessage.mock.calls.map(([message]) => (message as { uuid?: string }).uuid)).toEqual([
        'missed_during_downtime',
      ]);
    } finally {
      await bridge.dispose();
    }
  });

  it('fails closed when the committed baseline cannot be loaded: no replay-as-new, live rows still flow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-baseline-failure-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_baseline_failure.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'historical_row',
      timestamp: new Date(Date.now() - 30_000).toISOString(),
      sessionId: 'sess_baseline_failure',
      message: { role: 'assistant', content: [{ type: 'text', text: 'history' }] },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_baseline_failure',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => {
        throw new Error('baseline channel not connected');
      },
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'sess_baseline_failure',
        transcript_path: transcriptPath,
      });

      await waitMs(250);
      expect(onMessage).not.toHaveBeenCalled();

      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'live_row_after_resume',
        timestamp: new Date().toISOString(),
        sessionId: 'sess_baseline_failure',
        message: { role: 'assistant', content: [{ type: 'text', text: 'live' }] },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'live_row_after_resume' }));
    } finally {
      await bridge.dispose();
    }
  });

  it('tracks SessionStart transcript path updates from Claude hooks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-hook-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_2.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onSessionFound = vi.fn();
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      onSessionFound,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        session_id: 'sess_2',
        transcript_path: transcriptPath,
      });
      await appendJsonl(transcriptPath, {
        type: 'assistant',
        uuid: 'assistant_2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from hook transcript' }],
        },
      } as RawJSONLines);

      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onSessionFound).toHaveBeenCalledWith('sess_2', expect.objectContaining({
        transcript_path: transcriptPath,
      }));
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'assistant',
        uuid: 'assistant_2',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('replays live startup transcript rows already written before SessionStart binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-startup-backfill-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_startup_backfill.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');
    await appendJsonl(transcriptPath, {
      type: 'user',
      uuid: 'startup_user_prompt',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_startup_backfill',
      message: {
        role: 'user',
        content: 'Please reply exactly LANE_MAIN_MAC_TRANSCRIPT_OK and then stop.',
      },
    } as RawJSONLines);
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'startup_assistant_reply',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_startup_backfill',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'LANE_MAIN_MAC_TRANSCRIPT_OK' }],
        stop_reason: 'end_turn',
      },
    } as RawJSONLines);

    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_startup_backfill',
        transcript_path: transcriptPath,
      });

      await waitUntil(() => onMessage.mock.calls.length === 2);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'startup_user_prompt',
      }));
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'startup_assistant_reply',
      }));
    } finally {
      await bridge.dispose();
    }
  });

  it('subscribes to SessionStart hooks before committed-key loading and scanner startup complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-early-hook-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_early_hook.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'assistant_after_early_hook',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_early_hook',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'LANE_MAIN_MAC_TRANSCRIPT_OK' }],
      },
    } as RawJSONLines);

    const committedKeys = createDeferred<ReadonlySet<string>>();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({ keys: await committedKeys.promise, complete: true, oldestCoveredAtMs: null }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      const startPromise = bridge.start({ abortSignal: new AbortController().signal });
      await Promise.resolve();
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'sess_early_hook',
        transcript_path: transcriptPath,
      });
      committedKeys.resolve(new Set());

      await startPromise;
      await waitUntil(() => onMessage.mock.calls.length === 1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_after_early_hook',
      }));
    } finally {
      committedKeys.resolve(new Set());
      await bridge.dispose();
    }
  });

  it('drops buffered SessionStart hooks when disposed before scanner startup completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-disposed-early-hook-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_disposed_early_hook.jsonl');
    await mkdir(dir, { recursive: true });
    await writeFile(transcriptPath, '');
    await appendJsonl(transcriptPath, {
      type: 'assistant',
      uuid: 'assistant_after_disposed_early_hook',
      timestamp: new Date().toISOString(),
      sessionId: 'sess_disposed_early_hook',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'should not be emitted after dispose' }],
      },
    } as RawJSONLines);

    const committedKeys = createDeferred<ReadonlySet<string>>();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onMessage = vi.fn();
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: null,
      transcriptPath: null,
      workingDirectory: dir,
      onMessage,
      loadCommittedClaudeJsonlMessageBaseline: async () => ({ keys: await committedKeys.promise, complete: true, oldestCoveredAtMs: null }),
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      transcriptMissingWarningMs: 0,
    });

    const startPromise = bridge.start({ abortSignal: new AbortController().signal });
    await Promise.resolve();
    const hook = subscribedHook;
    expect(hook).toBeTypeOf('function');
    if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

    hook({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess_disposed_early_hook',
      transcript_path: transcriptPath,
    });

    await bridge.dispose();
    expect(subscribedHook).toBeUndefined();

    committedKeys.resolve(new Set());
    await startPromise;
    await waitMs(50);
    expect(onMessage).not.toHaveBeenCalled();
  });

  // INV-R C-1. A workflow agent has no tool call to discover it: the run has ONE `Workflow` tool use
  // and many `agent-<id>.jsonl` sidecars, so the journal follower is the only thing that knows they
  // exist and it must hand them to this runtime's importer rather than start a second one. That is
  // only true if what the bridge publishes is the LIVE importer — registrations have to come out of
  // this bridge's own message channel — and if teardown withdraws it, because a registration
  // accepted after cleanup claims a transcript nobody is importing.
  it('publishes the live sidechain importer, and withdraws it on dispose (INV-R C-1)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-transcript-'));
    tempDirs.push(dir);
    const transcriptPath = join(dir, 'sess_1.jsonl');
    await writeFile(transcriptPath, '');
    const sidecarPath = join(dir, 'agent-a7b1656e7.jsonl');
    await appendRawJsonl(sidecarPath, {
      type: 'user',
      uuid: 'workflow_agent_record_1',
      message: { role: 'user', content: [{ type: 'text', text: 'LANE WIRE — bind the registrar' }] },
    });

    const sidechainId = 'workflow_agent_sidechain:toolu_1:a7b1656e7';
    const onMessage = vi.fn();
    const published: Array<{
      registerSidechainFile: (params: Readonly<{
        sidechainId: string;
        agentId: string;
        filePath: string;
        source: 'task-tool' | 'workflow-agent';
      }>) => Promise<void>;
    } | null> = [];
    const bridge = createClaudeUnifiedTranscriptBridge({
      sessionId: 'sess_1',
      transcriptPath,
      workingDirectory: dir,
      onMessage,
      onSubagentFileCollectorChanged: (collector) => {
        published.push(collector);
      },
      transcriptMissingWarningMs: 0,
    });

    try {
      await bridge.start({ abortSignal: new AbortController().signal });
      const importer = published[0];
      if (!importer) throw new Error('bridge published no sidechain importer after start');

      await importer.registerSidechainFile({
        sidechainId,
        agentId: 'a7b1656e7',
        filePath: sidecarPath,
        source: 'workflow-agent',
      });

      await waitUntil(() => onMessage.mock.calls.some(
        ([message]) => (message as Record<string, unknown>)?.uuid === 'workflow_agent_record_1',
      ));
      const imported = onMessage.mock.calls
        .map(([message]) => message as Record<string, unknown>)
        .find((message) => message?.uuid === 'workflow_agent_record_1');
      // The prompt root survives for a workflow agent: nothing synthesises one from a tool use, so
      // skipping it would drop the only record saying what the agent was asked to do.
      expect(imported).toMatchObject({ isSidechain: true, sidechainId });
    } finally {
      await bridge.dispose();
    }

    expect(published).toHaveLength(2);
    expect(published[1]).toBeNull();
  });
});
