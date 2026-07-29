import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agent-runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { type PluginUiQuestionsResult } from '@happier-dev/plugin-sdk/runtime';
import { describe, expect, it, vi } from 'vitest';

import { createCursorAcpRuntimeExtensions } from './extensions/index.js';

const SIGNAL = new AbortController().signal;

function extensionContext(method: string, requestId = 'request-1') {
  return { method, requestId, signal: SIGNAL };
}

function createFixture(params?: Readonly<{
  questionsResult?: PluginUiQuestionsResult;
  confirm?: () => Promise<boolean>;
  publish?: (...args: unknown[]) => Promise<unknown>;
  publishGenerated?: (...args: unknown[]) => Promise<unknown>;
}>) {
  const askQuestions = vi.fn(async () => params?.questionsResult ?? ({
    status: 'answered' as const,
    answers: {},
  }));
  const confirm = vi.fn(params?.confirm ?? (async () => true));
  const publish = vi.fn(params?.publish ?? (async () => ({
    status: 'applied' as const,
    revision: 'work-state-1',
    sourceSequence: 1,
  })));
  const publisher = vi.fn(() => ({ publish }));
  const publishGenerated = vi.fn(params?.publishGenerated ?? (async () => ({ status: 'published' as const })));
  const disposeMediaRoot = vi.fn();
  const registerSourceRoot = vi.fn(async () => ({ publishGenerated, dispose: disposeMediaRoot }));
  const observe = vi.fn(async (value: unknown) => value);
  const debug = vi.fn();
  const context = {
    session: { id: 'happier-session-1' },
    ui: { askQuestions, confirm },
    workState: { publisher },
    services: {
      logger: { debug },
      sessions: {
        current: { media: { registerSourceRoot } },
        subagents: { observe },
      },
    },
  } as unknown as AgentSessionRuntimeContext;
  return {
    context,
    askQuestions,
    confirm,
    publish,
    publisher,
    publishGenerated,
    disposeMediaRoot,
    registerSourceRoot,
    observe,
    debug,
  };
}

describe('createCursorAcpRuntimeExtensions', () => {
  it('uses the host question owner and preserves opaque choice ids and custom text', async () => {
    const fixture = createFixture({
      questionsResult: {
        status: 'answered',
        answers: {
          choice: {
            type: 'multiple',
            answers: [
              { type: 'choice', choiceId: 'beta|opaque' },
              { type: 'custom', value: 'something else' },
            ],
          },
          free: { type: 'text', value: 'typed answer' },
        },
      },
    });
    const extensions = createCursorAcpRuntimeExtensions({ context: fixture.context });

    await expect(extensions.requests?.['cursor/ask_question']?.({
      title: 'Need input',
      questions: [
        {
          id: 'choice',
          prompt: 'Pick values',
          allowMultiple: true,
          options: [
            { id: 'alpha', label: 'Alpha' },
            { id: 'beta|opaque', label: 'Beta' },
          ],
        },
        { id: 'free', prompt: 'Explain' },
      ],
    }, extensionContext('cursor/ask_question'))).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [
          { questionId: 'choice', selectedOptionIds: ['beta|opaque', 'something else'] },
          { questionId: 'free', selectedOptionIds: ['typed answer'] },
        ],
      },
    });
    expect(fixture.askQuestions).toHaveBeenCalledWith([
      {
        id: 'choice',
        prompt: 'Pick values',
        type: 'multiple',
        choices: [
          { id: 'alpha', label: 'Alpha', description: 'Alpha' },
          { id: 'beta|opaque', label: 'Beta', description: 'Beta' },
        ],
      },
      { id: 'free', prompt: 'Explain', type: 'text' },
    ], { title: 'Need input' });
  });

  it('maps cancelled and unavailable host question outcomes without another custody path', async () => {
    const cancelled = createFixture({ questionsResult: { status: 'cancelled' } });
    const cancelledExtensions = createCursorAcpRuntimeExtensions({ context: cancelled.context });
    await expect(cancelledExtensions.requests?.['cursor/ask_question']?.({
      questions: [{ id: 'q', prompt: 'Question' }],
    }, extensionContext('cursor/ask_question'))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });

    const unavailable = createFixture({
      questionsResult: {
        status: 'unavailable',
        diagnostic: { code: 'no_present_client', message: 'No present client' },
      },
    });
    const unavailableExtensions = createCursorAcpRuntimeExtensions({ context: unavailable.context });
    await expect(unavailableExtensions.requests?.['cursor/ask_question']?.({
      questions: [{ id: 'q', prompt: 'Question' }],
    }, extensionContext('cursor/ask_question'))).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'No present client' },
    });
  });

  it('publishes plan work-state before asking the host for approval', async () => {
    const fixture = createFixture();
    const extensions = createCursorAcpRuntimeExtensions({ context: fixture.context });

    await expect(extensions.requests?.['cursor/create_plan']?.({
      name: 'Ship it',
      overview: 'Overview',
      plan: 'Detailed plan',
      phases: [{
        name: 'Migration',
        todos: [{ id: 'native', content: 'Use native runtime', status: 'inProgress' }],
      }],
    }, extensionContext('cursor/create_plan'))).resolves.toEqual({
      outcome: { outcome: 'accepted' },
    });
    expect(fixture.publisher).toHaveBeenCalledWith('todos');
    expect(fixture.publish).toHaveBeenCalledWith(expect.objectContaining({
      sourceSequence: 1,
      primaryLocalId: 'todo:cursor:native',
      items: [expect.objectContaining({
        providerRef: 'native',
        status: 'active',
        providerData: { phaseName: 'Migration' },
      })],
    }), { signal: SIGNAL });
    expect(fixture.confirm).toHaveBeenCalledWith(
      'Overview\n\nDetailed plan',
      { title: 'Ship it' },
    );
    expect(fixture.publish.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.confirm.mock.invocationCallOrder[0]!,
    );
  });

  it('maps plan rejection and host cancellation to Cursor outcomes', async () => {
    const rejected = createFixture({ confirm: async () => false });
    await expect(createCursorAcpRuntimeExtensions({ context: rejected.context })
      .requests?.['cursor/create_plan']?.(
        { plan: 'Plan' },
        extensionContext('cursor/create_plan'),
      )).resolves.toEqual({ outcome: { outcome: 'rejected' } });

    const cancelled = createFixture({
      confirm: async () => {
        throw new PluginError({ code: 'plugin_ui_cancelled' });
      },
    });
    await expect(createCursorAcpRuntimeExtensions({ context: cancelled.context })
      .requests?.['cursor/create_plan']?.(
        { plan: 'Plan' },
        extensionContext('cursor/create_plan'),
      )).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('does not approve a plan when required work-state publication is unavailable', async () => {
    const fixture = createFixture({
      publish: async () => ({
        status: 'unavailable',
        diagnostic: {
          code: 'agent_work_state_generation_retired',
          message: 'Session generation retired',
        },
      }),
    });
    const extensions = createCursorAcpRuntimeExtensions({ context: fixture.context });

    await expect(extensions.requests?.['cursor/create_plan']?.({
      plan: 'Plan',
      todos: [{ id: 'required', content: 'Required', status: 'pending' }],
    }, extensionContext('cursor/create_plan'))).rejects.toMatchObject({
      code: 'cursor_work_state_publish_unavailable',
    });
    expect(fixture.confirm).not.toHaveBeenCalled();
  });

  it('publishes replacement and merged todo snapshots while ignoring malformed payloads', async () => {
    const fixture = createFixture();
    const extensions = createCursorAcpRuntimeExtensions({ context: fixture.context });

    await extensions.requests?.['cursor/update_todos']?.({
      todos: [{ id: 'a', content: 'First', status: 'pending' }],
    }, extensionContext('cursor/update_todos'));
    await extensions.notifications?.['cursor/update_todos']?.({
      merge: true,
      todos: [
        { id: 'a', content: 'First', status: 'done' },
        { id: 'b', content: 'Second', status: 'blocked' },
      ],
    }, extensionContext('cursor/update_todos'));
    await extensions.notifications?.['cursor/update_todos']?.({ todos: 'invalid' }, extensionContext('cursor/update_todos'));

    expect(fixture.publish).toHaveBeenCalledTimes(2);
    expect(fixture.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceSequence: 2,
      primaryLocalId: 'todo:cursor:b',
      items: [
        expect.objectContaining({ localId: 'todo:cursor:b', status: 'blocked' }),
        expect.objectContaining({ localId: 'todo:cursor:a', status: 'complete' }),
      ],
    }), { signal: SIGNAL });
    expect(fixture.debug).toHaveBeenCalledWith(
      'Cursor ACP update_todos ignored malformed payload',
      { keys: ['todos'] },
    );
  });

  it('projects source-identified tasks through the scoped subagent service', async () => {
    const fixture = createFixture();
    const extensions = createCursorAcpRuntimeExtensions({ context: fixture.context });

    await extensions.requests?.['cursor/task']?.({
      toolCallId: 'tool-1',
      agentId: 'agent-1',
      description: 'Research',
      subagentType: { custom: 'researcher' },
      model: 'composer',
      durationMs: 123,
    }, extensionContext('cursor/task'));
    await extensions.notifications?.['cursor/task']?.({
      agentId: 'missing-tool-call',
    }, extensionContext('cursor/task'));

    expect(fixture.observe).toHaveBeenCalledTimes(1);
    expect(fixture.observe).toHaveBeenCalledWith(expect.objectContaining({
      observationId: expect.stringMatching(/^cursor-native:/),
      status: 'completed',
      detail: expect.objectContaining({
        kind: 'custom',
        label: 'Research',
        spawnRef: { toolCallId: 'tool-1' },
        agentMetadata: {
          model: 'composer',
          agentId: 'agent-1',
          subagentType: { custom: 'researcher' },
          durationMs: 123,
        },
      }),
    }), { signal: SIGNAL });
    expect(fixture.debug).toHaveBeenCalledWith(
      'Cursor ACP task ignored without source identifiers',
      { keys: ['agentId'] },
    );
  });

  it('coalesces request and notification generated-media delivery through the scoped media service', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({
      publishGenerated: async () => {
        await pending;
        return { status: 'published' };
      },
    });
    const extensions = createCursorAcpRuntimeExtensions({
      context: fixture.context,
      mediaSourceRoot: '/tmp/cursor-media',
    });
    const payload = {
      toolCallId: 'image-1',
      filePath: 'image.png',
      description: 'Generated image',
      referenceImagePaths: ['reference.png'],
    };

    const request = extensions.requests?.['cursor/generate_image']?.(
      payload,
      extensionContext('cursor/generate_image'),
    );
    const notification = extensions.notifications?.['cursor/generate_image']?.(
      payload,
      extensionContext('cursor/generate_image'),
    );
    await vi.waitFor(() => expect(fixture.publishGenerated).toHaveBeenCalledOnce());
    release();
    await Promise.all([request, notification]);

    expect(fixture.registerSourceRoot).toHaveBeenCalledOnce();
    expect(fixture.registerSourceRoot).toHaveBeenCalledWith({ rootPath: '/tmp/cursor-media' });
    expect(fixture.publishGenerated).toHaveBeenCalledWith({
      localId: 'image-1',
      path: 'image.png',
      description: 'Generated image',
      referencePaths: ['reference.png'],
      toolCallId: 'image-1',
    });
    expect(fixture.disposeMediaRoot).toHaveBeenCalledOnce();
  });
});
