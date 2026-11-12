import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregatePluginPublications, selectPluginPublications, recordPluginPublication } from './plugin-publication.mjs';

const plugins = [
  { id: 'first', packageName: '@happier-dev/plugins-first' },
  { id: 'second', packageName: '@happier-dev/plugins-second' },
];
test('workflow CLI selects candidate plugins and aggregates per-plugin files through explicit GitHub outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-publication-cli-'));
  const cli = fileURLToPath(new URL('./plugin-publication.mjs', import.meta.url));
  const invoke = (args) => {
    const result = spawnSync(process.execPath, [cli, '--repo-root', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    for (const id of ['first', 'second']) {
      mkdirSync(join(root, 'packages/plugins', id), { recursive: true });
      writeFileSync(join(root, 'packages/plugins', id, 'package.json'), JSON.stringify({ name: `@example/${id}`, happier: { bundled: false } }));
    }
    const output = join(root, 'github-output');
    invoke(['--select-input', '["first","second"]', '--versions', '{"first":"0.3.1","unselected":"0.3.8"}', '--github-output', output]);
    invoke(['--record-status', join(root, 'status/first.json'), '--plugin', 'first', '--result', 'success', '--version', '0.3.0-preview.1', '--integrity', 'sha512-first']);
    invoke(['--aggregate', join(root, 'status'), '--plugins', '["first","second"]', '--github-output', output]);
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
    assert.equal(outputs.publish_plugins, '["first","second"]');
    assert.deepEqual(JSON.parse(outputs.plugin_versions), { first: '0.3.1' });
    const records = JSON.parse(outputs.plugins_json);
    assert.deepEqual(records.map(({ id, result }) => ({ id, result })), [{ id: 'first', result: 'success' }, { id: 'second', result: 'failed' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('publication records require a successful publisher with its verified npm identity', () => {
  assert.deepEqual(recordPluginPublication(plugins, 'first', 'success', '0.3.0-preview.1', 'sha512-first'), { ...plugins[0], result: 'success', version: '0.3.0-preview.1', integrity: 'sha512-first' });
  assert.equal(recordPluginPublication(plugins, 'first', 'failure', '', '').result, 'failed');
  assert.equal(recordPluginPublication(plugins, 'first', 'success', '', '').result, 'failed');
});
test('target selection and matrix aggregation retain every independently published plugin', () => {
  assert.deepEqual(selectPluginPublications(plugins, ['plugin:second', 'plugin:first', 'sdk']), ['first', 'second']);
  assert.throws(() => selectPluginPublications(plugins, ['plugin:missing']), /Unknown publishable plugin/u);
  const first = { ...plugins[0], result: 'success', version: '0.3.0-preview.1', integrity: 'sha512-first' };
  const second = { ...plugins[1], result: 'failed', version: '', integrity: '' };
  assert.deepEqual(aggregatePluginPublications(plugins, ['first', 'second'], [second, first]), [first, second]);
  assert.deepEqual(aggregatePluginPublications(plugins, ['first', 'second'], [first]), [first, second]);
});
