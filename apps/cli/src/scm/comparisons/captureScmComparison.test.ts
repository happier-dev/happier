import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { encodeRepositoryCheckpointScope } from '../checkpoints/refs';
import { captureScmComparison, deleteCapturedScmComparison, readCapturedScmComparison } from './captureScmComparison';

describe('captured SCM comparison storage', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  it('reads recursive stored extras, preserves identity constraints and canonically rewrites before owned pin deletion', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-stored-comparison-' });
    directories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Changed\n');
    const sessionId = randomUUID();
    const captured = await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } });
    const scope = { cwd: fixture.rootPath, sessionId, comparisonId: captured.comparison.id };
    const directory = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', encodeRepositoryCheckpointScope(sessionId));
    directories.push(directory);
    const path = join(directory, `${scope.comparisonId}.json`);
    const original = JSON.parse(await readFile(path, 'utf8')) as { retainedRefs: { ref: string; oid: string }[] };
    const stored = { ...original, sessionId, future: true,
      metadata: { ...captured.metadata, future: true, source: { ...captured.metadata.source, future: true } },
      comparison: { ...captured.comparison, future: true, repository: { ...captured.comparison.repository, future: true },
        inventory: { ...captured.comparison.inventory, future: true, files: captured.comparison.inventory.files.map(file => ({ ...file,
          evidence: { ...file.evidence, future: true }, occurrences: file.occurrences.map(occurrence => ({ ...occurrence,
            future: true, before: { ...occurrence.before, future: true } })),
        })) } },
      retainedRefs: original.retainedRefs.map(ref => ({ ...ref, future: true })),
    };
    await writeFile(path, JSON.stringify(stored));
    expect(await readCapturedScmComparison(scope)).toEqual(captured);
    await expect(readCapturedScmComparison({ ...scope, cwd: '/another-repository' })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await expect(readCapturedScmComparison({ ...scope, source: { kind: 'commit', commit: 'HEAD' } })).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await writeFile(path, JSON.stringify({ ...stored, sessionId: 'another-session' }));
    await expect(readCapturedScmComparison(scope)).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await writeFile(path, JSON.stringify({ ...stored, comparison: { ...stored.comparison, endpoints: { before: 1 } } }));
    await expect(readCapturedScmComparison(scope)).rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
    await writeFile(path, JSON.stringify(stored));
    await captureScmComparison({ cwd: fixture.rootPath, sessionId, source: { kind: 'workingTree' } });
    expect(await readFile(path, 'utf8')).not.toContain('"future"');
    await writeFile(path, JSON.stringify(stored));
    await deleteCapturedScmComparison(scope);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
