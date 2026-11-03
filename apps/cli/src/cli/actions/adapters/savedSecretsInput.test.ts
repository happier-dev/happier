import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
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

async function harness(options?: Parameters<typeof createSavedSecretsCliHttpFixture>[0]) {
  const fixture = await createSavedSecretsCliHttpFixture(options);
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
  it('links and updates an external source without asking for a scalar value', async () => {
    const h = await harness();
    const source = { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'vault' }, account: 'account', reference: 'op://vault/item/token' };
    const created = await h.run('create', ['Vault', '--kind', 'token', '--source-json', JSON.stringify(source)], '', true);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    expect(h.opened(h.writes[0]!)).toEqual({ v: 2, name: 'Vault', kind: 'token', source });
    expect(await h.run('update', ['resource-id', '--source-json', JSON.stringify(source)], '', true)).toMatchObject({ ok: true });
    expect(h.opened(h.writes[1]!)).toEqual({ v: 2, name: 'Acme', kind: 'token', source });
    expect(terminal.promptInput).not.toHaveBeenCalled();
    expect(h.stdout.join('\n')).not.toContain('op://vault/item/token');
  });
  it('refuses replacing a Team-shared inline value with an external source before dispatch', async () => {
    const h = await harness({ shared: true });
    const source = { kind: 'external', contribution: { pluginId: 'acme.vault', localId: 'vault' }, account: 'account', reference: 'op://vault/item/token' };
    expect(await h.run('update', ['resource-id', '--source-json', JSON.stringify(source)], '', true))
      .toMatchObject({ ok: false, error: { code: 'recipient_mode_unsupported' } });
    expect(h.writes).toEqual([]);
    expect(terminal.promptInput).not.toHaveBeenCalled();
  });
  it('imports an explicitly selected native passkey export through the normal private Saved Secret writer', async () => {
    const h = await harness();
    const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
      .export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const exported = { credentialId: 'Y3JlZGVudGlhbA==', isResidentCredential: true, rpId: 'login.example',
      privateKey, userHandle: 'dXNlcg==', signCount: -1, backupEligibility: true, backupState: true,
      userName: 'person', userDisplayName: 'Person' };
    expect(await h.run('create', ['Passkey', '--passkey-format', 'chromium-cdp'], JSON.stringify(exported))).toMatchObject({ ok: true });
    expect(h.writes).toHaveLength(1);
    expect(h.opened(h.writes[0]!)).toEqual({ v: 2, name: 'Passkey', kind: 'other', source: {
      kind: 'passkey', rpId: exported.rpId, credentialId: exported.credentialId, userHandle: exported.userHandle,
      privateKey, algorithm: -7, signCount: 0, backupEligibility: true, backupState: true,
      userName: 'person', userDisplayName: 'Person',
    } });
    expect(h.stdout.join('\n')).not.toContain(privateKey);
  });
  it('preserves JSON-looking inline values unless the person selects a passkey export format', async () => {
    const h = await harness();
    const value = '{"kind":"passkey","privateKey":"inline-sentinel"}';
    expect(await h.run('create', ['JSON value'], value)).toMatchObject({ ok: true });
    expect(h.opened(h.writes[0]!)).toMatchObject({ v: 1, value });
  });
  it.each([
    ['{"privateKey":"private-sentinel"}', 'input_invalid'],
    ['{"type":"passkey","key":"private-sentinel"}', 'input_invalid'],
    ['{"privateKey":"private-sentinel" invalid-json', 'input_invalid'],
    [JSON.stringify({ credentialId: 'YQ==', isResidentCredential: true, rpId: 'login.example',
      privateKey: 'a2V5', userHandle: 'dQ==', signCount: 0 }), 'source_format_unsupported'],
  ])('refuses an incomplete or unsupported export without disclosing it', async (value, code) => {
    const h = await harness();
    expect(await h.run('create', ['Passkey', '--passkey-format', 'chromium-cdp'], value)).toMatchObject({ ok: false, error: { code } });
    expect(h.writes).toEqual([]);
    expect(h.stdout.join('\n')).not.toContain('private-sentinel');
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
