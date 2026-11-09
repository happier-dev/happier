import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// Real subprocess/Worker integration uses the CLI integration lane's lifetime
// (apps/cli/vitest.integration.config.ts), rather than Vitest's unit default.
it('carries only the safe native cause through the compiled Modal worker and scoped role', () => {
  const directory = mkdtempSync(join(tmpdir(), 'happier-modal-worker-cause-'));
  try {
    // Only the external Modal SDK is replaced. The compiled role, native
    // decoder, Worker, credential scoping and error transport all execute.
    writeFileSync(join(directory, 'modal.mjs'), `
const sandbox = { sandboxId: 'sb-retained', async poll() { return null; },
  async exec() { throw Object.assign(new Error('private native execution body'), { name: 'RemoteError' }); } };
export class ModalClient {
  constructor() {
    this.versionReads = 0;
    this.profile = { serverUrl: process.env.MODAL_SERVER_URL, tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET };
    this.sandboxes = { async fromId() {
      if (process.env.MODAL_ENVIRONMENT === 'lookup') throw Object.assign(new Error('private native lookup body'),
        { '@@nice-grpc:ClientError': true, code: 7, details: 'private reflected input' });
      return sandbox;
    }, async *list() { yield sandbox; } };
  }
  version() {
    this.versionReads++;
    return process.env.MODAL_ENVIRONMENT === 'unsupported'
      || process.env.MODAL_ENVIRONMENT === 'qualified-once' && this.versionReads > 1 ? '0.12.0' : '0.11.0';
  }
  environmentName() { return process.env.MODAL_ENVIRONMENT; }
  close() {}
}
`);
    writeFileSync(join(directory, 'loader.mjs'), `
export async function resolve(specifier, context, nextResolve) {
  return specifier === 'modal' ? { url: new URL('./modal.mjs', import.meta.url).href, shortCircuit: true }
    : nextResolve(specifier, context);
}
`);
    const preload = join(directory, 'preload.mjs');
    writeFileSync(preload, `import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));`);
    const script = join(directory, 'invoke.mjs');
    const compiled = new URL('../../dist/machine/scopedSdk.js', import.meta.url);
    writeFileSync(script, `
import { invokeScopedModalRole } from ${JSON.stringify(compiled.href)};
const account = { service: { pluginId: 'happier.machine.modal', localId: 'modal-account' }, accountId: 'fixture' };
const results = [];
for (const [role, environment] of [['bootstrap', 'lookup'], ['exec', 'execution'], ['check', 'unsupported'], ['check', 'qualified-once']]) {
  const context = { invokedAtMs: 123, signal: new AbortController().signal, services: { connectedAccounts: {
    async getBinding() { return { account }; },
    async materialize() { return { kind: 'environment', env: { MODAL_TOKEN_ID: 'fixture-id',
      MODAL_TOKEN_SECRET: 'fixture-secret', MODAL_SERVER_URL: 'http://127.0.0.1:1', MODAL_ENVIRONMENT: environment } }; },
  } } };
  try {
    const value = await invokeScopedModalRole(role, { resource: { appId: 'ap-selected', sandboxId: 'sb-retained' },
      ...(role === 'exec' ? { argv: ['true'] } : {}) }, context);
    if (environment !== 'qualified-once') throw new Error('Expected the native boundary to fail');
    results.push(value);
  } catch (error) {
    results.push({ name: error.name, code: error.code, details: error.details, message: error.message,
      serialized: JSON.stringify(error) });
  }
}
console.log(JSON.stringify(results));
`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject([
      { name: 'PluginError', code: 'modal_lookup_unavailable', details: { nativeCause: { grpcStatusCode: 7 } } },
      { name: 'PluginError', code: 'modal_exec_outcome_unknown', details: { nativeCause: { sdkError: 'RemoteError' } } },
      { name: 'PluginError', code: 'modal_sdk_unsupported' },
      { available: true },
    ]);
    expect(result.stdout + result.stderr).not.toContain('private');
    expect(result.stdout + result.stderr).not.toContain('fixture-secret');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
