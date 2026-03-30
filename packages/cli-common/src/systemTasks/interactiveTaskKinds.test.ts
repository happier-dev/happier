import { describe, expect, it } from 'vitest';

import { createSystemTasksRunner } from './interactiveTaskKinds.js';

describe('createSystemTasksRunner', () => {
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
});
