import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import test from 'node:test';
import YAML from 'yaml';

import { buildLocalCandidateCommands } from '../pipeline/release/execute-local-candidates.mjs';

const messages = ['', '- First bullet\n- Second bullet', '--option-looking=notes', 'notes "quoted"; $(echo inert)'];

function readMessage(args) {
  const messageArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--release-message' || arg === '--notes') {
      messageArgs.push(arg, args[++index]);
    } else if (arg.startsWith('--release-message=') || arg.startsWith('--notes=')) {
      messageArgs.push(arg);
    }
  }
  return parseArgs({
    args: messageArgs,
    options: { 'release-message': { type: 'string' }, notes: { type: 'string' } },
  }).values;
}

const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);
for (const file of readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'))) {
  const workflow = YAML.parse(readFileSync(new URL(file, workflowDirectory), 'utf8'));
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const fragments = String(step.run ?? '').matchAll(/--(release-message|notes)(?:=|\s+)"(?:\$\{?RELEASE_MESSAGE\}?|\$\{?release_message\}?|\$\{\{\s*inputs\.release_message\s*\}\})"/g);
      for (const [fragment, option] of fragments) {
        test(`${file}/${jobName}/${step.name}: ${option} preserves dash-leading notes through shell and parser`, () => {
          // Isolate the argument expression, without running publication commands.
          // Render the Actions placeholder through env to test argv transport only.
          const expression = fragment.replace(/\$\{\{\s*inputs\.release_message\s*\}\}/g, '$RELEASE_MESSAGE');
          for (const message of messages) {
            const output = execFileSync('bash', ['-e', '-c', `printf '%s\\0' ${expression}`], {
              env: { ...process.env, RELEASE_MESSAGE: message, release_message: message },
            });
            assert.equal(readMessage(output.toString().split('\0').slice(0, -1))[option], message);
          }
        });
      }
    }
  }
}

test('local immutable and rolling commands preserve dash-leading release notes at every publisher', () => {
  for (const message of messages) {
    const commands = buildLocalCandidateCommands({
      channel: 'preview',
      sourceSha: 'a'.repeat(40),
      repository: 'happier-dev/happier',
      candidates: { cli: '1.2.3-preview.1', stack: '1.2.3-preview.1', server: '1.2.3-preview.1', 'ui-web': '1.2.3-preview.1' },
      phase: 'all',
      releaseMessage: message,
    });
    for (const command of commands.filter((entry) => !entry.stage.startsWith('verify:'))) {
      assert.equal(readMessage(command.args)['release-message'], message, command.stage);
    }
  }
});

for (const product of ['cli-binaries', 'hstack-binaries', 'runner-binaries', 'server-runtime', 'ui-web']) {
  const script = new URL(`../pipeline/release/publish-${product}.mjs`, import.meta.url);
  if (!existsSync(script)) continue; // Runner is a 0.3-only publisher.
  test(`pipeline CLI forwards dash-leading notes to publish-${product} without ambiguity`, () => {
    const message = '- First bullet\n-- Second line';
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL('../pipeline/run.mjs', import.meta.url)),
      `publish-${product}`, '--channel', 'preview',
      `--release-message=${message}`, '--dry-run', '--secrets-source', 'env',
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, GH_REPO: 'happier-dev/happier', HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: '{"github":{},"npm":{}}' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const invocation = output.split('\n').find((line) => line.startsWith('[pipeline] exec: node '));
    assert.ok(invocation, output);
    const args = [...invocation.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([value]) => JSON.parse(value));
    assert.equal(readMessage(args)['release-message'], message);
  });
}
