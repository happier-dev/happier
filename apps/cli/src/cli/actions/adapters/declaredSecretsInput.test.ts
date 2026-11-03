import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { handleActionsCommand } from '@/cli/commands/actions';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { compileActionCliCommands } from '../compiledCommands';
import { runCompiledActionCliCommand } from '../executeCommand';

const terminal = vi.hoisted(() => ({ promptInput: vi.fn(async () => 'hidden-value'), isInteractiveTerminal: vi.fn(() => true) }));
// Terminal input and echo are genuine OS boundaries; the Action catalog and executor stay real.
vi.mock('@/terminal/prompts/promptInput', () => terminal);

afterEach(() => { vi.restoreAllMocks(); terminal.promptInput.mockClear(); process.exitCode = undefined; });

async function harness() {
  const pluginId = 'example.secret-input';
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, plugins: [{
    manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
      id: 'consume', title: 'Consume credential', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' },
      inputSchema: { type: 'object', additionalProperties: false, required: ['target', 'credential'],
        properties: { target: { type: 'string', minLength: 1 }, credential: { type: 'string', minLength: 3 },
          nested: { type: 'object', additionalProperties: false, properties: { token: { type: 'string' } } } } },
      resultSchema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      inputHints: { fields: [{ path: 'target', title: 'Target', widget: 'text', required: true },
        { path: 'credential', title: 'Credential', widget: 'secret', required: true },
        { path: 'nested.token', title: 'Conditional token', widget: 'secret',
          visibleWhen: { op: 'eq', path: 'target', value: 'nested' },
          requiredWhen: { op: 'eq', path: 'target', value: 'nested' } }] },
    }] } }),
    files: { 'daemon.mjs': 'const inputs = []; export function readInputs() { return inputs; } export function activate(api) { api.actions.register("consume", async input => { inputs.push(input); return { ok: true }; }); }' },
  }] });
  onTestFinished(() => fixture.dispose());
  const readInputs = fixture.modulesByPluginId.get(pluginId)?.readInputs;
  if (typeof readInputs !== 'function') throw new Error('Missing native input observation');
  const executor = createCliActionExecutor({ token: 'token', sessionId: 'cli-global', mode: 'plain', ctx: null,
    pluginActionExecutionOwner: 'current_process',
    listContributedActionDefinitions: createCommittedContributedActionDefinitionLister(),
    invokeContributedAction: createCommittedContributedActionInvoker(),
  });
  async function run(args: readonly string[], value: string, tty = false) {
    const stdin = Readable.from([Buffer.from(value)]);
    Object.defineProperty(stdin, 'isTTY', { value: tty });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
    const output = captureConsoleJsonOutput();
    try {
      await handleActionsCommand(['invoke', `${pluginId}/actions/consume`, ...args, '--json'], {
        readCredentialsFn: async () => ({ token: 'token', encryption: null, credentialProvenance: 'stored_session' }),
        createExecutorFn: () => ({ execute: executor.execute,
          resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }),
      });
      return { envelope: output.json(), output: output.logs.join('\n') };
    } finally { output.restore(); }
  }
  return { run, readInputs };
}

describe('declared Action secret CLI input', () => {
  it('rejects an ordinary missing built-in field before authentication or private input', async () => {
    let credentialReads = 0;
    const output = captureConsoleJsonOutput();
    try {
      await handleActionsCommand(['invoke', 'machines.managed.bootstrap.respond', '--input-json', JSON.stringify({
        serverId: 'home-profile', homeId: 'home', managedId: 'managed', operationId: 'operation', taskId: 'task', purpose: 'establish',
      }), '--json'], { readCredentialsFn: async () => { credentialReads += 1; return null; } });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(credentialReads).toBe(0);
      expect(terminal.promptInput).not.toHaveBeenCalled();
    } finally { output.restore(); }
  });

  it.each(['invoke', 'friendly'] as const)('fills a built-in secret before full validation through %s', async surface => {
    const observed: unknown[] = [];
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      isActionApprovalRequired: () => false,
      // The answering App RPC is the genuine external effect boundary.
      clientActionExecute: async ({ input }) => {
        observed.push(input);
        return { ok: false, errorCode: 'native_test_refusal', error: 'Native test refusal' };
      },
    });
    const stdin = Readable.from([Buffer.from('administrator-password\n')]);
    Object.defineProperty(stdin, 'isTTY', { value: false });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
    const deps = { readCredentialsFn: async () => ({ token: 'token', encryption: null, credentialProvenance: 'stored_session' as const }),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } }) };
    const actionId = 'machines.managed.bootstrap.respond';
    const ordinary = { serverId: 'home-profile', homeId: 'home', managedId: 'managed', operationId: 'operation',
      taskId: 'task', purpose: 'establish', promptId: 'prompt' };
    const output = captureConsoleJsonOutput();
    try {
      const args = ['--input-json', JSON.stringify(ordinary), '--json'];
      if (surface === 'invoke') await handleActionsCommand(['invoke', actionId, ...args], deps);
      else {
        const [command] = compileActionCliCommands([{ spec: getActionSpec(actionId),
          binding: { path: ['test', 'establish'], visibility: 'canonical' } }]);
        if (!command) throw new Error('Missing compiled Action');
        await runCompiledActionCliCommand({ command, argv: ['test', 'establish', ...args], deps });
      }
      expect(observed).toEqual([{ ...ordinary, password: 'administrator-password' }]);
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'native_test_refusal' } });
      expect(output.logs.join('\n')).not.toContain('administrator-password');
    } finally { output.restore(); }
  });

  it('fills an omitted contributed secret from stdin before its required schema is validated', async () => {
    const h = await harness();
    const result = await h.run(['--target', 'ordinary'], '  stdin-credential\r\n');
    expect(result.envelope).toMatchObject({ ok: true });
    expect(h.readInputs()).toEqual([{ target: 'ordinary', credential: '  stdin-credential' }]);
    expect(result.output).not.toContain('stdin-credential');
    expect(terminal.promptInput).not.toHaveBeenCalled();
  });

  it('uses the incumbent hidden reader for each required missing nested secret', async () => {
    const h = await harness();
    const result = await h.run(['--target', 'nested'], '', true);
    expect(result.envelope).toMatchObject({ ok: true });
    expect(h.readInputs()).toEqual([{ target: 'nested', credential: 'hidden-value', nested: { token: 'hidden-value' } }]);
    expect(terminal.promptInput).toHaveBeenCalledTimes(2);
    expect(terminal.promptInput).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ secret: true }));
    expect(result.output).not.toContain('hidden-value');
  });

  it('validates the acquired secret and never executes an invalid value', async () => {
    const h = await harness();
    const result = await h.run(['--target', 'ordinary'], 'x\n');
    expect(result.envelope).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(h.readInputs()).toEqual([]);
  });

  it('leaves explicit values intact and does not read a hidden conditional field', async () => {
    const h = await harness();
    const result = await h.run(['--input-json', '{"target":"ordinary","credential":"already-present"}'], '', true);
    expect(result.envelope).toMatchObject({ ok: true });
    expect(h.readInputs()).toEqual([{ target: 'ordinary', credential: 'already-present' }]);
    expect(terminal.promptInput).not.toHaveBeenCalled();
  });
});
