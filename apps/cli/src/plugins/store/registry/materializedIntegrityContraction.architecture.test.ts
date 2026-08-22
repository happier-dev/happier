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
  'launchIdentityFingerprint',
  'openRequestFingerprint',
  'packageDigest',
  'predecessorJsonDigest',
  'predecessorSha256',
  'RunnerAgentExecutionGrantV1',
  'runtimeBindingDigest',
  'runtimeDigest',
  'supervisionGrantIdentity',
  'verifyGenerationRootFiles',
  'verifyPredecessorPersistedGeneration',
]);

const PRODUCTION_ROOTS = Object.freeze([
  fileURLToPath(new URL('../../../plugins/', import.meta.url)),
  fileURLToPath(new URL('../../../daemon/agentRuntime/', import.meta.url)),
  fileURLToPath(new URL('../../../agent/runtime/session/process/', import.meta.url)),
  fileURLToPath(new URL('../../../daemon/startup/', import.meta.url)),
]);

async function readProductionSources(root: string): Promise<ReadonlyArray<Readonly<{
  relativePath: string;
  source: string;
}>>> {
  const sources: Array<Readonly<{ relativePath: string; source: string }>> = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (
        !entry.isFile()
        || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))
        || entry.name.endsWith('.test.ts')
        || entry.name.endsWith('.test.tsx')
      ) {
        continue;
      }
      sources.push(Object.freeze({
        relativePath: relative(root, path),
        source: await readFile(path, 'utf8'),
      }));
    }
  }

  await visit(root);
  return sources;
}

describe('plugin generation materialized-integrity contraction', () => {
  it('removes retired custom content hashes from production readers', async () => {
    const productionSources = (await Promise.all(PRODUCTION_ROOTS.map(readProductionSources))).flat();

    for (const { relativePath, source } of productionSources) {
      // Exact unpublished-current-checkout operator reconciliation only. This
      // module has no runtime caller; the shipped readers remain strict.
      if (relativePath === 'store/registry/unpublishedV1Reconciliation.ts') continue;
      for (const term of RETIRED_MATERIALIZED_INTEGRITY_TERMS) {
        if (!source.includes(term)) continue;
        expect.fail(`${relativePath} retains ${term}`);
      }
    }
  });
});
