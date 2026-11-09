import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const probe = fileURLToPath(new URL('../../../apps/stack/scripts/perf/cli-startup-probe.cjs', import.meta.url));

// Native children keep both entry orders cold. Positive V8 coverage distinguishes
// evaluated modules from modules merely resolved or parsed by the loader.
for (const entry of ['@happier-dev/protocol/tools/happierToolAutoApprovalV1', '@happier-dev/agents/acpPresets']) {
  const directory = mkdtempSync(join(tmpdir(), 'happier-auto-approval-import-'));
  let observation;
  try {
    const trace = join(directory, 'trace.json');
    const result = spawnSync(process.execPath, [
      '--require', probe, '--import', 'tsx', '--conditions=happier-source', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const loaded = await import(${JSON.stringify(entry)});
      const names = loaded.listHappierToolAutoApprovedNamesV1?.()
        ?? loaded.ACP_HAPPIER_MCP_BRIDGE_STATIC_APPROVAL_TOOL_NAMES;
      assert.ok(names.includes('action_execute'));
      assert.ok(names.includes('session_title_set'));
      assert.ok(names.includes('change_title'));
      assert.ok(!names.includes('daemon_filesystem_delete'));
      if (loaded.resolveAcpToolPermissionPolicy) {
        const policy = loaded.resolveAcpToolPermissionPolicy('plan');
        assert.equal(policy.happier_action_execute, 'allow');
        assert.equal(policy.happier_session_title_set, 'allow');
      }
      console.log('safe-tools-consumed');
    `], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CLISTART_TRACE: trace, CLISTART_IMPORT_TRACE: '1' } });
    const coverage = result.status === 0 ? JSON.parse(readFileSync(trace, 'utf8')).coverage : [];
    const evaluated = [...new Set(coverage.filter(script => script.url && !script.url.startsWith('node:')
      && script.functions.some(fn => fn.ranges.some(range => range.count > 0))).map(script => script.url))];
    const catalog = evaluated.filter(url => /\/actions\/(?:actionSpecs\.|specs\/|[^/]*Action(?:Family|Specs)\.)/u.test(url));
    observation = { result, evaluated, catalog };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  test(`${entry} consumes safe tools without evaluating Action specifications`, () => {
    const { result, evaluated, catalog } = observation;
    assert.equal(result.status, 0, result.error?.stack ?? result.stderr);
    assert.equal(result.stdout.trim(), 'safe-tools-consumed');
    assert.ok(evaluated.some(url => /\/tools\/happierToolAutoApprovalV1\.(?:ts|js)$/u.test(url)), 'the real approval owner must evaluate');
    console.log(JSON.stringify({ entry, evaluatedNonNode: evaluated.length, actionSpecModules: catalog.length }));
    assert.equal(catalog.length, 0, `Action catalog evaluated: ${catalog.join(', ')}`);
  });
}
