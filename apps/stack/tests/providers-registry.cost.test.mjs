import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sanitizeStackTestRunnerEnv } from '../scripts/utils/test/test_env.mjs';

const execute = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test('provider install planning evaluates CLI facts without Agent session or runtime modules', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stack-provider-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tracePath = join(root, 'trace.json');
  await execute(process.execPath, [
    '--require', fileURLToPath(new URL('../scripts/perf/cli-startup-probe.cjs', import.meta.url)),
    '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const registry = await import('./apps/stack/scripts/providers_registry.mjs');
      const { planAgentCliInstall } = await import('@happier-dev/cli-common/agents');
      const codex = planAgentCliInstall({ agentId: 'codex', platform: 'linux' });
      const claude = planAgentCliInstall({ agentId: 'claude', platform: 'linux' });
      assert.equal(codex.ok, true);
      assert.equal(codex.plan.installMode, 'github_release_binary');
      assert.equal(claude.ok, true);
      assert.ok(claude.plan.commands.some(command => command.args.some(arg => arg.includes('claude.ai/install.sh'))));
      assert.match(registry.resolveStackProviderInstallLabel('claude'), /Claude/);
      assert.throws(() => registry.assertKnownStackProviderIds(['not-an-agent']), { code: 'EUNKNOWN_PROVIDER' });
    `,
  ], {
    cwd: repoRoot,
    env: {
      ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: root, repoDir: repoRoot }),
      CLISTART_IMPORT_TRACE: '1',
      CLISTART_TRACE: tracePath,
    },
  });
  const trace = JSON.parse(await readFile(tracePath, 'utf8'));
  const evaluated = [...new Set(trace.coverage
    .filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0)))
    .map(script => script.url).filter(url => url && !url.startsWith('node:')))];
  const agentLifecycle = evaluated.filter(url => /\/packages\/agents\/(?:src|dist)\/(?:session|runtime)\//u.test(url));
  const protocol = evaluated.filter(url => url.includes('/packages/protocol/'));
  t.diagnostic(JSON.stringify({ evaluatedNonNode: evaluated.length, protocol: protocol.length,
    agentLifecycle: agentLifecycle.length }));
  assert.ok(evaluated.some(url => /\/providers_registry\.mjs$/u.test(url)), 'the production entry executed');
  assert.ok(evaluated.some(url => /\/agents\/(?:src|dist)\/cli\/runtime\.[jt]s$/u.test(url)), 'real CLI facts executed');
  assert.deepEqual(agentLifecycle, [], 'install planning has no Session or Agent runtime consumer');
  assert.equal(protocol.some(url => /\/protocol\/(?:src|dist)\/index\.[jt]s$/u.test(url)), false,
    'install planning consumes narrow Protocol leaves');
});
