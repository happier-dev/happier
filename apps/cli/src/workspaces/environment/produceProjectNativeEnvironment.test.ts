import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceProjectNativeEnvironment, type ProjectNativeEnvironmentInput, type ProjectNativeEnvironmentIo } from './produceProjectNativeEnvironment';

// Managed executable resolution and process execution are genuine OS boundaries.
// All native selection, validation, parsing and failure classification stay real.
const io: ProjectNativeEnvironmentIo = {
  resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.4' }),
  run: async () => ({ exitCode: 0, stdout: 'PATH=/native/bin\0KEEP=inherited\0NATIVE=value=with\nnewline\0' }),
};
let input: ProjectNativeEnvironmentInput;
beforeEach(async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'happier-native-environment with spaces-'));
  await writeFile(join(cwd, 'mise.toml'), '[env]\nVALUE = "native"\n');
  input = { selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, cwd, env: { PATH: '/host/bin', REMOVE: 'remove' }, platform: 'linux', io };
});
afterEach(async () => { await rm(input.cwd, { recursive: true, force: true }); });

describe('produceProjectNativeEnvironment', () => {
  it('produces the complete native environment before destination launch, including native removals', async () => {
    const calls: unknown[] = [];
    const result = await produceProjectNativeEnvironment({ ...input, io: { ...io,
      resolveTool: async () => ({ executablePath: '/tools/wrapper', args: ['mise'], version: '2026.10.4' }),
      run: async (request) => { calls.push(request); return io.run(request); },
    } });
    expect(result).toEqual({ status: 'ready', env: { PATH: '/native/bin', KEEP: 'inherited', NATIVE: 'value=with\nnewline' } });
    expect(calls).toEqual([expect.objectContaining({ command: '/tools/wrapper', args: ['mise', 'exec', '--', '/usr/bin/env', '-0'], cwd: input.cwd, env: { ...input.env, MISE_OVERRIDE_CONFIG_FILENAMES: join(input.cwd, 'mise.toml') } })]);
    expect(input.env).toEqual({ PATH: '/host/bin', REMOVE: 'remove' });
  });

  it('refuses unavailable and uncharacterized tools/platforms instead of returning the host environment', async () => {
    expect(await produceProjectNativeEnvironment({ ...input, io: { ...io, resolveTool: async () => null } })).toEqual({ status: 'refused', kind: 'unavailable', code: 'native_tool_unavailable' });
    expect(await produceProjectNativeEnvironment({ ...input, platform: 'win32' })).toMatchObject({ status: 'refused', kind: 'unsupported' });
    expect(await produceProjectNativeEnvironment({ ...input, platform: 'darwin' })).toMatchObject({ status: 'refused', kind: 'unsupported' });
    expect(await produceProjectNativeEnvironment({ ...input, io: { ...io, resolveTool: async () => ({ executablePath: '/tools/mise', version: '2026.10.5' }) } }))
      .toMatchObject({ status: 'refused', kind: 'unsupported', code: 'native_version_not_characterized' });
  });

  it.each([
    ['devbox', 'devbox.json', '0.18.4'],
    ['devenv', 'devenv.nix', '2.4.0'],
    ['flox', '.flox/env/manifest.toml', '1.18.1-gf264cf2'],
    ['nix_flake', 'flake.nix', '2.35.2'],
  ] as const)('produces the complete %s environment through the same owner and retains cancellation custody', async (tool, configPath, version) => {
    await mkdir(join(input.cwd, '.flox/env'), { recursive: true });
    await writeFile(join(input.cwd, configPath), 'reviewed native configuration');
    const nativeInput: ProjectNativeEnvironmentInput = { ...input, selection: { kind: 'toolchain', tool, configPath }, io: {
      ...io, resolveTool: async () => ({ executablePath: '/tools/native', args: ['installed-prefix'], version }),
      run: async () => ({ exitCode: 0, stdout: 'native hook diagnostic\n\0HAPPIER_NATIVE_ENV_V1\0PATH=/native/bin\0KEEP=inherited\0NATIVE=value=with\nnewline\0' }),
    } };
    expect(await produceProjectNativeEnvironment(nativeInput)).toEqual({ status: 'ready', env: { PATH: '/native/bin', KEEP: 'inherited', NATIVE: 'value=with\nnewline' } });
    expect(await produceProjectNativeEnvironment({ ...nativeInput, io: { ...nativeInput.io,
      resolveTool: async () => ({ executablePath: '/tools/native', version: `${version}.unqualified` }),
    } })).toMatchObject({ status: 'refused', kind: 'unsupported', code: 'native_version_not_characterized' });
    expect(await produceProjectNativeEnvironment({ ...nativeInput, io: { ...nativeInput.io, run: io.run } }))
      .toMatchObject({ status: 'refused', kind: 'native_failed', code: 'native_environment_invalid' });
    expect(await produceProjectNativeEnvironment({ ...nativeInput, nativeCommandEnvironment: nativeInput.selection, io: {
      resolveTool: async () => { throw new Error('Already-native invocation must not probe'); },
      run: async () => { throw new Error('Already-native invocation must not evaluate'); },
    } })).toEqual({ status: 'ready', env: input.env });
    expect(await produceProjectNativeEnvironment({ ...nativeInput, io: { ...nativeInput.io, run: async () => ({ exitCode: 1, stdout: '' }) } }))
      .toMatchObject({ status: 'refused', kind: 'native_failed' });
    const controller = new AbortController();
    await expect(produceProjectNativeEnvironment({ ...nativeInput, signal: controller.signal, io: { ...nativeInput.io,
      run: async () => { controller.abort(); throw Object.assign(new Error('private native output'), { code: 'plugin_exec_termination_incomplete' }); },
    } })).rejects.toMatchObject({ kind: 'outcome_uncertain', code: 'native_environment_termination_incomplete' });
  });

  it('does not evaluate the repository for host selection or an already-native command', async () => {
    const forbiddenIo: ProjectNativeEnvironmentIo = { resolveTool: async () => { throw new Error('unexpected tool probe'); }, run: async () => { throw new Error('unexpected native effect'); } };
    expect(await produceProjectNativeEnvironment({ ...input, selection: { kind: 'host' }, io: forbiddenIo })).toEqual({ status: 'ready', env: input.env });
    expect(await produceProjectNativeEnvironment({ ...input, nativeCommandEnvironment: input.selection, io: forbiddenIo })).toEqual({ status: 'ready', env: input.env });
  });

  it('refuses failed, malformed and cancelled production and permits a fresh retry', async () => {
    const failure = await produceProjectNativeEnvironment({ ...input, io: { ...io, run: async () => ({ exitCode: 1, stdout: 'secret-value' }) } });
    expect(failure).toEqual({ status: 'refused', kind: 'native_failed', code: 'native_environment_failed' });
    expect(await produceProjectNativeEnvironment({ ...input, io: { ...io, run: async () => ({ exitCode: 0, stdout: 'secret-value' }) } })).toEqual({ status: 'refused', kind: 'native_failed', code: 'native_environment_invalid' });
    const controller = new AbortController();
    expect(await produceProjectNativeEnvironment({ ...input, signal: controller.signal, io: { ...io, run: async () => { controller.abort(); return { exitCode: 0, stdout: 'KEY=value\0' }; } } })).toEqual({ status: 'refused', kind: 'cancelled', code: 'native_environment_cancelled' });
    expect(await produceProjectNativeEnvironment(input)).toMatchObject({ status: 'ready' });
  });

  it('preserves unconfirmed process custody even when cancellation was requested', async () => {
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const result = produceProjectNativeEnvironment({ ...input, signal: controller.signal, io: {
        ...io, run: async () => {
          if (abort) controller.abort();
          throw Object.assign(new Error('private native output'), { code: 'plugin_exec_termination_incomplete' });
        },
      } });
      await expect(result).rejects.toMatchObject({
        kind: 'outcome_uncertain', code: 'native_environment_termination_incomplete',
        message: 'Native environment process termination could not be verified',
      });
    }
    // Classification uses the process owner's structured code, never prose.
    expect(await produceProjectNativeEnvironment({ ...input, io: {
      ...io, run: async () => { throw new Error('plugin_exec_termination_incomplete'); },
    } })).toEqual({ status: 'refused', kind: 'native_failed', code: 'native_environment_failed' });
  });
});
