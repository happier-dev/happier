import { describe, expect, it } from 'vitest';

import { createSystemTasksRunner } from './interactiveTaskKinds.js';
import { SystemTaskExecutionError } from './runSystemTask.js';

describe('createSystemTasksRunner', () => {
  it('binds an admitted task to its host id instead of a forged input id', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner = createSystemTasksRunner({ kinds: { enrollment: { async run(ctx) {
      await gate;
      return { taskId: 'taskId' in ctx && typeof ctx.taskId === 'string' ? ctx.taskId : null, input: ctx.params };
    } } } });
    const input = { taskId: 'forged-task', identity: { role: 'server' } };
    await runner.start({ taskId: 'admitted-task', kind: 'enrollment', params: input });
    release();
    expect(await runner.wait({ taskId: 'admitted-task' })).toMatchObject({ ok: true, data: {
      taskId: 'admitted-task', input: { taskId: 'forged-task', identity: { role: 'server' } },
    } });
  });

  it('refuses an answer for another managed admission before settling the live prompt', async () => {
    const runner = createSystemTasksRunner({ kinds: {} });
    await runner.startAdmitted({ taskId: 'answer-bound-task', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
      async run(ctx) {
        await ctx.prompt(Object.assign({ kind: 'auth.approveRemoteProvisioning', message: 'Approve guest', data: {} }, {
          validateResponse: async (authority: unknown) => {
            if (authority !== 'this-admission') throw new SystemTaskExecutionError('permission_denied', 'Wrong managed admission');
          },
        }));
        return { approved: true };
      },
    });
    await expect(runner.respond(Object.assign({ taskId: 'answer-bound-task', expectedPromptKind: 'auth.approveRemoteProvisioning',
      answer: { approved: true } }, { responseAuthorization: 'other-admission' }))).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await runner.poll({ taskId: 'answer-bound-task', cursor: 0 })).pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond(Object.assign({ taskId: 'answer-bound-task', answer: { approved: true } }, { responseAuthorization: 'this-admission' }));
    expect(await runner.wait({ taskId: 'answer-bound-task' })).toMatchObject({ ok: true });
  });

  it('discards an in-flight secret delivery when its prompt is cancelled', async () => {
    const runner = createSystemTasksRunner({ kinds: {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await runner.startAdmitted({ taskId: 'retired-delivery', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
      async run(ctx) {
        await ctx.prompt({ kind: 'auth.approveRemoteProvisioning', message: 'Approve guest', data: {},
          deliver: async () => { await gate; return { secretB64Url: 'must-not-escape' }; } });
        return {};
      },
    });
    const delivery = runner.respond({ taskId: 'retired-delivery', expectedPromptKind: 'auth.approveRemoteProvisioning',
      answer: undefined, delivery: {} });
    await runner.cancel({ taskId: 'retired-delivery' });
    release();
    await expect(delivery).rejects.toMatchObject({ code: 'no_prompt' });
    expect(JSON.stringify(await runner.wait({ taskId: 'retired-delivery' }))).not.toContain('must-not-escape');
  });

  it('delivers a current prompt secret transiently without settling or retaining it, and refuses after cancellation', async () => {
    const runner = createSystemTasksRunner({ kinds: {} });
    const secret = 'transient-pairing-context-never-published';
    await runner.startAdmitted({ taskId: 'transient-task', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
      async run(ctx) {
        await ctx.prompt(Object.assign({ kind: 'auth.approveRemoteProvisioning', message: 'Approve guest', data: {} }, {
          deliver: async (request: unknown) => {
            if (request !== 'admitted-requester') throw new SystemTaskExecutionError('permission_denied', 'Not the admitted requester');
            return { secretB64Url: secret };
          },
        }));
        return { approved: true };
      },
    });
    const deliver = (request: unknown) => runner.respond(Object.assign({ taskId: 'transient-task',
      expectedPromptKind: 'auth.approveRemoteProvisioning', answer: undefined }, { delivery: request }));
    await expect(deliver('wrong-requester')).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(deliver('admitted-requester')).resolves.toEqual({ secretB64Url: secret });
    const waiting = await runner.poll({ taskId: 'transient-task', cursor: 0 });
    expect(waiting.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    expect(JSON.stringify(waiting)).not.toContain(secret);
    await runner.cancel({ taskId: 'transient-task' });
    await runner.wait({ taskId: 'transient-task' });
    await expect(deliver('admitted-requester')).rejects.toMatchObject({ code: 'no_prompt' });
    expect(JSON.stringify(await runner.poll({ taskId: 'transient-task', cursor: 0 }))).not.toContain(secret);
  });

  it('keeps an admitted prepared transport on the existing prompt, response and completion lifetime', async () => {
    const runner = createSystemTasksRunner({ kinds: {} });
    await runner.startAdmitted({ taskId: 'managed-task', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
      async run(ctx) {
        await ctx.prompt({ kind: 'ssh.trustHost', message: 'Trust guest', data: {} });
        const answer = await ctx.prompt({ kind: 'auth.approveRemoteProvisioning', message: 'Approve guest sign-in', data: {} });
        return { approved: (answer as { approved?: boolean }).approved === true };
      },
    });
    const completed = runner.wait({ taskId: 'managed-task' });
    await runner.respond({ taskId: 'managed-task', expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } });
    expect((await runner.poll({ taskId: 'managed-task', cursor: 0 })).pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    // The stale trust answer arrives after the task advanced, even when its operation projection has not caught up.
    await expect(runner.respond({ taskId: 'managed-task', expectedPromptKind: 'ssh.trustHost', answer: { approved: true } }))
      .rejects.toMatchObject({ code: 'no_prompt' });
    expect((await runner.poll({ taskId: 'managed-task', cursor: 0 })).pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({ taskId: 'managed-task', expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved: true } });
    await expect(completed).resolves.toMatchObject({ ok: true, data: { approved: true } });
  });

  it('releases an ordinary pending prompt when cancellation is requested', async () => {
    const runner = createSystemTasksRunner({
      kinds: {
        'test.prompt-cancel.v1': {
          async run(ctx) {
            await ctx.prompt({
              kind: 'test.confirm.v1',
              message: 'Continue?',
              data: {},
            });
            return { continued: true };
          },
        },
      },
    });

    await runner.start({ taskId: 'task-prompt-cancel', kind: 'test.prompt-cancel.v1', params: {} });
    expect((await runner.poll({ taskId: 'task-prompt-cancel', cursor: 0 })).pendingPrompt).toMatchObject({
      kind: 'test.confirm.v1',
    });

    await runner.cancel({ taskId: 'task-prompt-cancel' });
    await Promise.resolve();
    await Promise.resolve();

    expect(await runner.poll({ taskId: 'task-prompt-cancel', cursor: 0 })).toMatchObject({
      pendingPrompt: null,
      result: { ok: false, error: { code: 'cancelled' } },
    });
  });

  it.each([true, false])('retains an explicitly non-cancellable prompt and its outcome after cancellation (success: %s)', async (succeeds) => {
    const runner = createSystemTasksRunner({
      kinds: {
        'test.prompt-finalize.v1': {
          async run(ctx) {
            const answer = await ctx.prompt({
              kind: 'test.finalize.v1',
              message: 'Finish the committed operation',
              data: {},
              nonCancellable: true,
            }) as { committed?: boolean };
            if (answer.committed !== true) throw new SystemTaskExecutionError('finalization_failed', 'Finalization failed');
            return { committed: true };
          },
        },
      },
    });

    await runner.start({ taskId: 'task-prompt-finalize', kind: 'test.prompt-finalize.v1', params: {} });
    await runner.cancel({ taskId: 'task-prompt-finalize' });
    await Promise.resolve();
    expect((await runner.poll({ taskId: 'task-prompt-finalize', cursor: 0 })).pendingPrompt).toMatchObject({
      kind: 'test.finalize.v1',
    });

    await runner.respond({ taskId: 'task-prompt-finalize', answer: { committed: succeeds } });
    expect(await runner.poll({ taskId: 'task-prompt-finalize', cursor: 0 })).toMatchObject({
      pendingPrompt: null,
      result: succeeds
        ? { ok: true, data: { committed: true } }
        : { ok: false, error: { code: 'finalization_failed' } },
    });
  });

  it.each(['named', 'native'] as const)('delivers cancellation through the task context and publishes one terminal cancelled result (%s)', async (failure) => {
    let observedSignal: AbortSignal | undefined;
    const runner = createSystemTasksRunner({
      kinds: {
        'test.cancel.v1': {
          async run(ctx) {
            observedSignal = ctx.signal;
            await new Promise<void>((resolve) => {
              ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            if (failure === 'native') ctx.signal?.throwIfAborted();
            throw new SystemTaskExecutionError('cancelled', 'cancelled by owner');
          },
        },
      },
    });

    await runner.start({ taskId: 'task-cancel', kind: 'test.cancel.v1', params: {} });
    expect(observedSignal?.aborted).toBe(false);

    await runner.cancel({ taskId: 'task-cancel' });
    await Promise.resolve();
    await Promise.resolve();

    expect(observedSignal?.aborted).toBe(true);
    const terminal = await runner.poll({ taskId: 'task-cancel', cursor: 0 });
    expect(terminal.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(terminal.pendingPrompt).toBeNull();
    await runner.cancel({ taskId: 'task-cancel' });
    expect((await runner.poll({ taskId: 'task-cancel', cursor: 0 })).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('emits deterministic event streams and blocks on typed prompts until answered', async () => {
    const runner = createSystemTasksRunner({
      now: (() => {
        let ts = 1_000;
        return () => ts++;
      })(),
      kinds: {
        'test.prompt.v1': {
          async run(ctx) {
            ctx.emit({ type: 'progress', stepId: 'prepare', message: 'Preparing', data: { percent: 10 } });
            const answer = await ctx.prompt({
              kind: 'ssh.trustHost',
              message: 'Trust this host?',
              data: { host: 'example.test', fingerprint: 'SHA256:abc' },
            }) as { trusted: boolean };
            ctx.emit({ type: 'progress', stepId: 'finish', message: `Trusted=${answer.trusted}`, data: { percent: 100 } });
            return { trusted: answer.trusted };
          },
        },
      },
    });

    const started = await runner.start({
      taskId: 'task-1',
      kind: 'test.prompt.v1',
      params: {},
    });

    expect(started).toEqual({ taskId: 'task-1' });

    expect(await runner.poll({ taskId: 'task-1', cursor: 0 })).toEqual({
      events: [
        {
          protocolVersion: 1,
          taskId: 'task-1',
          tsMs: 1000,
          type: 'progress',
          stepId: 'prepare',
          message: 'Preparing',
          data: { percent: 10 },
        },
        {
          protocolVersion: 1,
          taskId: 'task-1',
          tsMs: 1001,
          type: 'prompt',
          message: 'Trust this host?',
          data: {
            kind: 'ssh.trustHost',
            host: 'example.test',
            fingerprint: 'SHA256:abc',
          },
        },
      ],
      nextCursor: 2,
      result: null,
      pendingPrompt: {
        kind: 'ssh.trustHost',
        data: { host: 'example.test', fingerprint: 'SHA256:abc' },
      },
    });

    await runner.respond({
      taskId: 'task-1',
      answer: { trusted: true },
    });

    expect(await runner.poll({ taskId: 'task-1', cursor: 2 })).toEqual({
      events: [
        {
          protocolVersion: 1,
          taskId: 'task-1',
          tsMs: 1002,
          type: 'progress',
          stepId: 'finish',
          message: 'Trusted=true',
          data: { percent: 100 },
        },
      ],
      nextCursor: 3,
      result: {
        protocolVersion: 1,
        taskId: 'task-1',
        ok: true,
        data: { trusted: true },
      },
      pendingPrompt: null,
    });
  });

  it('redacts secret-like prompt fields before publishing prompt events', async () => {
    const runner = createSystemTasksRunner({
      now: (() => {
        let ts = 1_000;
        return () => ts++;
      })(),
      kinds: {
        'test.prompt.v1': {
          async run(ctx) {
            ctx.emit({
              type: 'progress',
              stepId: 'inspect',
              message: 'Inspecting',
              data: {
                claimSecret: 'event-secret',
                nested: {
                  env: {
                    TOKEN: 'env-secret',
                  },
                  keep: 'ok',
                },
              },
            });
            const answer = await ctx.prompt({
              kind: 'auth.approveRemoteProvisioning',
              message: 'Approve remote provisioning?',
              data: {
                publicKey: 'pub-key',
                claimSecret: 'claim-secret',
                stateFile: '/tmp/claim-state.json',
                identityPrivateKey: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----',
                nested: {
                  accessToken: 'nested-token',
                  keep: 'ok',
                },
              },
            }) as { approved: boolean };

            return {
              approved: answer.approved,
            };
          },
        },
      },
    });

    await runner.start({
      taskId: 'task-redacted',
      kind: 'test.prompt.v1',
      params: {},
    });

    const snapshot = await runner.poll({ taskId: 'task-redacted', cursor: 0 });

    expect(snapshot.events).toEqual([
      {
        protocolVersion: 1,
        taskId: 'task-redacted',
        tsMs: 1000,
        type: 'progress',
        stepId: 'inspect',
        message: 'Inspecting',
        data: {
          nested: {
            keep: 'ok',
          },
        },
      },
      {
        protocolVersion: 1,
        taskId: 'task-redacted',
        tsMs: 1001,
        type: 'prompt',
        message: 'Approve remote provisioning?',
        data: {
          kind: 'auth.approveRemoteProvisioning',
          publicKey: 'pub-key',
          nested: {
            keep: 'ok',
          },
        },
      },
    ]);
    expect(snapshot.pendingPrompt).toEqual({
      kind: 'auth.approveRemoteProvisioning',
      data: {
        publicKey: 'pub-key',
        nested: {
          keep: 'ok',
        },
      },
    });
  });

  it('strips embedded URL credentials from prompt and event data under ordinary keys', async () => {
    const runner = createSystemTasksRunner({
      kinds: {
        'test.relay-prompt.v1': {
          async run(ctx) {
            ctx.emit({
              type: 'step',
              stepId: 'prepare',
              message: 'Preparing',
              data: { relayUrl: 'https://relay-operator:hunter2@relay.example.com/' },
            });
            await ctx.prompt({
              kind: 'authRequest',
              message: 'Approve this computer',
              data: {
                relayUrl: 'https://relay-operator:hunter2@relay.example.com/',
                webappUrl: 'https://viewer@app.example.com/',
                plainUrl: 'https://relay.example.com/path?to=a@b',
                notAUrl: 'git@github.com:happier/happier.git',
              },
            });
            return {};
          },
        },
      },
    });

    await runner.start({ taskId: 'task-relay', kind: 'test.relay-prompt.v1', params: {} });
    const snapshot = await runner.poll({ taskId: 'task-relay', cursor: 0 });

    expect(snapshot.events[0]?.data).toEqual({ relayUrl: 'https://relay.example.com/' });
    expect(snapshot.pendingPrompt).toEqual({
      kind: 'authRequest',
      data: {
        relayUrl: 'https://relay.example.com/',
        webappUrl: 'https://app.example.com/',
        plainUrl: 'https://relay.example.com/path?to=a@b',
        notAUrl: 'git@github.com:happier/happier.git',
      },
    });
  });
});
