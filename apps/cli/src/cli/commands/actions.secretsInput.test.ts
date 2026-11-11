import { afterEach, describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { compileActionCliFields } from '@/cli/actions/compiledCommands';
import { handleActionsCommand, resolveInvokeActionInput } from './actions';

afterEach(() => { process.exitCode = 0; });

function resolve(actionId: 'secrets.delete' | 'secrets.update' | 'secrets.create', tokens: string[]) {
  const spec = getActionSpec(actionId);
  return resolveInvokeActionInput(['invoke', actionId, ...tokens, '--json'], {
    kind: 'local', actionId, spec, ...compileActionCliFields(spec),
  });
}
describe('Saved Secret invoke input', () => {
  it.each([
    ['--secret-id', '831c054a-5477-4fba-a00b-1a624bcb98c8'],
    ['--secret-id-json', '"831c054a-5477-4fba-a00b-1a624bcb98c8"'],
    ['--input-json', '{"secretId":"831c054a-5477-4fba-a00b-1a624bcb98c8","expectedUpdatedAt":37}'],
  ])('parses delete through %s', (...tokens) => {
    expect(resolve('secrets.delete', tokens)).toEqual({ secretId: '831c054a-5477-4fba-a00b-1a624bcb98c8', ...(tokens[0] === '--input-json' ? { expectedUpdatedAt: 37 } : {}) });
  });
  it('retains value-free schema diagnostics at the public invoke boundary', async () => {
    const { captureConsoleJsonOutput } = await import('@/testkit/logger/captureOutput');
    const output = captureConsoleJsonOutput();
    try {
      await handleActionsCommand(['invoke', 'secrets.delete', '--secret-id-json', '42', '--json']);
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments', message: expect.stringContaining('secretId') } });
    } finally { output.restore(); }
  });
  it.each([['--value=confidential-sentinel'], ['--name', 'Acme', 'confidential-sentinel'],
    ['--input-json', '{"name":"Acme","value":"confidential-sentinel"}']])('never echoes a rejected secret operand', (...tokens) => {
    try { resolve('secrets.create', tokens); throw new Error('Expected refusal'); }
    catch (error) { expect(String(error)).not.toContain('confidential-sentinel'); expect(String(error)).toContain('stdin'); }
  });
  it('parses create and rename before confidential input preparation', () => {
    expect(resolve('secrets.create', ['--name', 'Acme'])).toMatchObject({ name: 'Acme' });
    expect(resolve('secrets.update', ['--secret-id', 'Acme', '--rename', 'Renamed'])).toEqual({ secretId: 'Acme', rename: 'Renamed' });
  });
});
