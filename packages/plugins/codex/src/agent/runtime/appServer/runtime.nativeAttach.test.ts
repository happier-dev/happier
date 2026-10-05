import { describe, expect, it } from 'vitest';
import { startCodexAppServerRuntime } from './runtime.js';
import { withCodexNativeAttachFixture as withFixture } from './runtime.nativeAttach.test-support.js';

describe('native Codex attachment preparation', () => {
  it.each([
    ['no rollout found for thread id missing-thread', 'AGENT_RESUME_PROVIDER_STATE_MISSING'],
    ['provider temporarily unavailable', undefined],
  ])('classifies resume rejection %s without starting a replacement thread', async (message, code) => {
    await withFixture(async ({ runtime, requests, failResume }) => {
      failResume(message);
      const error = await startCodexAppServerRuntime(runtime, {
        resumeId: 'missing-thread', preserveRequestedThreadId: true,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: unknown }).code).toBe(code ?? -32000);
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('preserves the typed missing-state reason through native session startup sanitization', async () => {
    await withFixture(async ({ openConfiguredSession, requests, failResume }) => {
      failResume('no rollout found for thread id missing-thread');
      const error = await openConfiguredSession('missing-thread').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('applies initial canonical effort before startup instructions initialize the native attachment thread', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const session = await openConfiguredSession();
      await session.prepareTerminalPresentation?.();
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({
        model: 'fixture-model', permissions: ':read-only',
        config: { model_reasoning_effort: 'low' },
        developerInstructions: 'Actual startup instructions.',
      });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    });
  });
  it('materializes zero-turn fresh threads once and preserves identity and policy on repeat attach', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toEqual([{ method: 'thread/name/set', params: { threadId: 'fresh-thread', name: 'Happier session actual-happier-session' } }]);
      expect(requests.filter((r) => r.method === 'thread/read')).toEqual([{ method: 'thread/read', params: { threadId: 'fresh-thread', includeTurns: true } }]);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({ permissions: ':read-only', config: { model_reasoning_effort: 'low' } });
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      await runtime.updateConfig?.({ permissionMode: 'acceptEdits' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    });
  });

  it('keeps an existing resumed thread name and does not initialize a new thread', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime, { resumeId: 'existing-thread', importHistory: false });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('existing-thread');
      expect(requests.filter((r) => ['thread/start', 'thread/name/set', 'thread/read', 'turn/start'].includes(r.method))).toEqual([]);
    });
  });

  it('materializes a realtime-published zero-turn thread before native resume without replacing its identity', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await startCodexAppServerRuntime(runtime);
      const started = await runtime.realtimeConversation.start({ transport: { kind: 'webrtc', offerSdp: 'offer' } });
      expect(started.status).toBe('started');
      if (started.status !== 'started') throw new Error('Realtime fixture failed to start');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).rejects.toThrow('no rollout found');

      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      await started.handle.stop();
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
    });
  });

  it('withholds attachment identity if the fresh rollout cannot be materialized', async () => {
    await withFixture(async ({ runtime, failRead }) => {
      failRead();
      await expect(runtime.prepareProviderCliAttach()).rejects.toThrow('rollout persistence failed');
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    });
  });
});
