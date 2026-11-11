import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const claude = fileURLToPath(new URL('./prevent-destructive-git.sh', import.meta.url));
const codex = fileURLToPath(new URL('../../.codex/hooks/prevent-destructive-git.mjs', import.meta.url));
const denied = [
  'git update-ref HEAD abc',
  'git update-ref refs/heads/v0.3 abc',
  'git status; cd x && git update-ref HEAD abc',
  'git update-ref HEAD abc old; git update-ref HEAD def',
  'echo $(git update-ref HEAD abc)',
  'echo `git update-ref refs/heads/main abc`',
  'git symbolic-ref HEAD refs/heads/other',
  'git symbolic-ref --quiet HEAD refs/heads/other',
  "printf 'update HEAD abc\\n' | git update-ref --stdin",
  "printf 'update refs/tags/v1 HEAD\\nupdate HEAD abc\\n' | git update-ref --stdin",
  "git update-ref --stdin <<'EOF'\nupdate refs/heads/main abc\nEOF",
  'git -C x update-ref -m "write message" HEAD abc',
  'git update-ref -m "log; message" HEAD abc',
  'git stash list >/dev/null; cd x && git stash',
];
const searchDenied = [
  'rg needle ' + readdirSync(new URL('../../', import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => "'" + entry.name + "'").join(' '),
  'rg --hidden "needle"',
  'grep -R "needle" .',
  'find . -name package.json',
  'du -sh .',
  'cd . && rg "needle"',
  'cd "$(git rev-parse --show-toplevel)" && rg "needle"',
  'printf ok; rg "needle" .',
  'cd apps/cli && rg "needle" ../..',
  'rg "needle" *',
  'find apps . -name package.json',
  'rg -e "needle" -g "*.ts"',
  'rg "needle" > /tmp/search-hook-output',
  'rg "needle"\nrg "needle" apps/cli',
  './apps/stack/bin/hstack-exec --local -- rg "needle" .',
];
const allowed = [
  'git update-ref HEAD abc old',
  'cd x && git update-ref refs/heads/main abc old',
  'echo $(git update-ref HEAD abc old)',
  'git update-ref -m "write message" HEAD abc old',
  'git update-ref -m "log; message" HEAD abc old',
  'git update-ref refs/tags/v1 abc',
  'git symbolic-ref HEAD',
  'git symbolic-ref --quiet HEAD',
  "printf 'update refs/tags/v1 abc\\n' | git update-ref --stdin",
  "git rev-parse HEAD; printf 'update refs/tags/v1 abc\\n' | git update-ref --stdin",
  "printf 'update refs/tags/v1 HEAD\\n' | git update-ref --stdin",
  'git stash list; git stash show',
];
const searchAllowed = [
  'rg "needle" apps/cli',
  'grep "needle" README.md',
  'grep -R "needle" packages/protocol',
  'find apps/ui/sources -name "*.tsx"',
  'du -sh apps/cli',
  './apps/stack/bin/hstack-exec -- rg "needle" .',
  'cd . && ./apps/stack/bin/hstack-exec -- rg "needle" .',
  'git grep -n "needle"',
  'echo "rg needle ."',
  'cd apps/cli && rg "needle" .',
  'rg -e "needle" apps/cli',
  'rg "needle" apps/cli > /tmp/search-hook-output',
  'cat README.md',
];

for (const ingress of ['claude', 'codex']) {
  for (const [blocked, commands] of [[true, denied], [false, allowed]]) {
    test(`${ingress}: ${blocked ? 'refuses unsafe writes' : 'preserves legitimate inspection and CAS writes'}`, () => {
      for (const command of commands) {
        const payload = { tool_name: 'Bash', tool_input: { command } };
        const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [ingress === 'claude' ? claude : codex], {
          input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
        });
        assert.ifError(result.error);
        assert.equal(result.status, blocked ? (ingress === 'claude' ? 1 : 2) : 0, command);
      }
    });
  }
}

for (const ingress of ['claude', 'codex']) {
  test(`${ingress}: refuses controller-wide searches and allows narrow or routed searches`, () => {
    for (const command of searchDenied) {
      const payload = { tool_name: 'Bash', tool_input: { command } };
      const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [ingress === 'claude' ? claude : codex], {
        input: JSON.stringify(payload), encoding: 'utf8', cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, ingress === 'claude' ? 1 : 2, command);
      assert.match(`${result.stdout}\n${result.stderr}`, /hstack-exec -- rg <pattern> <narrow path>/, command);
    }
    for (const command of searchAllowed) {
      const payload = { tool_name: 'Bash', tool_input: { command } };
      const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [ingress === 'claude' ? claude : codex], {
        input: JSON.stringify(payload), encoding: 'utf8', cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, command);
    }
  });
}

test('legacy Claude envelope still enforces the same guard', () => {
  const result = spawnSync('bash', [claude], {
    input: JSON.stringify({ tool: 'Bash', args: { command: 'git update-ref HEAD abc' } }), encoding: 'utf8',
    env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '' },
  });
  assert.equal(result.status, 1);
});

// Historical commands are inert stdin fixtures; never execute them.
const historicalStaleCommands = [
  "for p in packages/plugins/pi/src/agent/runtime/qualifiedConnectedAccounts.ts packages/plugins/opencode/src/agent/auth/services/qualifiedPurposeLaunch.ts packages/plugins/codebuddy/src/agent/runtime/connectedAccounts.ts packages/plugins/codebuddy/src/agent/runtime/factory.ts; do tmp=\"$p.__stagecopy\"; git show :\"$p\" > \"$tmp\" && mv \"$tmp\" \"$p\"; done; git status --short -- packages/plugins/pi/src/agent/runtime/qualifiedConnectedAccounts.ts packages/plugins/opencode/src/agent/auth/services/qualifiedPurposeLaunch.ts packages/plugins/codebuddy/src/agent/runtime/connectedAccounts.ts packages/plugins/codebuddy/src/agent/runtime/factory.ts",
  "python3 - <<'PY'\nimport subprocess, pathlib, difflib, os\nchanges={\n'packages/plugins/machine-freestyle/src/machine/nativeClient.ts': lambda s:s.replace(\"command, linuxUser: 'root', stdin: inputBase64, timeoutMs: timeoutMs ?? 300000,\", \"command, linuxUser: 'root', stdin: inputBase64, ...(timeoutMs == null ? {} : { timeoutMs }),\"),\n'packages/plugins/machine-freestyle/src/machine/nativeClient.test.ts': lambda s:s.replace(\"  it('keeps paused memory/disk and truthful plan deletion rules; start/delete use the same identity', async () => {\", \"  it('lets Freestyle apply its documented exec timeout when none is supplied', async () => {\\n    const v = vendor();\\n    try {\\n      const c = createFreestyleNativeClient(v.request), a = await c.acquire(launch, 'managed');\\n      if (a.kind !== 'bound') throw new Error('Missing resource');\\n      await c.exec({ resource: a.resource.value, argv: ['true'] });\\n      expect(v.calls.find(call => call.path.endsWith('/exec-await'))?.body).not.toHaveProperty('timeoutMs');\\n    } finally { v.cleanup(); }\\n  });\\n  it('keeps paused memory/disk and truthful plan deletion rules; start/delete use the same identity', async () => {\"),\n'packages/plugins/machine-vercel/src/manifest.ts': lambda s:s.replace(\"{ path: 'vcpus', title: label('vcpus'), widget: 'integer', required: true, defaultValue: 2 },\", \"{ path: 'vcpus', title: label('vcpus'), widget: 'integer', required: true },\"),\n'packages/plugins/machine-vercel/src/manifest.test.ts': lambda s:s.replace(\"  it.each([['hobby', 2_700_000], ['pro', 86_400_000], ['enterprise', 86_400_000]] as const)(\\n    'defaults the fresh %s form to its native plan maximum, retaining a shorter explicit duration', async (plan, maximum) => {\", \"  it.each([['hobby', 2_700_000], ['pro', 86_400_000], ['enterprise', 86_400_000]] as const)(\\n    'requires an explicit vCPU while retaining the native plan duration maximum for %s', async (plan, maximum) => {\").replace(\"        // Same declared-field seeding as the host launch form, not a hand-built default.\\n        const fresh = seedInputByFieldHints(PluginActionContributionV2Schema.parse(action), {});\\n        for (const [input, duration] of [[fresh, maximum], [{ ...fresh, timeoutMs: 60_000 }, 60_000]] as const) {\", \"        // vCPU has no provider-owned default; duration still follows the plan maximum.\\n        const fresh = seedInputByFieldHints(PluginActionContributionV2Schema.parse(action), {});\\n        expect(fresh).not.toHaveProperty('vcpus');\\n        const explicit = { ...fresh, vcpus: 2 };\\n        for (const [input, duration] of [[explicit, maximum], [{ ...explicit, timeoutMs: 60_000 }, 60_000]] as const {\").replace(\"      } finally { await kit.dispose(); }\\n    });\\n  it.each([{ project: 404 }\", \"      } finally { await kit.dispose(); }\\n    });\\n  it.each([{ project: 404 }\").replace(\"  it('invokes the activated check and options through host HTTP without waking or guest IO', async () => {\", \"  it('does not invent a Vercel vCPU default in the authoring hints', () => {\\n    const manifest = parsePluginManifest(PLUGIN_MANIFEST);\\n    if (!manifest.ok) throw new Error('Expected admitted manifest');\\n    const action = manifest.manifest.contributes.actions.find(action => action.id === 'options');\\n    if (!action) throw new Error('Expected options action');\\n    const vcpus = action.inputHints?.fields.find(field => field.path === 'vcpus');\\n    expect(vcpus).toBeDefined();\\n    expect(vcpus).not.toHaveProperty('defaultValue');\\n  });\\n  it('invokes the activated check and options through host HTTP without waking or guest IO', async () => {\"),\n'packages/plugins/machine-agent37/src/machine/schemas.ts': lambda s:s.replace(\"const text = defineProtocolString({ minLength: 1, pattern: '\\\\\\\\S' });\\n\", \"const text = defineProtocolString({ minLength: 1, pattern: '\\\\\\\\S' });\\n// Agent37 exposes no size catalog endpoint; these documented instance-sizing values are the provider-owned fallback.\\n\"),\n'packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts': lambda s:s.replace(\"  serverRequired(RPC_METHODS.DAEMON_AGENTS_INSTALL_START, 'auth',\\n    'Manage starts an Agent install, update or uninstall job under its exact reviewed public Action.', 'manage') satisfies MachineRpcRoutePolicyV1,\\n\", \"  serverRequired(RPC_METHODS.DAEMON_AGENTS_INSTALL_START, 'auth',\\n    'Manage starts an Agent install, update or uninstall job under its exact reviewed public Action.', 'manage') satisfies MachineRpcRoutePolicyV1,\\n  serverRequired(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, 'auth',\\n    'Manage cancels an Agent install, update or uninstall job under its exact reviewed public Action.', 'manage') satisfies MachineRpcRoutePolicyV1,\\n\").replace(\"    RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,\\n    RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST,\", \"    RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,\\n    RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST,\"),\n'packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.test.ts': lambda s:s.replace(\"    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_AGENTS_INSTALL_START))\\n      .toMatchObject({ sharedMachineAccess: 'manage', rpcClassification: 'internal_only' });\\n\", \"    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_AGENTS_INSTALL_START))\\n      .toMatchObject({ sharedMachineAccess: 'manage', rpcClassification: 'internal_only' });\\n    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL))\\n      .toMatchObject({ sharedMachineAccess: 'manage', rpcClassification: 'internal_only' });\\n\"),\n'packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.sharedAccess.test.ts': lambda s:s.replace(\"  ['daemon.agents.install.start', 'manage'],\\n\", \"  ['daemon.agents.install.start', 'manage'],\\n  ['daemon.agents.install.cancel', 'manage'],\\n\"),\n}\npatch=[]\nfor path,fn in changes.items():\n    base=subprocess.check_output(['git','show','f2faeba8bc0af94114a3f2eac624156da1f645ce:'+path],text=True)\n    new=fn(base)\n    if new==base: raise SystemExit('no change '+path)\n    patch.extend(difflib.unified_diff(base.splitlines(True),new.splitlines(True),fromfile='a/'+path,tofile='b/'+path,n=3))\npathlib.Path('/tmp/omach-f24-f25-final.patch').write_text(''.join(patch))\nidx='/tmp/omach-f24-f25-final-index'; pathlib.Path(idx).unlink(missing_ok=True)\nenv={**os.environ,'GIT_INDEX_FILE':idx}\nsubprocess.run(['git','read-tree','--reset','f2faeba8bc0af94114a3f2eac624156da1f645ce'],env=env,check=True)\nsubprocess.run(['git','apply','--cached','/tmp/omach-f24-f25-final.patch'],env=env,check=True)\ntree=subprocess.check_output(['git','write-tree'],env=env,text=True).strip()\nprint('desired tree',tree)\nprint(subprocess.check_output(['git','diff','--stat','f2faeba8bc0af94114a3f2eac624156da1f645ce',tree],text=True))\nparent=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()\ncommit=subprocess.check_output(['git','commit-tree',tree,'-p',parent],env={**os.environ},input='fix: align Vercel default tests with explicit sizing\\n\\nThe provider-owned vCPU default removal makes fresh drafts incomplete until a user supplies a size; keep the plan-duration coverage explicit.\\n',text=True).strip()\nif subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()!=parent: raise SystemExit('CAS conflict')\nsubprocess.run(['git','update-ref','refs/heads/'+subprocess.check_output(['git','branch','--show-current'],text=True).strip(),commit,parent],check=True)\nprint('commit',commit)\nPY"
];

const staleDenied = [
  ...historicalStaleCommands,
  'git show HEAD:apps/cli/source.ts > apps/cli/source.ts',
  'git show :apps/cli/source.ts >> apps/cli/source.ts',
  'git show HEAD~1:apps/cli/source.ts | tee apps/cli/source.ts',
  'git show HEAD:apps/cli/source.ts > /tmp/stale-source; cp /tmp/stale-source apps/cli/source.ts',
  'git show HEAD:apps/cli/source.ts > /tmp/stale-source && mv /tmp/stale-source apps/cli/source.ts',
  'git cat-file -p HEAD:apps/cli/source.ts > apps/cli/source.ts',
  'git archive HEAD | tar -x',
  'git archive HEAD | tar -x -C apps/cli',
  'git checkout-index -a',
  'git checkout-index --prefix=apps/cli/ -a',
  'git checkout-index --prefix=/tmp/isolated-tree/ -a; git checkout apps/cli/source.ts',
  'git show HEAD:source.ts > /tmp/stale-source; cp /tmp/stale-source .project/tmp/lane/copy; cp .project/tmp/lane/copy apps/cli/source.ts',
  'git -C /tmp/isolated-tree show HEAD:source.ts > apps/cli/source.ts',
  'git -C apps/cli show HEAD:source.ts > apps/cli/source.ts',
];
const staleAllowed = [
  'git show HEAD:apps/cli/source.ts',
  'git show :apps/cli/source.ts | less',
  'git show HEAD:apps/cli/source.ts > /tmp/stale-source',
  'git show HEAD:apps/cli/source.ts > "$TMPDIR/stale-source"',
  'git show HEAD:apps/cli/source.ts > .project/tmp/STALE-WRITE-HOOK-1111/source.ts',
  'git show HEAD:apps/cli/source.ts | tee /tmp/stale-source',
  'git checkout-index --prefix=/tmp/isolated-tree/ -a',
  'git archive HEAD | tar -x -C /tmp/isolated-tree',
  'git archive HEAD > /tmp/source.tar',
  'git worktree add /tmp/isolated-tree HEAD; cd /tmp/isolated-tree && git show HEAD:source.ts > source.ts',
  'cd /tmp/isolated-tree && git checkout-index -a',
  'git -C /tmp/isolated-tree checkout-index -a',
  'git -C /tmp/isolated-tree show HEAD:source.ts > /tmp/source.ts',
  'git show HEAD:apps/cli/source.ts >/dev/null',
  'echo "git show HEAD:source.ts > apps/cli/source.ts"',
  'git status; cp /tmp/current-source apps/cli/source.ts',
  'git cat-file -p HEAD:apps/cli/source.ts',
  'git show HEAD:apps/cli/source.ts > /tmp/stale-source; cp /tmp/other-source apps/cli/source.ts',
];
for (const ingress of ['claude', 'codex']) {
  for (const [blocked, commands] of [[true, staleDenied], [false, staleAllowed]]) {
    test(`${ingress}: ${blocked ? 'refuses historical and literal stale writes' : 'allows inspection and isolated stale-byte experiments'}`, () => {
      for (const [index, command] of commands.entries()) {
        const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath, [ingress === 'claude' ? claude : codex], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: { ...process.env, ALLOW_DESTRUCTIVE_GIT: '', TMPDIR: '/tmp' },
        });
        assert.ifError(result.error);
        assert.equal(result.status, blocked ? (ingress === 'claude' ? 1 : 2) : 0, `stale case ${index}`);
        if (blocked) assert.match(`${result.stdout}\n${result.stderr}`, /OS-temp copy|git worktree add/);
      }
    });
  }
}
