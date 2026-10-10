import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import { SignedRootActionExecuteRequestSchema } from '@/daemon/externalActions/signedRootActionControl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { listCompiledActionCliCommands } from './compiledCommands';
import { runCompiledActionCliCommand } from './executeCommand';

const { daemonPost } = vi.hoisted(() => ({ daemonPost: vi.fn() }));
// Only the HTTP crossing is substituted; both CLI and answering daemon retain
// the actual schema compiler, credential adapter, admission and executor.
vi.mock('@/daemon/controlHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlHttp')>(), daemonPost,
}));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const credentials = { token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
  sub: 'account-a', session: 'stored-session-a', tokenEpoch: 7,
  provenance: { v: 1, kind: 'account', authority: 'present_user' },
})}.signature`, encryption: null, credentialProvenance: 'stored_session' } as const;
const input = { scope: { serverId: 'home-a', accountId: 'account-a' }, canvasKey: 'canvas-a' };
const listed = { status: 'listed', focusedLeafId: null, maximizedLeafId: null, leaves: [], tabs: [] };

afterEach(() => { daemonPost.mockReset(); process.exitCode = 0; });

describe('compiled mounted-client CLI command daemon ingress', () => {
  it.each([true, false])('preserves the answering daemon result with mounted owner=%s', async (mounted) => {
    const daemon = createActionExecutor({ clientActionExecute: async ({ actionId }) => mounted
      ? { ok: true, result: listed } : clientActionUnavailable(actionId),
    } satisfies Partial<ActionExecutorDeps> as ActionExecutorDeps);
    daemonPost.mockImplementation(async (_path: string, raw: unknown) => {
      const request = SignedRootActionExecuteRequestSchema.parse(raw);
      return await daemon.execute(request.actionId, request.input, {
        surface: 'cli', authority: 'present_user', actionRequestId: request.actionRequestId,
      });
    });
    const command = listCompiledActionCliCommands().find(row => row.actionId === 'session.canvas.tabs.list')!;
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledActionCliCommand({ command,
        argv: [...command.path, '--input-json', JSON.stringify(input), '--json'],
        deps: {
          readCredentialsFn: async () => credentials,
          createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
            actionsSettingsProvider: createActionSettingsProvider(),
          }),
        },
      });
      expect(output.json()).toMatchObject(mounted
        ? { ok: true, data: listed }
        : { ok: false, error: { code: 'unavailable' } });
    } finally { output.restore(); }
  });
});
