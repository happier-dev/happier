import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareTmuxWindowLaunch } from './windowLaunchScript';

const execFileAsync = promisify(execFile);

describe('prepareTmuxWindowLaunch', () => {
  const testDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ));
  });

  async function createTmuxHelper(body: string): Promise<Readonly<{ directory: string; path: string }>> {
    const directory = await mkdtemp(join(tmpdir(), 'happier-tmux-helper-test-'));
    testDirectories.push(directory);
    const path = join(directory, 'tmux');
    await writeFile(path, `#!/bin/sh\n${body}\n`, { encoding: 'utf8', mode: 0o700 });
    await chmod(path, 0o700);
    return { directory, path };
  }

  it('does not execute the target when the readiness signal fails', async () => {
    const helper = await createTmuxHelper('exit 23');
    const targetMarker = join(helper.directory, 'target-executed');
    const prepared = await prepareTmuxWindowLaunch({
      args: ['/bin/sh', '-c', `printf executed > ${JSON.stringify(targetMarker)}`],
      env: { PROVIDER_SECRET: 'provider-secret' },
      unsetEnvKeys: [],
      readySignal: 'ready-failure-test',
    });

    await expect(execFileAsync('/bin/sh', ['-c', prepared.command], {
      env: { ...process.env, PATH: `${helper.directory}:${process.env.PATH ?? ''}` },
    })).rejects.toMatchObject({ code: 23 });
    await expect(access(targetMarker)).rejects.toBeDefined();
    await prepared.cleanup();
  });

  it('unsets owned inherited keys before readiness and exports provider values only after readiness succeeds', async () => {
    const helper = await createTmuxHelper(`
if [ "\${OWNED_NATIVE_KEY+x}" = x ]; then
  printf inherited > "$READINESS_OBSERVATION"
else
  printf unset > "$READINESS_OBSERVATION"
fi
exit 0
`.trim());
    const readinessObservation = join(helper.directory, 'readiness-observation');
    const targetObservation = join(helper.directory, 'target-observation');
    const prepared = await prepareTmuxWindowLaunch({
      args: [
        '/bin/sh',
        '-c',
        'printf "%s|%s" "$PROVIDER_SECRET" "${OWNED_NATIVE_KEY-unset}" > "$TARGET_OBSERVATION"',
      ],
      env: {
        PROVIDER_SECRET: 'provider-secret',
        TARGET_OBSERVATION: targetObservation,
      },
      unsetEnvKeys: ['OWNED_NATIVE_KEY'],
      readySignal: 'ready-isolation-test',
    });

    await execFileAsync('/bin/sh', ['-c', prepared.command], {
      env: {
        ...process.env,
        PATH: `${helper.directory}:${process.env.PATH ?? ''}`,
        OWNED_NATIVE_KEY: 'ambient-native-secret',
        READINESS_OBSERVATION: readinessObservation,
      },
    });

    await expect(readFile(readinessObservation, 'utf8')).resolves.toBe('unset');
    await expect(readFile(targetObservation, 'utf8')).resolves.toBe('provider-secret|unset');
    await prepared.cleanup();
  });
});
