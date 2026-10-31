import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectCargoLicenseTexts,
  createIrohNativeReleaseEvidence,
  writeOrCheckIrohNativeReleaseEvidence,
} from './generate-native-release-evidence.mjs';

const lockfile = `version = 4

[[package]]
name = "happier-iroh-core"
version = "0.0.0"
dependencies = [
 "iroh",
]

[[package]]
name = "iroh"
version = "0.95.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`;

const metadata = {
  packages: [
    {
      id: 'path+file:///checkout/rust/happier-iroh-core#0.0.0',
      name: 'happier-iroh-core',
      version: '0.0.0',
      source: null,
      license: 'MIT',
      repository: 'https://github.com/happier-dev/happier',
      manifest_path: '/checkout/rust/happier-iroh-core/Cargo.toml',
    },
    {
      id: 'registry+https://github.com/rust-lang/crates.io-index#iroh@0.95.1',
      name: 'iroh',
      version: '0.95.1',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      license: 'MIT OR Apache-2.0',
      repository: 'https://github.com/n0-computer/iroh',
      manifest_path: '/registry/iroh-0.95.1/Cargo.toml',
    },
  ],
  resolve: {
    root: null,
    nodes: [
      {
        id: 'path+file:///checkout/rust/happier-iroh-core#0.0.0',
        dependencies: ['registry+https://github.com/rust-lang/crates.io-index#iroh@0.95.1'],
      },
      {
        id: 'registry+https://github.com/rust-lang/crates.io-index#iroh@0.95.1',
        dependencies: [],
      },
    ],
  },
};

test('native notices and SBOM include the resolved locked Cargo graph and provenance', () => {
  const evidence = createIrohNativeReleaseEvidence({ metadata, lockfile });
  const sbom = JSON.parse(evidence.sbom);

  assert.match(evidence.notices, /^Iroh native third-party notices$/m);
  assert.match(evidence.notices, /^iroh 0\.95\.1$/m);
  assert.match(evidence.notices, /^License: MIT OR Apache-2\.0$/m);
  assert.match(evidence.notices, /^Cargo checksum: a{64}$/m);
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.components.length, 2);
  assert.equal(sbom.dependencies.length, 2);
  assert.equal(
    sbom.metadata.properties.find((entry) => entry.name === 'happier:cargo-lock-sha256').value,
    evidence.lockfileSha256,
  );
  assert.equal(
    sbom.metadata.properties.find((entry) => entry.name === 'happier:cargo-metadata-command').value,
    'cargo metadata --locked --format-version 1',
  );
});

/**
 * A registry checkout shaped like a real `~/.cargo/registry/src/**` extraction:
 * `iroh` distributes both of its dual-licence texts plus an Apache NOTICE, and
 * `valuable` distributes none — 33 of the 393 third-party crates in the current
 * locked graph ship no licence file at all, so the evidence owner has to state
 * that gap rather than fail every release or hide it behind an SPDX string.
 */
const licenseFilesOnDisk = new Map([
  ['/registry/iroh-0.95.1', {
    'Cargo.toml': '[package]\n',
    'LICENSE-MIT': 'MIT License\r\n\r\nCopyright (c) n0 computer\r\n',
    'LICENSE-APACHE': 'Apache License\nVersion 2.0\n',
    NOTICE: 'iroh NOTICE text\n',
    'src': null,
  }],
  ['/registry/valuable-0.1.1', { 'Cargo.toml': '[package]\n' }],
  ['/checkout/rust/happier-iroh-core', { 'Cargo.toml': '[package]\n', LICENSE: 'first-party\n' }],
]);

const licenseIo = {
  listDir(dir) {
    const entry = licenseFilesOnDisk.get(dir);
    if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Object.entries(entry)
      .filter(([, contents]) => typeof contents === 'string')
      .map(([name]) => name);
  },
  readText(path) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const name = path.slice(dir.length + 1);
    const contents = licenseFilesOnDisk.get(dir)?.[name];
    if (typeof contents !== 'string') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return contents;
  },
};

const metadataWithUntexturedPackage = {
  ...metadata,
  packages: [
    ...metadata.packages,
    {
      id: 'registry+https://github.com/rust-lang/crates.io-index#valuable@0.1.1',
      name: 'valuable',
      version: '0.1.1',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      license: 'MIT',
      manifest_path: '/registry/valuable-0.1.1/Cargo.toml',
    },
  ],
  resolve: {
    ...metadata.resolve,
    nodes: [
      ...metadata.resolve.nodes,
      { id: 'registry+https://github.com/rust-lang/crates.io-index#valuable@0.1.1', dependencies: [] },
    ],
  },
};

const lockfileWithUntexturedPackage = `${lockfile}
[[package]]
name = "valuable"
version = "0.1.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
`;

test('license collection reads every distributed licence and NOTICE text from the locked package', () => {
  const texts = collectCargoLicenseTexts({ metadata, ...licenseIo });
  const iroh = texts.get('registry+https://github.com/rust-lang/crates.io-index#iroh@0.95.1');

  assert.deepEqual(iroh.map((file) => file.name), ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE']);
  // Windows checkouts and crate archives disagree about line endings; the
  // evidence is byte-compared by `--check`, so it must not depend on the host.
  assert.equal(iroh[1].text, 'MIT License\n\nCopyright (c) n0 computer\n');
});

test('license collection honours a Cargo manifest that names a non-standard licence file', () => {
  const packageDirectory = '/registry/iroh-custom-license';
  const licenseText = 'iroh custom terms\n';
  const texts = collectCargoLicenseTexts({
    metadata: {
      ...metadata,
      packages: metadata.packages.map((pkg) => (pkg.name === 'iroh'
        ? { ...pkg, manifest_path: `${packageDirectory}/Cargo.toml`, license: null, license_file: 'terms.txt' }
        : pkg)),
    },
    listDir: (directory) => directory === packageDirectory ? ['Cargo.toml', 'terms.txt'] : licenseIo.listDir(directory),
    readText: (path) => path === `${packageDirectory}/terms.txt` ? licenseText : licenseIo.readText(path),
  });

  assert.deepEqual(
    texts.get('registry+https://github.com/rust-lang/crates.io-index#iroh@0.95.1'),
    [{ name: 'terms.txt', text: licenseText }],
  );
});

test('notices carry the required licence and NOTICE texts, not only names and SPDX expressions', () => {
  const evidence = createIrohNativeReleaseEvidence({
    metadata: metadataWithUntexturedPackage,
    lockfile: lockfileWithUntexturedPackage,
    licenseTexts: collectCargoLicenseTexts({ metadata: metadataWithUntexturedPackage, ...licenseIo }),
  });

  assert.match(evidence.notices, /^iroh 0\.95\.1$/mu);
  assert.match(evidence.notices, /^License: MIT OR Apache-2\.0$/mu);
  assert.match(evidence.notices, /----- BEGIN iroh 0\.95\.1 LICENSE-MIT -----\nMIT License\n\nCopyright \(c\) n0 computer\n----- END iroh 0\.95\.1 LICENSE-MIT -----/u);
  assert.match(evidence.notices, /----- BEGIN iroh 0\.95\.1 NOTICE -----\niroh NOTICE text\n----- END iroh 0\.95\.1 NOTICE -----/u);

  // The gap is stated where a reader looks for the text, and counted in the
  // header, instead of being silently indistinguishable from a covered package.
  assert.match(
    evidence.notices,
    /^valuable 0\.1\.1$\n^License: MIT$[\s\S]*?^No licence text is distributed with this package\.$/mu,
  );
  assert.match(evidence.notices, /^Third-party packages: 2$/mu);
  assert.match(evidence.notices, /^Third-party packages without distributed licence text: 1$/mu);
});

test('release evidence check fails closed when evidence is missing or stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-native-release-evidence-'));
  try {
    const evidence = createIrohNativeReleaseEvidence({ metadata, lockfile });
    await assert.rejects(
      writeOrCheckIrohNativeReleaseEvidence({ outputDir: root, evidence, check: true }),
      /missing native release evidence/i,
    );

    await writeOrCheckIrohNativeReleaseEvidence({ outputDir: root, evidence, check: false });
    assert.match(await readFile(join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8'), /iroh 0\.95\.1/u);
    assert.equal(JSON.parse(await readFile(join(root, 'sbom.cdx.json'), 'utf8')).components.length, 2);

    await writeFile(join(root, 'THIRD-PARTY-NOTICES.txt'), 'stale\n', 'utf8');
    await assert.rejects(
      writeOrCheckIrohNativeReleaseEvidence({ outputDir: root, evidence, check: true }),
      /stale native release evidence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
