import { describe, expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createDockerSandboxesProvider } from './provider.js';
import { createDockerSandboxesNativeClient } from './nativeClient.js';

const executable = { kind: 'systemTool', id: 'sbx' } as const;
const operationId = 'build-1115';
const builderName = `happier-prepared-${operationId}`;
const templateId = `happier-prepared:${operationId}`;
const launch = { templateId: 'docker.io/sbx/shell:latest', name: 'my-sandbox' };
const operation = { operationId, launch };
const input = { launch: { provider: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' }, schemaVersion: 1, choices: launch },
  cli: { identity: 'cli-linux-x64', versionId: '0.3.0', binaryPath: '/opt/happier/happier', installScript: 'install-public-cli',
    files: [{ path: 'cli.bundle', contentsBase64: 'AAH/' }] }, setupScript: 'printf prepared > /opt/prepared\n' };
const processResult = (exitCode = 0, stdout = ''): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
  stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
});

// The genuine boundary is the native sbx process; all provider logic stays real.
function fixture(options: { fail?: string; lostSave?: boolean; unknownInventory?: boolean } = {}) {
  const builders = new Set<string>();
  const templates = new Set<string>(['someone-else:keep']);
  const run = vi.fn<ExecService['run']>(async request => {
    const args = [...(request.args ?? [])];
    if (options.fail === args[0] || (options.fail === 'setup' && args.at(-1) === '-s')) return processResult(17);
    if (args[0] === 'create') builders.add(args[args.indexOf('--name') + 1]);
    if (args[0] === 'ls') return processResult(0, JSON.stringify({ sandboxes: [...builders].map(name => ({ name, status: 'stopped' })) }));
    if (args[0] === 'template' && args[1] === 'ls') {
      return { ...processResult(0, [...templates].join('\n')), stdoutTruncated: options.unknownInventory ?? false };
    }
    if (args[0] === 'template' && args[1] === 'save') {
      templates.add(args[3]);
      if (options.lostSave) throw new Error('native process reply lost');
    }
    if (args[0] === 'template' && args[1] === 'rm') templates.delete(args.at(-1)!);
    if (args[0] === 'rm') builders.delete(args.at(-1)!);
    return processResult();
  });
  return { run, builders, templates, provider: createDockerSandboxesProvider({ run }, executable, 123) };
}

describe('Docker Sandboxes prepared templates', () => {
  it('reuses a saved local template without a registry pull', async () => {
    const run = vi.fn<ExecService['run']>(async () => processResult());
    await createDockerSandboxesNativeClient({ run }, executable).create({ name: 'new-session', templateId });
    expect(run.mock.calls[0]?.[0].args).toEqual(['create', '--name', 'new-session', '--template', templateId, '--pull', 'never', 'shell']);
  });
  it('builds only a new mountless shell guest, streams setup on stdin, saves its template and removes its builder', async () => {
    const f = fixture();
    const built = await f.provider.buildPreparation({ operationId, input });
    expect(built).toMatchObject({ kind: 'ready', artifact: { value: { templateId, launch: { ...launch, templateId } } } });
    expect(f.templates.has(templateId)).toBe(true);
    expect(f.builders.size).toBe(0);
    const create = f.run.mock.calls.find(([request]) => request.args?.[0] === 'create')?.[0];
    expect(create?.args).toEqual(['create', '--name', builderName, '--template', launch.templateId,
      '--skills', 'off', '--static-mcp', 'none', 'shell']);
    const upload = f.run.mock.calls.find(([request]) => request.args?.includes('happier-prepare-file'))?.[0];
    expect(upload?.stdin && [...upload.stdin]).toEqual([0, 1, 255]);
    const setup = f.run.mock.calls.find(([request]) => request.args?.at(-1) === '-s')?.[0];
    expect(setup?.args).toEqual(['exec', '--interactive', '--', builderName, 'sh', '-eu', '-s']);
    expect(new TextDecoder().decode(setup?.stdin)).toContain(input.cli.installScript + '\n' + input.setupScript);
    expect(JSON.stringify(f.run.mock.calls.map(([request]) => request.args))).not.toContain(input.setupScript);
    expect(f.run.mock.calls.some(([request]) => request.args?.includes('login'))).toBe(false);
    f.run.mockClear();
    expect(await f.provider.buildPreparation({ operationId, input })).toMatchObject({ kind: 'ready' });
    expect(f.run.mock.calls.every(([request]) => request.args?.[0] === 'ls' || request.args?.[1] === 'ls')).toBe(true);
  });

  it('adopts a complete saved template after interruption using the original launch, without allocating', async () => {
    const f = fixture();
    f.templates.add(templateId);
    expect(await f.provider.inspectPreparation({ operationId, launch })).toMatchObject({ kind: 'ready', artifact: { value: { templateId, launch: { ...launch, templateId } } } });
    expect(f.run.mock.calls.every(([request]) => request.args?.[0] === 'ls' || request.args?.[1] === 'ls')).toBe(true);
    expect(await f.provider.inspectPreparation({ nativeOperation: operation })).toMatchObject({ kind: 'ready' });
  });

  it('supports the native 63-character builder boundary and rejects longer identities without allocating', async () => {
    const f = fixture();
    const fitsNativeName = 'a'.repeat(63 - 'happier-prepared-'.length);
    expect(await f.provider.buildPreparation({ operationId: fitsNativeName, input })).toMatchObject({ kind: 'ready' });
    f.run.mockClear();
    await expect(f.provider.buildPreparation({ operationId: `${fitsNativeName}a`, input })).rejects.toThrow();
    await expect(f.provider.destroyPreparation({ artifact: { templateId: `happier-prepared:${fitsNativeName}a`, launch } })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('retains the owned cleanup reference when setup fails and never saves the partial filesystem', async () => {
    const f = fixture({ fail: 'setup' });
    const built = await f.provider.buildPreparation({ operationId, input });
    expect(built).toMatchObject({ kind: 'unknown', code: 'docker_sandbox_prepare_setup_failed', nativeOperationRef: { value: { operationId, launch } } });
    expect(f.templates.has(templateId)).toBe(false);
    expect(await f.provider.destroyPreparation({ nativeOperation: { operationId, launch } })).toEqual({ kind: 'confirmed' });
    expect(f.builders.size).toBe(0);
    expect([...f.templates]).toEqual(['someone-else:keep']);
  });

  it('recovers a lost save reply by inventory without allocating or saving again', async () => {
    const f = fixture({ lostSave: true });
    expect(await f.provider.buildPreparation({ operationId, input })).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId, launch } } });
    f.run.mockClear();
    expect(await f.provider.inspectPreparation({ operationId, launch })).toMatchObject({ kind: 'failed', code: 'docker_sandbox_prepare_cleanup_required' });
    expect(f.run.mock.calls.every(([request]) => request.args?.[0] === 'ls' || request.args?.[1] === 'ls')).toBe(true);
    expect(await f.provider.destroyPreparation({ artifact: { templateId, launch } })).toEqual({ kind: 'confirmed' });
    expect(f.templates.has(templateId)).toBe(false);
    expect(f.builders.size).toBe(0);
  });

  it('never calls an incomplete inventory absent or deletes templates it cannot identify', async () => {
    const f = fixture({ unknownInventory: true });
    expect(await f.provider.inspectPreparation({ operationId, launch })).toMatchObject({ kind: 'unknown' });
    expect(await f.provider.destroyPreparation({ artifact: { templateId, launch } })).toMatchObject({ kind: 'unknown' });
    expect(f.run.mock.calls.some(([request]) => request.args?.includes('rm'))).toBe(false);
  });

  it('confirms already-absent owned resources from the complete inventory without rechecking absence', async () => {
    const run = vi.fn<ExecService['run']>()
      .mockResolvedValueOnce(processResult(0, 'someone-else:keep\n'))
      .mockResolvedValueOnce(processResult(0, '{"sandboxes":[]}'))
      .mockRejectedValue(new Error('native service went offline after the complete observation'));
    const provider = createDockerSandboxesProvider({ run }, executable, 123);
    expect(await provider.destroyPreparation({ nativeOperation: { operationId, launch } })).toEqual({ kind: 'confirmed' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects unrelated artifacts and ambiguous cleanup identities before any native effect', async () => {
    const f = fixture();
    await expect(f.provider.destroyPreparation({ artifact: { templateId: 'someone-else:keep', launch } })).rejects.toThrow();
    await expect(f.provider.destroyPreparation({ artifact: { templateId, launch }, nativeOperation: { operationId: 'another-build', launch } })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect([...f.templates]).toEqual(['someone-else:keep']);
  });

  it('preserves native boundary refusals and performs no preparation after cancellation', async () => {
    const refusal = new PluginError({ code: 'host_access_denied' });
    const provider = createDockerSandboxesProvider({ run: async () => { throw refusal; } }, executable, 123);
    await expect(provider.buildPreparation({ operationId, input })).rejects.toBe(refusal);
    const signal = AbortSignal.abort();
    const run = vi.fn<ExecService['run']>();
    const cancelled = createDockerSandboxesProvider({ run }, executable, 123, signal);
    await expect(cancelled.buildPreparation({ operationId, input })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
