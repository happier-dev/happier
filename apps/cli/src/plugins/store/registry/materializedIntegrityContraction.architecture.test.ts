import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const RETIRED_MATERIALIZED_INTEGRITY_TERMS = Object.freeze([
  'PredecessorAlgorithmQualifiedDigestSchema',
  'PredecessorImmutablePluginGenerationRecordSchema',
  'PredecessorPluginRegistryCommitRecordSchema',
  'buildDaemonEntryFingerprint',
  'createManagedServiceIdentityFingerprint',
  'createOpenRequestFingerprint',
  'generationRecordDigest',
  'generationFingerprint',
  'grantDigest',
  'installedUiArtifactDigest',
  'moduleDigest',
  'openRequestFingerprint',
  'packageDigest',
  'predecessorJsonDigest',
  'predecessorSha256',
  'RunnerAgentExecutionGrantV1',
  'agentRuntimeDaemonServiceGrantDigest',
  'runtimeBindingDigest',
  'runtimeDigest',
  'runnerManagedServiceSupervisionGrantIdentity',
  'supervisionGrantIdentity',
  'verifyGenerationRootFiles',
  'verifyPredecessorPersistedGeneration',
]);

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const UNPUBLISHED_RECONCILIATION_SOURCE_PATH =
  'apps/cli/src/plugins/store/registry/unpublishedV1Reconciliation.ts';
const UNPUBLISHED_RECONCILIATION_ENTRYPOINT_PATH =
  'apps/cli/scripts/reconcileUnpublishedPluginRegistryV1.ts';

const PRODUCTION_ROOTS = Object.freeze([
  join(REPOSITORY_ROOT, 'apps/cli/src/plugins'),
  join(REPOSITORY_ROOT, 'apps/cli/src/daemon'),
  join(REPOSITORY_ROOT, 'apps/cli/src/agent/runtime'),
  join(REPOSITORY_ROOT, 'packages/plugins'),
  join(REPOSITORY_ROOT, 'packages/agents/src'),
  join(REPOSITORY_ROOT, 'packages/protocol/src'),
]);
const IGNORED_SOURCE_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'package-dist',
  'coverage',
  '.happier',
  '.happier-plugin',
]);

async function readProductionSources(root: string): Promise<ReadonlyArray<Readonly<{
  relativePath: string;
  source: string;
}>>> {
  const sources: Array<Readonly<{ relativePath: string; source: string }>> = [];

  async function visit(directory: string): Promise<void> {
    await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SOURCE_DIRECTORIES.has(entry.name) || entry.name.startsWith('.tmp.')) return;
        await visit(path);
        return;
      }
      if (
        !entry.isFile()
        || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))
        || entry.name.endsWith('.test.ts')
        || entry.name.endsWith('.test.tsx')
        || entry.name.endsWith('.spec.ts')
        || entry.name.endsWith('.spec.tsx')
      ) return;
      sources.push(Object.freeze({
        relativePath: relative(REPOSITORY_ROOT, path),
        source: await readFile(path, 'utf8'),
      }));
    }));
  }

  await visit(root);
  return sources;
}

let productionSourcesPromise: Promise<ReadonlyArray<Readonly<{
  relativePath: string;
  source: string;
}>>> | undefined;

function readAllProductionSources(): Promise<ReadonlyArray<Readonly<{
  relativePath: string;
  source: string;
}>>> {
  productionSourcesPromise ??= Promise.all(PRODUCTION_ROOTS.map(readProductionSources))
    .then((sources) => sources.flat());
  return productionSourcesPromise;
}

function isShippedRuntimeSource(source: Readonly<{ relativePath: string }>): boolean {
  // This one-time developer reconciliation is not a shipped runtime
  // corridor. Its predecessor terms remain isolated and are checked below.
  return source.relativePath !== UNPUBLISHED_RECONCILIATION_SOURCE_PATH;
}

describe('plugin generation materialized-integrity contraction', () => {
  it('removes retired custom content hashes from production readers', async () => {
    const productionSources = (await readAllProductionSources()).filter(isShippedRuntimeSource);

    for (const { relativePath, source } of productionSources) {
      for (const term of RETIRED_MATERIALIZED_INTEGRITY_TERMS) {
        if (!source.includes(term)) continue;
        expect.fail(`${relativePath} retains ${term}`);
      }
    }
  });

  it('keeps unpublished reconciliation unreachable from shipped runtime corridors', async () => {
    const runtimeReferences = (await readAllProductionSources())
      .filter(isShippedRuntimeSource)
      .filter(({ source }) => source.includes('unpublishedV1Reconciliation'));
    expect(runtimeReferences).toEqual([]);

    const operatorEntrypoint = await readFile(
      join(REPOSITORY_ROOT, UNPUBLISHED_RECONCILIATION_ENTRYPOINT_PATH),
      'utf8',
    );
    expect(operatorEntrypoint).toContain(
      "../src/plugins/store/registry/unpublishedV1Reconciliation",
    );
  });
});
