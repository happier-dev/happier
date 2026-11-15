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

// P03-ADMISSION-PRIORITY 2026-11-15: an admission client reports its payload's
// kernel peak only from its own per-dispatch scope. Local clients started from a
// shared jobs-slice scope (agent tmux sessions) never did, so every local
// compilation kept the 38 GiB class floor. Only a dispatch scope is reentrant.
test('local admission clients get their own dispatch scope; dispatch scopes and payload reentry keep theirs',
  { skip: process.platform !== 'linux' }, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-admission-scope-' });
    const slice = `/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/happier.slice/happier-jobs.slice`;
    // systemd, procfs and scheduler tools are OS boundaries; the placement owner runs unchanged.
    const binaries = {
      sed: '#!/bin/sh\ncase "$*" in *"/proc/self/cgroup") printf "%s\\n" "$FAKE_CGROUP" ;; *) exec /usr/bin/sed "$@" ;; esac\n',
      ps: '#!/bin/sh\ncase "$*" in "-o ni= -p "*) printf "10\\n" ;; *) exec /usr/bin/ps "$@" ;; esac\n',
      systemctl: '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *LoadState*) printf "loaded\\n" ;; *) exit 1 ;; esac\n',
      'systemd-run': '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SCOPE_LOG"\nwhile [ "$#" -gt 0 ]; do [ "$1" = -- ] && { shift; break; }; shift; done\nexec "$@"\n',
    };
    for (const [name, content] of Object.entries(binaries)) writeFakeBin({ root, name, content });
    const proc = new URL('../proc/', import.meta.url).pathname;
    const cases = [
      ['admission client from an agent tmux scope', 'exec_in_jobs_scope', `${slice}/tmux-spawn-1.scope`, 1],
      ['admission client already in its dispatch scope', 'exec_in_jobs_scope', `${slice}/happier-jobs-10-1.scope`, 0],
      ['admitted payload reentry under its client', 'exec_in_jobs_slice', `${slice}/tmux-spawn-1.scope`, 0],
    ];
    for (const [name, placement, cgroup, scopes] of cases) {
      const log = join(root, `${placement}-${scopes}.log`);
      const child = spawn('/bin/bash', ['-c', `. "${proc}native_process_identity.sh"; . "${proc}native_process_priority.sh"; ${placement} /bin/sh -c 'exit 7'`], {
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_CGROUP: cgroup, SCOPE_LOG: log },
        stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const [code] = await once(child, 'exit');
      assert.equal(code, 7, `${name}: ${stderr}`);
      const units = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
      assert.equal(units.length, scopes, `${name}: ${units.join(' | ')}`);
      for (const unit of units) assert.match(unit, /--unit=happier-jobs-\d+-\S+\.scope .*--scope .*--slice=happier-jobs\.slice/u);
    }
  });
