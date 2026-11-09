import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const probe = join(repoRoot, 'apps/stack/scripts/perf/cli-startup-probe.cjs');

const cases = [
  {
    entry: 'apps/cli/src/plugins/projection/registry/resolveContributionCatalogAgentId.ts',
    consume: `
      assert.equal(owner.normalizeBuiltInAgentId(' codex '), 'codex');
      assert.equal(owner.normalizeBuiltInAgentId('external-agent'), null);
      assert.equal(owner.resolveContributionCatalogAgentId({
        backend: { agentId: 'codex', provenance: 'first_party' },
        agent: { id: 'codex', provenance: 'first_party' },
      }), 'codex');
      assert.equal(owner.resolveContributionCatalogAgentId({
        backend: { agentId: 'codex', provenance: 'external' },
        agent: { id: 'codex', provenance: 'external' },
      }), null);
      assert.equal(owner.resolveContributionCatalogAgentId({
        backend: { agentId: 'external-agent', provenance: 'external',
          richDefinition: { provenance: 'external', definition: { catalogAgentId: 'claude' } } },
        agent: { id: 'external-agent', provenance: 'external' },
      }), 'claude');
    `,
    unrelated: /\/(?:packages\/agents|node_modules\/@happier-dev\/agents)\/(?:src|dist)\/(?:index\.[jt]s$|(?:session|runtime)\/)/u,
  },
  {
    entry: 'apps/cli/src/plugins/authoring/registrationProjections.ts',
    consume: `
      const migrate = record => ({ ...record, status: 'ready' });
      const migrations = [{ id: 'add-status', fromSchemaVersion: 1, toSchemaVersion: 2, migrate }];
      const declarations = [{ id: 'tasks', migrations: [{ id: 'add-status', fromSchemaVersion: 1, toSchemaVersion: 2 }] }];
      const projected = owner.normalizePluginAccountCollectionMigrationRuntimeProjection({ tasks: migrations }, declarations);
      assert.deepEqual(projected.tasks[0].migrate({ title: 'Task' }), { title: 'Task', status: 'ready' });
      assert.throws(() => owner.normalizePluginAccountCollectionMigrationRuntimeProjection({}, declarations), TypeError);
      const up = async () => {};
      const run = async () => {};
      const databases = owner.normalizePluginDaemonDatabaseRuntimeProjection({ tasks: {
        migrations: [{ id: 'create-tasks', version: 1, up }], incumbentQueryFixture: { id: 'tasks-query', run },
      } }, [{ id: 'tasks', migrations: [{ id: 'create-tasks', version: 1 }], incumbentQueryFixtureId: 'tasks-query' }]);
      assert.equal(databases.tasks.migrations[0].up, up);
      assert.equal(databases.tasks.incumbentQueryFixture.run, run);
    `,
    unrelated: /\/(?:packages\/cli-common|node_modules\/@happier-dev\/cli-common)\/(?:src|dist)\/plugins\/registration\/(?:index|scope)\.[jt]s$/u,
  },
] as const;

// Native children keep both entries cold. Positive coverage counts evaluation,
// and the real consumers above prevent a no-op from satisfying the cost contract.
for (const { entry, consume, unrelated } of cases) {
  const directory = mkdtempSync(join(tmpdir(), 'happier-catalog-import-'));
  let observation;
  try {
    const tracePath = join(directory, 'trace.json');
    const result = spawnSync(process.execPath, [
      '--require', probe, '--import', 'tsx', '--conditions=happier-source', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        const owner = await import(${JSON.stringify(join(repoRoot, entry))});
        ${consume}
        console.log('catalog-consumed');
      `,
    ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CLISTART_TRACE: tracePath, CLISTART_IMPORT_TRACE: '1' } });
    // The development probe owns this JSON boundary.
    const trace = result.status === 0 ? JSON.parse(readFileSync(tracePath, 'utf8')) as {
      coverage: { url: string; functions: { ranges: { count: number }[] }[] }[];
    } : { coverage: [] };
    const evaluated = [...new Set(trace.coverage.filter(script => script.url && !script.url.startsWith('node:')
      && script.functions.some(fn => fn.ranges.some(range => range.count > 0))).map(script => script.url))];
    observation = { result, evaluated };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  test(`${entry} consumes catalog facts without unrelated runtime owners`, () => {
    const { result, evaluated } = observation;
    assert.equal(result.status, 0, result.error?.stack ?? result.stderr);
    assert.equal(result.stdout.trim(), 'catalog-consumed');
    assert.ok(evaluated.some(url => url.endsWith(entry)), 'the production consumer evaluated');
    const unrelatedModules = evaluated.filter(url => unrelated.test(url));
    console.log(JSON.stringify({ entry, evaluatedNonNode: evaluated.length, unrelatedModules: unrelatedModules.length }));
    assert.deepEqual(unrelatedModules, [], 'catalog-only consumers have no runtime/registration-scope demand');
  });
}
