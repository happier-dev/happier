import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { publishManagedLimaLocalSshConfig } from './ssh_publication.mjs';

test('managed Lima publishes a strict local guest SSH config without changing the retained source config', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'managed-lima-ssh-' });
  const sourceDir = fixture.path('lima', 'worker');
  const source = fixture.path('lima', 'worker', 'ssh.config');
  const destination = fixture.path('published', 'guest.conf');
  await mkdir(sourceDir, { recursive: true });
  const original = [
    'Host lima-worker',
    '  Hostname 127.0.0.1',
    '  User lima',
    '  Port 60022',
    `  IdentityFile ${fixture.path('lima', '_config', 'user')}`,
    '',
  ].join('\n');
  await writeFile(source, original, 'utf8');
  await chmod(source, 0o600);

  const result = await publishManagedLimaLocalSshConfig({
    instance: { sshConfigFile: source },
    destination,
    alias: 'happier-worker-guest',
  });

  assert.deepEqual(result, { ssh: 'happier-worker-guest', sshConfigFile: destination });
  assert.equal(await readFile(source, 'utf8'), original);
  const published = await readFile(destination, 'utf8');
  assert.match(published, /^Host happier-worker-guest$/m);
  assert.match(published, /^  IdentitiesOnly yes$/m);
  assert.match(published, /^  ForwardAgent no$/m);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.path('published'))).mode & 0o777, 0o700);
});

test('managed Lima SSH publication refuses missing metadata and unsafe aliases', async () => {
  await assert.rejects(
    publishManagedLimaLocalSshConfig({ instance: {}, destination: '/tmp/guest.conf', alias: 'guest' }),
    /SSH config metadata is unavailable/,
  );
  await assert.rejects(
    publishManagedLimaLocalSshConfig({
      instance: { sshConfigFile: '/tmp/source.conf' },
      destination: '/tmp/guest.conf',
      alias: 'bad alias',
    }),
    /invalid SSH alias/,
  );
});
