import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const patchEntry = workspace.split('\n').find((line) => /^  .*patches\//.test(line));
assert.ok(patchEntry);
const scratch = join(dirname(root), 'patch-edit-scratch');
const patch = 'patches/example.patch';
const events = [
  { tool_name: 'Write', tool_input: { file_path: patch, content: 'changed' } },
  { tool_name: 'Edit', tool_input: { file_path: patch, old_string: 'old', new_string: 'new' } },
  { tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Add File: ${patch}\n+changed\n*** End Patch` },
  { tool_name: 'apply_patch', tool_input: { patch: `*** Begin Patch\n*** Update File: source.txt\n*** Move to: ${patch}\n@@\n-old\n+new\n*** End Patch` } },
  { tool_name: 'Bash', tool_input: { command: `printf changed > '${join(root, patch)}'` } },
  { tool_name: 'Bash', tool_input: { command: `cd '${root}'; printf changed >> ${patch}` } },
  { tool_name: 'Bash', tool_input: { command: `apply_patch <<'PATCH'\n*** Begin Patch\n*** Delete File: ${patch}\n*** End Patch\nPATCH` } },
  { tool_name: 'Edit', tool_input: { file_path: 'pnpm-workspace.yaml', old_string: patchEntry, new_string: `${patchEntry}.changed` } },
  { tool_name: 'Write', tool_input: { file_path: 'pnpm-workspace.yaml', content: workspace.replace(patchEntry, `${patchEntry}.changed`) } },
  { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: pnpm-workspace.yaml\n@@\n-${patchEntry}\n+${patchEntry}.changed\n*** End Patch` } },
  { tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Update File: pnpm-workspace.yaml\n@@ patchedDependencies:\n+  example: patches/example.patch\n*** End Patch` },
  { tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Update File: pnpm-workspace.yaml\n*** Move to: old-workspace.yaml\n*** End Patch` },
  { tool_name: 'Bash', tool_input: { command: 'printf changed > pnpm-workspace.yaml' } },
];

for (const ingress of ['claude', 'codex']) {
  function run(event, marker = '') {
    const config = JSON.parse(readFileSync(join(root, ingress === 'claude' ? '.claude/settings.json' : '.codex/hooks.json'), 'utf8'));
    const wired = config.hooks.PreToolUse.some((entry) =>
      (entry.matcher === '*' || new RegExp(entry.matcher).test(event.tool_name)) &&
      entry.hooks.some((hook) => hook.command.includes('prevent-destructive-git')));
    if (!wired) return { status: 0, stderr: '', stdout: '' };
    const result = spawnSync(ingress === 'claude' ? 'bash' : process.execPath,
      [join(root, ingress === 'claude' ? '.claude/hooks/prevent-destructive-git.sh' : '.codex/hooks/prevent-destructive-git.mjs')], {
        input: JSON.stringify({ cwd: root, ...event }), encoding: 'utf8', cwd: root,
        env: { ...process.env, HAPPIER_DEPENDENCY_APPLIER: marker, ALLOW_DESTRUCTIVE_GIT: '' },
      });
    assert.ifError(result.error);
    return result;
  }

  test(`${ingress}: refuses primary patch and patch-registration edits through configured hooks`, () => {
    for (const event of events) {
      const result = run(event);
      assert.equal(result.status, ingress === 'claude' ? 1 : 2, event.tool_name);
      assert.match(result.stderr + result.stdout, /outside worktree.*Systemic/);
    }
  });

  test(`${ingress}: explicit applier remains allowed through the same configured hooks`, () => {
    for (const event of events) assert.equal(run(event, '1').status, 0, event.tool_name);
    assert.notEqual(run(events[0], '0').status, 0);
    assert.notEqual(run({ tool_name: 'Bash', tool_input: { command: 'git update-ref HEAD abc' } }, '1').status, 0);
  });

  test(`${ingress}: preserves scratch edits, inspection and unrelated workspace wiring`, () => {
    const allowed = [
      { tool_name: 'Write', cwd: scratch, tool_input: { file_path: patch, content: 'changed' } },
      { tool_name: 'Edit', tool_input: { file_path: join(scratch, patch), old_string: 'old', new_string: 'new' } },
      { tool_name: 'apply_patch', cwd: scratch, tool_input: `*** Begin Patch\n*** Delete File: ${patch}\n*** End Patch` },
      { tool_name: 'Bash', cwd: scratch, tool_input: { command: `printf changed > ${patch}` } },
      { tool_name: 'Bash', tool_input: { command: `cd '${scratch}' && printf changed > ${patch}` } },
      { tool_name: 'Bash', tool_input: { command: 'cat patches/example.patch' } },
      { tool_name: 'Write', tool_input: { file_path: 'docs/patches/example.md', content: 'text' } },
      { tool_name: 'Write', tool_input: { file_path: 'pnpm-workspace.yaml', content: workspace.replace('  - apps/ui', '  - apps/ui\n  - apps/example') } },
      { tool_name: 'Edit', tool_input: { file_path: 'pnpm-workspace.yaml', old_string: '  - apps/ui', new_string: '  - apps/example' } },
      { tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Update File: pnpm-workspace.yaml\n@@\n-  - apps/ui\n+  - apps/example\n*** End Patch` },
    ];
    for (const event of allowed) assert.equal(run(event).status, 0, JSON.stringify(event));
  });
}
