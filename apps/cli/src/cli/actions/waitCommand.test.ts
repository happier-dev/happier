import { expect, it } from 'vitest';
import {
  createActionExecutor, projectSessionAwarenessV1, waitForSessionAwarenessV1,
  SessionAwarenessProjectionV1Schema, type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { runCompiledActionCliCommand } from './executeCommand';

it('watch streams the owner baseline and Ctrl+C cancels only observation', async () => {
  const command = findCompiledActionCliCommand(['watch'], listCompiledActionCliCommands())!;
  const input = { target: { kind: 'session', serverId: 'home', sessionId: 'session' }, condition: { kind: 'terminal' } };
  const before = process.listenerCount('SIGINT');
  const output = captureConsoleJsonOutput();
  let running = true;
  // Substitute credentials, session reads and socket wake boundaries only.
  const owner = createActionExecutor({
    sessionActivityGet: async () => projectSessionAwarenessV1({ nowMs: Date.now(), sessionId: 'session',
      lifecycle: {}, runtime: { presence: 'online', active: true }, pending: {}, content: { mode: 'plain' },
      currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
    }),
    sessionAwarenessWait: async ({ input: request, options, readAwareness }) => waitForSessionAwarenessV1({
      condition: request.condition, deadlineMs: options.deadlineMs, signal: options.signal, onSnapshot: options.onSnapshot,
      read: async () => ({ awareness: SessionAwarenessProjectionV1Schema.parse(await readAwareness()) }),
      open: () => ({ currentRevision: () => 0, close: async () => {},
        waitForChange: async () => { process.emit('SIGINT'); return false; },
      }),
    }),
  } satisfies Pick<ActionExecutorDeps, 'sessionActivityGet' | 'sessionAwarenessWait'> as unknown as ActionExecutorDeps);
  try {
    await runCompiledActionCliCommand({ command, argv: ['watch', '--server-id', 'home', '--json', '--input-json', JSON.stringify(input)],
      deps: {
        readCredentialsForServerIdFn: async () => ({ token: 'credential' } as never),
        getServerProfileFn: async () => ({ id: 'home', serverUrl: 'https://home.example.test', localServerUrl: null,
          homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { homeServerIdentityId: 'identity' } } as never),
        createServerFeaturesSnapshotStoreFn: () => ({ refresh: async () => ({}) } as never),
        createExecutorFn: () => ({ execute: (id, value, context) => owner.execute(id, value, { ...context, serverId: 'home' }),
          resolveSessionTarget: async (sessionId) => ({ ok: true, sessionId }),
        }),
      },
    });
    expect(output.logs.map((line) => JSON.parse(line) as unknown)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'watch', snapshot: expect.objectContaining({ awareness: expect.any(Object) }) }),
      expect.objectContaining({ data: expect.objectContaining({ disposition: 'cancelled' }) }),
    ]));
    expect(running).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
  } finally { output.restore(); running = false; }
});
