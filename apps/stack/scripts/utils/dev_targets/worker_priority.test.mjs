import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';

const custody = new URL('./remote_execution_custody.sh', import.meta.url).pathname;

test('remote worker launch scopes ordinary jobs and controlled QA browsers without capacity admission',
  { skip: process.platform !== 'linux' }, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-worker-priority-' });
    // systemd, procfs and scheduler tools are OS boundaries; custody and its
    // shared priority owner run unchanged, including their process lifecycle.
    const binaries = {
      sed: '#!/bin/sh\ncase "$*" in *"/proc/self/cgroup") printf "/user.slice/unscoped\\n" ;; *) exec /usr/bin/sed "$@" ;; esac\n',
      ps: '#!/bin/sh\ncase "$*" in "-o ni= -p "*) printf "0\\n" ;; *) exec /usr/bin/ps "$@" ;; esac\n',
      systemctl: '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *LoadState*) printf "loaded\\n" ;; *) exit 1 ;; esac\n',
      'systemd-run': `#!/bin/sh
printf '%s\\n' "$@" > "$SCOPE_SPEC"
while [ "$#" -gt 0 ]; do
  if [ "$1" = -- ]; then shift; break; fi
  shift
done
export WORKER_SCOPE=happier-jobs.slice
exec "$@"
`,
    };
    for (const [name, content] of Object.entries(binaries)) writeFakeBin({ root, name, content });
    for (const mode of ['ordinary', 'lifeline', 'browser']) {
      const spec = join(root, `${mode}.scope`);
      const child = spawn('/bin/bash', [custody, 'run', join(root, `${mode}.pid`), mode,
        '/bin/sh', '-c', 'printf "%s\\n" "${WORKER_SCOPE-unscoped}"; exit 7'], {
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          TMPDIR: root, SCOPE_SPEC: spec,
          HAPPIER_REMOTE_EXEC_LIFELINE: mode === 'ordinary' ? '0' : '1',
          HAPPIER_REMOTE_EXEC_CONTROL_STDIN: mode === 'browser' ? '1' : '0',
          HAPPIER_STACK_PROCESS_KIND: mode === 'browser' ? 'browser' : 'session' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const [code] = await once(child, 'exit');
      child.stdin.destroy();
      assert.equal(code, 7, stderr);
      assert.equal(stdout.trim(), 'happier-jobs.slice', `${mode} bypassed worker scheduling`);
      const args = (await readFile(spec, 'utf8')).trim().split('\n');
      for (const option of ['--user', '--scope', '--slice=happier-jobs.slice', '--nice=10']) {
        assert.ok(args.includes(option), `${mode} is missing ${option}`);
      }
      assert.ok(!args.some(arg => /CPUQuota|--heavyweight-admission/.test(arg)));
    }
  });
