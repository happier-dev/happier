import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseScriptFlags } from './workflow-script-flags.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('every release workflow script flag reaches its actual CLI parser', () => {
  const result = validateReleaseScriptFlags(repoRoot);
  assert.deepEqual(result.failures, []);
  assert.ok(result.calls.length > 0);
});

test('workflow parser contract rejects ignored map flags and flags owned by another subcommand', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-script-flags-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(file, source) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  write('.github/workflows/release.yml', 'jobs:\n  child:\n    uses: ./.github/workflows/child.yml\n');
  write('.github/workflows/child.yml', `jobs:
  check:
    steps:
      - uses: actions/checkout@v4
        with:
          path: .release-control
      - working-directory: source
        run: |
          args=(--base main)
          args+=(--head HEAD)
          node ../scripts/changed.mjs "\${args[@]}"
          node "$GITHUB_WORKSPACE/.release-control/scripts/pipeline/run.mjs" alpha \\
            --alpha true
          node "$GITHUB_WORKSPACE/scripts/publish.mjs" --channel "$(node -p "require('./package.json').version")"
`);
  write('scripts/map.mjs', `export function parseMap(argv) { const map = new Map(); for (const a of argv) map.set(a, true); return map; }`);
  write('scripts/changed.mjs', `import { parseMap as readMap } from './map.mjs';
const args = readMap(process.argv.slice(2)); args.get('--base'); args.get('--head');`);
  write('scripts/pipeline/run.mjs', `import { parseArgs } from 'node:util';
const [subcommand, ...rest] = process.argv.slice(2);
if (subcommand === 'alpha') { parseArgs({args: rest, options: {alpha: {type: 'string'}}}); }
if (subcommand === 'beta') { parseArgs({args: rest, options: {beta: {type: 'string'}}}); }
function unrelatedParser() { parseArgs({options: {beta: {type: 'string'}}}); }
throw new Error('CLI modules must never execute during contract inspection');`);
  write('scripts/publish.mjs', `import { publish } from './shared.mjs'; publish();`);
  write('scripts/shared.mjs', `import { parseArgs as readArguments } from 'node:util';
export function publish() { const options = {channel: {type: 'string'}}; readArguments({options, args: process.argv.slice(2)}); }
function unrelatedParser() { readArguments({options: {unrelated: {type: 'string'}}}); }
const unrelatedArrow = () => readArguments({options: {unrelated: {type: 'string'}}});
throw new Error('Publisher must never execute during contract inspection');`);
  assert.deepEqual(validateReleaseScriptFlags(root).failures, []);
  const workflow = path.join(root, '.github/workflows/child.yml');
  fs.writeFileSync(workflow, fs.readFileSync(workflow, 'utf8')
    .replace('--base main', '--bases main').replace('--alpha true', '--beta true')
    .replace('--channel ', '--unrelated ')
    + '          node "$GITHUB_WORKSPACE/scripts/pipeline/run.mjs" missing\n');
  const failures = validateReleaseScriptFlags(root).failures;
  assert.equal(failures.length, 4);
  assert.match(failures[0], /changed\.mjs does not consume --bases/);
  assert.match(failures[1], /run\.mjs alpha does not consume --beta/);
  assert.match(failures[2], /publish\.mjs does not consume --unrelated/);
  assert.match(failures[3], /run\.mjs: unknown subcommand missing/);
  write('scripts/changed.mjs', `unknownParser(process.argv.slice(2));`);
  assert.match(validateReleaseScriptFlags(root).failures[0], /changed\.mjs: unrecognized CLI parser/);
});
