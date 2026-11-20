#!/usr/bin/env node
// Read-only lane inspection: report the working-tree state of the
// Session-Agent authoring canary corridor without mutating anything.
import { execFileSync } from 'node:child_process';

import { gitProcessArgs } from './utils/proc/proc.mjs';

const repoRoot = new URL('../../..', `file://${process.cwd()}/`).pathname;

const paths = [
  'packages/plugin-sdk/examples/session-agent',
  'packages/plugin-sdk/src',
  'apps/cli/src/cli/commands/plugins.sessionAgentCanary.real.integration.test.ts',
  'apps/docs/content/docs/plugins/agent-runtimes/execution-runs.mdx',
];

function git(args) {
  return execFileSync('git', gitProcessArgs(['-C', repoRoot, ...args]), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

const head = git(['rev-parse', '--short', 'HEAD']).trim();
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
console.log(`HEAD ${head} (${branch})`);

console.log('\n== git status --porcelain (corridor) ==');
console.log(git(['status', '--porcelain', '--', ...paths]) || '(clean)');

console.log('\n== git diff HEAD --stat (corridor) ==');
console.log(git(['diff', 'HEAD', '--stat', '--', ...paths]) || '(no unstaged diff)');

console.log('\n== git diff --stat (unstaged only, corridor) ==');
console.log(git(['diff', '--stat', '--', ...paths]) || '(none)');

console.log('\n== last commit touching the example test ==');
console.log(git(['log', '-n', '1', '--oneline', '--', 'packages/plugin-sdk/examples/session-agent/test/index.test.mjs']));
