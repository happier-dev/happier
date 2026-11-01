import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { handleActionsCommand } from '@/cli/commands/actions';
import { listCompiledActionCliCommands, findCompiledActionCliCommand } from '../compiledCommands';
import { runCompiledActionCliCommand } from '../executeCommand';
import { createSavedSecretsCliHttpFixture } from './savedSecretsCliHttpFixture';

const terminal = vi.hoisted(() => ({ promptInput: vi.fn(async () => 'hidden-value'), isInteractiveTerminal: vi.fn(() => true) }));
// Terminal input and echo are the actual external boundary under test.
vi.mock('@/terminal/prompts/promptInput', () => terminal);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); terminal.promptInput.mockClear(); process.exitCode = 0; });

async function harness() {
  const fixture = await createSavedSecretsCliHttpFixture();
  cleanups.push(fixture.close);
  const stdout: string[] = [];
  async function run(leaf: string, rest: readonly string[], value: string, tty = false) {
    const stdin = Readable.from([Buffer.from(value)]);
    Object.defineProperty(stdin, 'isTTY', { value: tty });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as typeof process.stdin);
    const path = ['secrets', leaf];
    const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
    if (!command) throw new Error('Secret command is unavailable');
    const output = captureConsoleJsonOutput();
    try {
      await fixture.inHome(() => runCompiledActionCliCommand({ command, argv: [...path, ...rest, '--server-id', 'home-fixture', '--json'], deps: fixture.deps }));
      stdout.push(...output.logs);
      return output.json();
    } finally { output.restore(); }
  }
  return { ...fixture, run, stdout };
}

describe('compiled secret input custody', () => {
  it('refuses plaintext through generic Action invocation before reading credentials', async () => {
    let credentialReads = 0;
    const output = captureConsoleJsonOutput();
    try {
      await handleActionsCommand(['invoke', 'secrets.create', '--input-json', '{"name":"Acme","value":"argv-value"}', '--json'], {
        readCredentialsFn: async () => { credentialReads += 1; throw new Error('Credentials must not be read'); },
      });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(credentialReads).toBe(0);
    } finally { output.restore(); }
  });
  it('admits stdin through the compiled create command without putting it in argv or output', async () => {
    const h = await harness();
    expect(await h.run('create', ['Acme', '--kind', 'token'], '  stdin-value\r\n')).toMatchObject({ ok: true });
    expect(h.opened(h.writes[0]!)).toMatchObject({ name: 'Acme', kind: 'token', value: '  stdin-value' });
    expect(h.stdout.join('\n')).not.toContain('stdin-value');
    expect(terminal.promptInput).not.toHaveBeenCalled();
  });
  it('uses the canonical hidden prompt on a terminal', async () => {
    const h = await harness();
    expect(await h.run('create', ['Acme'], '', true)).toMatchObject({ ok: true });
    expect(h.opened(h.writes[0]!)).toMatchObject({ name: 'Acme', value: 'hidden-value' });
    expect(terminal.promptInput).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ secret: true }));
  });
  it('resolves names and carries each observed revision for rename and rotation', async () => {
    const h = await harness();
    expect(await h.run('update', ['Acme', '--rename', 'Renamed'], '', true)).toMatchObject({ ok: true });
    expect(terminal.promptInput).not.toHaveBeenCalled();
    expect(await h.run('update', ['resource-id'], 'rotated\n')).toMatchObject({ ok: true });
    expect(h.writes).toMatchObject([
      { resourceId: 'resource-id', expectedRevision: 37, displayName: 'Renamed' },
      { resourceId: 'resource-id', expectedRevision: 38 },
    ]);
    expect(h.opened(h.writes[1]!)).toMatchObject({ name: 'Renamed', value: 'rotated' });
  });
  it('resolves the secret and carries its current revision to deletion', async () => {
    const h = await harness();
    expect(await h.run('delete', ['Acme'], '', true)).toMatchObject({ ok: true });
    expect(h.writes).toMatchObject([{ resourceId: 'resource-id', expectedRevision: 37 }]);
    expect(h.resources.has('resource-id')).toBe(false);
    expect(terminal.promptInput).not.toHaveBeenCalled();
  });
  it.each([['Acme', '--value', 'argv-value'], ['Acme', 'argv-value'],
    ['--input-json', '{"name":"Acme","value":"argv-value"}'],
    ['--input-json', '{"value":"argv-value" invalid-json']])('rejects argv values before any write: %s', async (...argv) => {
    const h = await harness();
    const result = await h.run('create', argv, 'stdin-value');
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(JSON.stringify(result)).not.toContain('argv-value');
    expect(h.writes).toEqual([]);
  });
  it('rejects empty stdin without writing a placeholder', async () => {
    const h = await harness();
    expect(await h.run('create', ['Acme'], '')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(h.writes).toEqual([]);
  });
});
