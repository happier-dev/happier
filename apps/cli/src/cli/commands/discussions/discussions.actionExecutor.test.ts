import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, FeaturesResponseSchema } from '@happier-dev/protocol';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';
import { listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { resolveCompiledActionCliCompletionCandidates } from '@/cli/actions/commandCompletion';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { resolveAdmittedActionCliCommand } from '@/cli/commandRegistry';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';

const request = vi.fn();

const credentials = { token: 'token', encryption: null };
const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({
  features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
}) };

async function invoke(argv: readonly string[]) {
  const command = await resolveAdmittedActionCliCommand(argv);
  if (!command) throw new Error('Discussion command was not admitted');
  await runCompiledActionCliCommand({
    command, argv,
    deps: {
      readCredentialsFn: async () => credentials,
      createExecutorFn: (params) => {
        const { serverId, serverApiUrl, ...actionParams } = params;
        const home = serverId === undefined ? {} : { serverId, serverHttpBaseUrl: serverApiUrl };
        const deps = createCliActionDeps({
          ...actionParams, ...home, token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
          resolveServerFeaturesSnapshot: () => features,
        });
        return {
          ...createActionExecutor(deps),
          // A Home Discussion never resolves an owning Session. This tripwire
          // catches a stale Session operand at the actual CLI composition.
          resolveSessionTarget: async () => { throw new Error('Unexpected Session resolution'); },
        };
      },
    },
  });
}

describe('happier discussions through the admitted root and real Action executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(axios, 'request').mockImplementation(request);
    process.exitCode = 0;
    request.mockResolvedValue({ status: 200, data: { discussions: [], nextCursor: null } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    request.mockReset();
    process.exitCode = undefined;
  });

  it('lists a Home conversation without a Session operand through the canonical transport', async () => {
    const output = captureConsoleJsonOutput();
    try {
      await invoke(['discussions', 'list', '--json']);
      expect(output.json()).toMatchObject({
        ok: true, kind: 'discussions_list', data: { discussions: [], incomplete: false },
      });
    } finally { output.restore(); }
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: expect.stringMatching(/\/v1\/discussions(?:\?|$)/) }));
    expect(request.mock.calls.some(([input]) => input.url.includes('/sessions/'))).toBe(false);
  });

  it('keeps the whole family on one root and retires the Session command spelling', async () => {
    for (const operation of ['list', 'show', 'read', 'create', 'post', 'reply', 'rename', 'archive', 'restore', 'read-state']) {
      const command = await resolveAdmittedActionCliCommand(['discussions', operation]);
      expect(command?.actionId).toMatch(/^discussion\./);
      expect(command?.positionals.some(field => field.path === 'sessionId')).toBe(false);
    }
    expect(await resolveAdmittedActionCliCommand(['session', 'discussions', 'list', 'session-old'])).toBeNull();
  });

  it('publishes scalar create help with independent retry identities and Home selection', async () => {
    const output = captureConsoleText();
    try {
      await invoke(['discussions', 'create', '--help']);
      expect(output.text()).toContain('happier discussions create <title> <message>');
      expect(output.text()).toContain('--creation-local-id');
      expect(output.text()).toContain('--message-local-id');
      expect(output.text()).toContain('--server-id');
      expect(output.text()).not.toContain('<sessionId>');
    } finally { output.restore(); }
    expect(request).not.toHaveBeenCalled();
  });

  it('projects root commands and retry flags from the same catalog into completion', () => {
    const commands = listCompiledActionCliCommands();
    expect(resolveCompiledActionCliCompletionCandidates({ committed: ['discussions'], prefix: '', commands }))
      .toEqual(expect.arrayContaining(['list', 'show', 'read', 'create', 'post', 'rename', 'archive', 'restore', 'read-state']));
    expect(resolveCompiledActionCliCompletionCandidates({
      committed: ['discussions', 'create', 'Title', 'Message'], prefix: '--creation', commands,
    })).toContain('--creation-local-id');
  });
});
