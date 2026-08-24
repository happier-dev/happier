import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  analyzeCurrentPublicApiForEditorial,
  comparePublicApiReleaseRecords,
  preparePublicApiGovernance,
  renderPublicApiReleaseComparison,
  resolvePreviousPublishedApiInventory,
} from './public-api-governance.mjs';

function inventory(symbols) {
  return {
    schemaVersion: 1,
    packageName: '@happier-dev/example',
    symbols,
  };
}

function declarations(alpha = 'value?: string') {
  return [
    '# Example API',
    '',
    '### `.` — `Alpha` (type)',
    '',
    '```ts',
    `type Alpha = { ${alpha}; };`,
    '```',
    '',
  ].join('\n');
}

test('public API comparator reports mechanical symbol and declaration facts without classifying compatibility', () => {
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory([
      { specifier: '.', exportName: 'Alpha', kind: 'type' },
      { specifier: '.', exportName: 'Beta', kind: 'type' },
      { specifier: '.', exportName: 'Removed', kind: 'value' },
    ]),
    candidateInventory: inventory([
      { specifier: '.', exportName: 'Alpha', kind: 'type' },
      {
        specifier: '.',
        exportName: 'Beta',
        kind: 'type',
        replacement: 'Gamma',
        removalCondition: 'next-major',
      },
      { specifier: '.', exportName: 'New', kind: 'value' },
    ]),
    previousDeclarations: declarations(),
    candidateDeclarations: declarations('value: string'),
  });

  assert.equal(report.status, 'comparison');
  assert.deepEqual(report.facts, {
    addedSymbols: ['.:New'],
    removedSymbols: ['.:Removed'],
    deprecatedSymbols: ['.:Beta'],
    changedSymbols: [],
    unchangedSymbols: ['.:Alpha'],
    changedDeclarationBlocks: ['. — Alpha (type)'],
  });
  assert.deepEqual(report.disposition, {
    removedSymbolsAreBreaking: true,
    humanReviewRequired: true,
    versionDecision: 'human_required',
  });
});

test('public API comparator leaves a first publication explicitly dormant rather than inventing history', () => {
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.1',
    previousVersion: null,
    previousInventory: null,
    candidateInventory: inventory([{ specifier: '.', exportName: 'New', kind: 'value' }]),
    previousDeclarations: null,
    candidateDeclarations: declarations(),
  });

  assert.deepEqual(report, {
    status: 'dormant_pre_baseline',
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.1',
    previousVersion: null,
    disposition: {
      removedSymbolsAreBreaking: false,
      humanReviewRequired: false,
      versionDecision: 'not_applicable_pre_baseline',
    },
  });
  assert.match(renderPublicApiReleaseComparison(report), /human review required: no/i);
});

test('public API comparison output makes its existing human-review decision explicit', () => {
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory([]),
    candidateInventory: inventory([{ specifier: '.', exportName: 'New', kind: 'value' }]),
    previousDeclarations: declarations(),
    candidateDeclarations: declarations(),
  });

  assert.equal(report.disposition.humanReviewRequired, true);
  assert.match(renderPublicApiReleaseComparison(report), /human review required: yes/i);
});

test('release preparation derives the exact candidate channel and passes only a previous published tarball inventory into the canonical governance owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-api-governance-prepare-'));
  let cleanupCalls = 0;
  try {
    const packageRoot = join(root, 'package');
    const previousRoot = join(root, 'previous');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(previousRoot, { recursive: true });
    const previousInventoryPath = join(previousRoot, 'api-surface.json');
    const previousDeclarationsPath = join(previousRoot, 'api-declarations.md');
    await writeFile(
      join(packageRoot, 'api-surface.json'),
      `${JSON.stringify(inventory([{ specifier: '.', exportName: 'Alpha', kind: 'type' }]))}\n`,
    );
    await writeFile(join(packageRoot, 'api-declarations.md'), declarations());
    await writeFile(previousInventoryPath, `${JSON.stringify(inventory([]))}\n`);
    await writeFile(previousDeclarationsPath, declarations());

    for (const [candidateVersion, expectedReleaseChannel] of [
      ['0.1.0', 'stable'],
      ['0.1.0-preview.2', 'preview'],
      ['0.1.0-dev.2', 'publicdev'],
    ]) {
      const report = await preparePublicApiGovernance({
        profileId: 'example',
        packageName: '@happier-dev/example',
        packageRoot,
        candidateVersion,
        resolvePreviousPublishedInventoryImpl: async (input) => {
          assert.equal(input.releaseChannel, expectedReleaseChannel);
          return {
            previousVersion: '0.1.0-preview.1',
            previousInventoryPath,
            previousDeclarationsPath,
            cleanup: async () => {
              cleanupCalls += 1;
            },
          };
        },
        runApiGovernanceImpl: async (input) => {
          assert.deepEqual(input, {
            profileId: 'example',
            packageRoot,
            packageRootKind: 'source-complete-publication-sandbox',
            write: true,
            publishedVersion: candidateVersion,
            previousPublishedInventoryPath: previousInventoryPath,
          });
          return { status: 'current' };
        },
      });

      assert.equal(report.status, 'comparison');
      assert.deepEqual(report.facts.addedSymbols, ['.:Alpha']);
    }
    assert.equal(cleanupCalls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editorial API analysis verifies source records and compares them before a candidate version is selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-api-governance-editorial-'));
  try {
    const packageRoot = join(root, 'package');
    const previousRoot = join(root, 'previous');
    await mkdir(packageRoot, { recursive: true });
    await mkdir(previousRoot, { recursive: true });
    const previousInventoryPath = join(previousRoot, 'api-surface.json');
    const previousDeclarationsPath = join(previousRoot, 'api-declarations.md');
    await writeFile(
      join(packageRoot, 'api-surface.json'),
      `${JSON.stringify(inventory([{ specifier: '.', exportName: 'Alpha', kind: 'type' }]))}\n`,
    );
    await writeFile(join(packageRoot, 'api-declarations.md'), declarations());
    await writeFile(previousInventoryPath, `${JSON.stringify(inventory([]))}\n`);
    await writeFile(previousDeclarationsPath, declarations());

    const analysis = await analyzeCurrentPublicApiForEditorial({
      profileId: 'example',
      packageName: '@happier-dev/example',
      packageRoot,
      sourceVersion: '0.1.0-preview.2',
      releaseChannel: 'preview',
      resolvePreviousPublishedInventoryImpl: async (input) => {
        assert.equal(input.candidateVersion, null, 'editorial analysis must not pretend a human-selected candidate version exists');
        assert.equal(input.releaseChannel, 'preview');
        return {
          previousVersion: '0.1.0-preview.1',
          previousInventoryPath,
          previousDeclarationsPath,
          cleanup: async () => {},
        };
      },
      runApiGovernanceImpl: async (input) => {
        assert.deepEqual(input, {
          profileId: 'example',
          packageRoot,
          packageRootKind: 'source-complete-publication-sandbox',
          check: true,
        });
        return { status: 'current' };
      },
    });

    assert.equal(analysis.sourceVersion, '0.1.0-preview.2');
    assert.equal(analysis.comparison.status, 'comparison');
    assert.deepEqual(analysis.comparison.facts.addedSymbols, ['.:Alpha']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('previous-publication resolver chooses the latest published tarball and rejects no history only as pre-baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-api-governance-baseline-'));
  let extractedRoot = '';
  try {
    const baseline = await resolvePreviousPublishedApiInventory({
      packageName: '@happier-dev/example',
      candidateVersion: '0.1.0-preview.3',
      releaseChannel: 'preview',
      repositoryRoot: root,
      queryPublicationTimesImpl: async () => ({
        created: '2026-01-01T00:00:00.000Z',
        '0.1.0-preview.1': '2026-01-02T00:00:00.000Z',
        '0.1.0-preview.2': '2026-01-03T00:00:00.000Z',
        '0.1.0-preview.3': '2026-01-04T00:00:00.000Z',
      }),
      downloadPublishedTarballImpl: async ({ packageName, version, destinationDir }) => {
        assert.equal(packageName, '@happier-dev/example');
        assert.equal(version, '0.1.0-preview.2');
        const tarballPath = join(destinationDir, 'example.tgz');
        await writeFile(tarballPath, 'fixture tarball');
        return tarballPath;
      },
      extractArchivePayloadToDirectoryImpl: async ({ extractDir }) => {
        extractedRoot = extractDir;
        await mkdir(join(extractDir, 'package'), { recursive: true });
        await writeFile(
          join(extractDir, 'package', 'package.json'),
          JSON.stringify({ name: '@happier-dev/example', version: '0.1.0-preview.2' }),
        );
        await writeFile(join(extractDir, 'package', 'api-surface.json'), `${JSON.stringify(inventory([]))}\n`);
        await writeFile(join(extractDir, 'package', 'api-declarations.md'), declarations());
      },
    });

    assert.equal(baseline.previousVersion, '0.1.0-preview.2');
    assert.match(baseline.previousInventoryPath, /package\/api-surface\.json$/u);
    assert.match(baseline.previousDeclarationsPath, /package\/api-declarations\.md$/u);
    await baseline.cleanup();
    await assert.rejects(() => import('node:fs/promises').then(({ lstat }) => lstat(extractedRoot)), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('previous-publication resolver keeps preview and stable history independent from newer dev publications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-api-governance-channel-baseline-'));
  try {
    const publicationTimes = {
      created: '2026-01-01T00:00:00.000Z',
      '0.1.0': '2026-01-02T00:00:00.000Z',
      '0.1.0-preview.4': '2026-01-03T00:00:00.000Z',
      '0.1.0-dev.99': '2026-01-04T00:00:00.000Z',
    };
    const selectedVersions = [];
    const resolveBaseline = (releaseChannel) => resolvePreviousPublishedApiInventory({
      packageName: '@happier-dev/example',
      candidateVersion: null,
      releaseChannel,
      repositoryRoot: root,
      queryPublicationTimesImpl: async () => publicationTimes,
      downloadPublishedTarballImpl: async ({ version, destinationDir }) => {
        selectedVersions.push(version);
        const tarballPath = join(destinationDir, 'example.tgz');
        await writeFile(tarballPath, 'fixture tarball');
        return tarballPath;
      },
      extractArchivePayloadToDirectoryImpl: async ({ extractDir }) => {
        const version = selectedVersions.at(-1);
        await mkdir(join(extractDir, 'package'), { recursive: true });
        await writeFile(
          join(extractDir, 'package', 'package.json'),
          JSON.stringify({ name: '@happier-dev/example', version }),
        );
        await writeFile(join(extractDir, 'package', 'api-surface.json'), `${JSON.stringify(inventory([]))}\n`);
        await writeFile(join(extractDir, 'package', 'api-declarations.md'), declarations());
      },
    });

    const preview = await resolveBaseline('preview');
    assert.equal(preview.previousVersion, '0.1.0-preview.4');
    await preview.cleanup();

    const stable = await resolveBaseline('stable');
    assert.equal(stable.previousVersion, '0.1.0');
    await stable.cleanup();

    const dev = await resolveBaseline('dev');
    assert.equal(dev.previousVersion, '0.1.0-dev.99');
    await dev.cleanup();

    assert.deepEqual(selectedVersions, ['0.1.0-preview.4', '0.1.0', '0.1.0-dev.99']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
