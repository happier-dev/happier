import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-machine-recipes/manifest';

const admitted = parsePluginManifest(PLUGIN_MANIFEST);
if (!admitted.ok) throw new Error(`Bundled Machine recipe manifest was refused: ${JSON.stringify(admitted.diagnostics)}`);
const recipe = (id: string) => {
  const found = admitted.manifest.contributes.machineRecipes?.find(entry => entry.id === id);
  if (!found) throw new Error(`Missing bundled recipe ${id}`);
  return found;
};
const coolify = recipe('coolify'), dokploy = recipe('dokploy');

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform === 'win32')('vendor removal at the real shell / Docker boundary', () => {
  it.each([
    { recipe: coolify, expected: [
      'container rm --force coolify', 'container rm --force coolify-db', 'container rm --force coolify-redis',
      'container rm --force coolify-sentinel', 'container rm --force coolify-realtime', 'container rm --force coolify-proxy',
      'volume rm coolify-db', 'volume rm coolify-redis', 'rm -rf -- /data/coolify',
    ] },
    { recipe: dokploy, expected: [
      'service rm dokploy', 'service rm dokploy-traefik', 'service rm dokploy-postgres', 'service rm dokploy-redis',
      'container rm --force dokploy-traefik', 'volume rm dokploy', 'volume rm dokploy-postgres', 'volume rm dokploy-redis',
      'secret rm dokploy_postgres_password', 'secret rm dokploy_auth_secret', 'rm -rf -- /etc/dokploy',
    ] },
  ])('removes only $recipe.title resources and stops before mutation when Docker cannot be observed', async ({ recipe, expected }) => {
    const root = await mkdtemp(join(tmpdir(), 'recipe-removal-')); roots.push(root);
    const log = join(root, 'effects');
    // Genuine OS boundaries: the production shell body runs unchanged; fake
    // Docker and rm record effects so the host and every real install are safe.
    await writeFile(join(root, 'docker'), `#!/bin/sh
case "$1 $2" in
  'info ') test -z "$DOCKER_UNAVAILABLE" ;;
  'info --format') test -z "$DOCKER_UNAVAILABLE" || exit 1; printf 'true\\n' ;;
  'container ls') printf '%s\\n' foreign coolify coolify-db coolify-redis coolify-sentinel coolify-realtime coolify-proxy dokploy-traefik ;;
  'volume ls') printf '%s\\n' foreign coolify-db coolify-redis dokploy dokploy-postgres dokploy-redis ;;
  'service ls') printf '%s\\n' foreign dokploy dokploy-traefik dokploy-postgres dokploy-redis ;;
  'secret ls') printf '%s\\n' foreign dokploy_postgres_password dokploy_auth_secret ;;
  *) printf '%s\\n' "$*" >> "$EFFECT_LOG" ;;
esac
`, { mode: 0o755 });
    await writeFile(join(root, 'rm'), '#!/bin/sh\nprintf "rm %s\\n" "$*" >> "$EFFECT_LOG"\n', { mode: 0o755 });
    await writeFile(join(root, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n', { mode: 0o755 });
    await writeFile(log, '');
    const install = recipe.steps.find(step => step.id === 'install');
    if (install?.kind !== 'script' || !install.check) throw new Error('No installer check');
    const step = recipe.removeSteps?.find(step => step.kind === 'script');
    if (step?.kind !== 'script') throw new Error('No declared removal');
    const unsupported = spawnSync('sh', ['-s', '--'], { input: install.check.body, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, EFFECT_LOG: log, DOCKER_UNAVAILABLE: '' } });
    expect(unsupported.status).toBe(2);
    expect(spawnSync('sh', ['-s', '--'], { input: step.body, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, EFFECT_LOG: log, DOCKER_UNAVAILABLE: '' } }).status).toBe(2);
    expect(await readFile(log, 'utf8')).toBe('');
    await writeFile(join(root, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n', { mode: 0o755 });
    const run = (unavailable: boolean) => spawnSync('sh', ['-s', '--'], { input: step.body, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}`, EFFECT_LOG: log, DOCKER_UNAVAILABLE: unavailable ? '1' : '' } });
    expect(run(true).status).not.toBe(0);
    expect(await readFile(log, 'utf8')).toBe('');
    const result = run(false);
    expect(result.status, result.stderr).toBe(0);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(expected);
  });
});
