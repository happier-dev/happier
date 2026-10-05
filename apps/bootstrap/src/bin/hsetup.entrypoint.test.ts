import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('hsetup executable entrypoint', () => {
  it.each(['embedded', 'escaped-source'] as const)('dispatches a task from the %s main entrypoint', (entrypointKind) => {
    // Bun's executable owns main-module identity, while argv[1] names the embedded executable.
    // The loader preserves every task internal and changes only the runtime module metadata.
    const loader = new URL('./hsetup.entrypointLoader.mjs', import.meta.url);
    const registerLoader = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)});`;
    const entrypoint = fileURLToPath(new URL('./hsetup.ts', import.meta.url));
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(registerLoader)}`, entrypoint, 'system-tasks', 'run',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HSETUP_ENTRYPOINT_TEST_KIND: entrypointKind },
      input: JSON.stringify({ protocolVersion: 1, kind: 'daemon.service.status.v1', params: { target: { kind: 'invalid' } } }),
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(result.status).toBe(1);
  });

  it('can be imported without dispatching a task', () => {
    const entrypoint = pathToFileURL(fileURLToPath(new URL('./hsetup.ts', import.meta.url))).href;
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(entrypoint)}); console.log('imported');`,
    ], { encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('imported');
    expect(result.stderr).toBe('');
  });
});
