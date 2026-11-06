import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { dokploy } from './dokploy.js';

// Execute the authored shell unchanged; Docker and destructive filesystem commands
// are OS boundaries, with no connection to the test host's engine or /etc.
function removal(mode: 'inactive' | 'manager' | 'populated' | 'denied' | 'query-failed') {
  const root = mkdtempSync(join(tmpdir(), 'happier-dokploy-remove-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  writeFileSync(calls, '');
  const executable = (name: string, body: string) => writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  executable('uname', 'echo Linux');
  executable('rm', 'printf "rm %s\\n" "$*" >> "$FAKE_CALLS"');
  executable('docker', `
case "$1 $2" in
  'info '|'info --format')
    if [ "$FAKE_MODE" = denied ]; then echo 'permission denied connecting to Docker' >&2; exit 1; fi
    if [ "$2" = --format ]; then
      if [ "$FAKE_MODE" = inactive ]; then echo false; else echo true; fi
    fi ;;
  'service ls'|'secret ls')
    if [ "$FAKE_MODE" = inactive ]; then echo 'This node is not a swarm manager' >&2; exit 1; fi
    if [ "$FAKE_MODE" = query-failed ]; then echo 'Docker API unavailable' >&2; exit 1; fi
    if [ "$FAKE_MODE" = populated ]; then
      if [ "$1" = service ]; then printf '%s\\n' dokploy dokploy-postgres unrelated-service;
      else printf '%s\\n' dokploy_auth_secret dokploy_postgres_password unrelated-secret; fi
    fi ;;
  'container ls')
    if [ "$FAKE_MODE" = populated ]; then printf '%s\\n' dokploy-traefik unrelated-container; fi ;;
  'volume ls')
    if [ "$FAKE_MODE" = populated ]; then printf '%s\\n' dokploy dokploy-postgres unrelated-volume; fi ;;
  'service rm'|'secret rm'|'container rm'|'volume rm') printf 'docker %s\\n' "$*" >> "$FAKE_CALLS" ;;
  *) echo "Unexpected Docker command: $*" >&2; exit 99 ;;
esac`);
  const step = dokploy.removeSteps?.find(candidate => candidate.kind === 'script');
  if (step?.kind !== 'script') throw new Error('Dokploy removal must have its authored script');
  return {
    run: () => spawnSync(step.shell, ['-s', '--'], { input: step.body, encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FAKE_MODE: mode, FAKE_CALLS: calls } }),
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
  };
}

it.skipIf(process.platform === 'win32').each(['inactive', 'manager'] as const)(
  'removes an absent Dokploy idempotently on an %s engine', mode => {
    const fixture = removal(mode);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = fixture.run();
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    }
    expect(fixture.calls()).toEqual(['rm -rf -- /etc/dokploy', 'rm -rf -- /etc/dokploy']);
  },
);

it.skipIf(process.platform === 'win32')('removes only Dokploy resources from an available manager', () => {
  const fixture = removal('populated');
  const result = fixture.run();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(fixture.calls()).toEqual([
    'docker service rm dokploy', 'docker service rm dokploy-postgres',
    'docker container rm --force dokploy-traefik',
    'docker volume rm dokploy', 'docker volume rm dokploy-postgres',
    'docker secret rm dokploy_postgres_password', 'docker secret rm dokploy_auth_secret',
    'rm -rf -- /etc/dokploy',
  ]);
});

it.skipIf(process.platform === 'win32').each(['denied', 'query-failed'] as const)(
  'surfaces a genuine Docker %s failure without claiming removal', mode => {
    const fixture = removal(mode);
    expect(fixture.run().status).toBe(1);
    expect(fixture.calls()).toEqual([]);
  },
);
