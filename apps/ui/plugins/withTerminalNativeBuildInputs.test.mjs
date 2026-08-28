import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const withTerminalNativeBuildInputs = require('./withTerminalNativeBuildInputs.js');

test('terminal-native prebuild registers one package-owned build-input materializer for both native platforms', async () => {
  const dangerousMods = new Map();
  const materializations = [];
  const identities = [];
  const config = { plugins: [] };

  const result = withTerminalNativeBuildInputs(config, {
    withDangerousMod(modConfig, [platform, action]) {
      dangerousMods.set(platform, action);
      return modConfig;
    },
    materialize: async (input) => {
      materializations.push(input);
    },
    materializeIdentity: async (input) => {
      identities.push(input);
    },
  });

  assert.equal(result, config);
  assert.deepEqual([...dangerousMods.keys()].sort(), ['android', 'ios']);

  const introspectionConfig = {
    modRequest: {
      projectRoot: '/workspace/apps/ui',
      introspect: true,
    },
  };
  assert.equal(await dangerousMods.get('ios')(introspectionConfig), introspectionConfig);
  assert.deepEqual(materializations, [], 'Expo config introspection/source paths must not materialize native inputs.');

  const androidConfig = {
    modRequest: {
      projectRoot: '/workspace/apps/ui',
      introspect: false,
    },
  };
  assert.equal(await dangerousMods.get('android')(androidConfig), androidConfig);
  assert.deepEqual(materializations, [{
    platform: 'android',
    projectRoot: '/workspace/apps/ui',
  }]);
  assert.deepEqual(identities, [{
    platform: 'android',
    projectRoot: '/workspace/apps/ui',
    config: androidConfig,
    buildIdentity: null,
  }]);
});

test('terminal-native prebuild resolves the single cross-platform materializer from the package owner', () => {
  const invocation = withTerminalNativeBuildInputs.resolveTerminalNativeBuildInputMaterializer({
    projectRoot: '/workspace/apps/ui',
    platform: 'ios',
    nodePath: '/usr/local/bin/node',
    requireResolve(specifier, options) {
      assert.equal(specifier, '@happier-dev/terminal-native/package.json');
      assert.deepEqual(options, { paths: ['/workspace/apps/ui'] });
      return '/workspace/node_modules/@happier-dev/terminal-native/package.json';
    },
  });

  assert.deepEqual(invocation, {
    command: '/usr/local/bin/node',
    args: [
      '/workspace/node_modules/@happier-dev/terminal-native/scripts/materializeNativeBuildInputs.mjs',
      '--platform',
      'ios',
    ],
  });
});

test('terminal-native evidence build materializes a signed platform identity resource', async () => {
  const root = await mkdtemp(join(tmpdir(), 'term-build-identity-'));
  try {
    const packageRoot = join(root, 'packages', 'terminal-native');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{}');
    const keys = generateKeyPairSync('ed25519');
    await writeFile(join(packageRoot, 'device-evidence-capture-authorities.json'), JSON.stringify({
      schemaVersion: 2,
      authorities: [{
        id: 'qa-capture',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        validFrom: '2026-08-28T09:00:00.000Z',
        validUntil: '2026-08-28T11:00:00.000Z',
        scopes: [{ rendererId: 'android-termux', allowedBuildIds: ['term-build-1234567890abcdef'] }],
      }],
    }));
    const keyPath = join(root, 'capture-private.pem');
    await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const result = await withTerminalNativeBuildInputs.materializeTerminalNativeBuildIdentity({
      projectRoot: join(root, 'apps', 'ui'),
      platform: 'android',
      config: { version: '0.2.10', android: { package: 'dev.happier.app.internaldev', versionCode: 123 } },
      buildIdentity: {
        buildEvidenceId: 'term-build-1234567890abcdef',
        sourceStateSha256: '1'.repeat(64),
        dependencyClosureSha256: '2'.repeat(64),
      },
      env: {
        HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID: 'qa-capture',
        HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH: keyPath,
        HAPPIER_TERMINAL_NATIVE_BUILD_IDENTITY_GENERATED_AT: '2026-08-28T10:00:00.000Z',
      },
      now: () => new Date('2026-08-28T10:00:00.000Z'),
      requireResolve: () => join(packageRoot, 'package.json'),
    });
    assert.equal(result.status, 'materialized');
    const manifest = JSON.parse(await readFile(result.outputPath, 'utf8'));
    const { signature, ...unsigned } = manifest;
    const payload = withTerminalNativeBuildInputs.canonicalJson(unsigned);
    assert.equal(verify(null, Buffer.from(payload), keys.publicKey, Buffer.from(signature, 'base64')), true);
    assert.deepEqual(unsigned, {
      schemaVersion: 1,
      kind: 'terminal-native-build-identity',
      authorityId: 'qa-capture',
      platform: 'android',
      rendererId: 'android-termux',
      buildEvidenceId: 'term-build-1234567890abcdef',
      applicationId: 'dev.happier.app.internaldev',
      version: '0.2.10',
      buildNumber: '123',
      sourceStateSha256: '1'.repeat(64),
      dependencyClosureSha256: '2'.repeat(64),
      generatedAt: '2026-08-28T10:00:00.000Z',
      signatureAlgorithm: 'ed25519',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal-native evidence build rejects wrong-build, premature, and expired authority use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'term-build-identity-bounds-'));
  try {
    const packageRoot = join(root, 'packages', 'terminal-native');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{}');
    const keys = generateKeyPairSync('ed25519');
    await writeFile(join(packageRoot, 'device-evidence-capture-authorities.json'), JSON.stringify({
      schemaVersion: 2,
      authorities: [{
        id: 'qa-capture',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        validFrom: '2026-08-28T11:30:00Z',
        validUntil: '2026-08-30T23:59:59Z',
        scopes: [{ rendererId: 'ios-ghosttykit', allowedBuildIds: ['term-build-allowed123456'] }],
      }],
    }));
    const keyPath = join(root, 'capture-private.pem');
    await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const invoke = (buildEvidenceId, generatedAt) => withTerminalNativeBuildInputs.materializeTerminalNativeBuildIdentity({
      projectRoot: join(root, 'apps', 'ui'),
      platform: 'ios',
      config: { version: '0.2.10', ios: { bundleIdentifier: 'dev.happier.app.dev.internal.devclient', buildNumber: '123' } },
      buildIdentity: { buildEvidenceId, sourceStateSha256: '1'.repeat(64), dependencyClosureSha256: '2'.repeat(64) },
      env: {
        HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID: 'qa-capture',
        HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH: keyPath,
        HAPPIER_TERMINAL_NATIVE_BUILD_IDENTITY_GENERATED_AT: generatedAt,
      },
      now: () => new Date('2026-08-28T12:00:00Z'),
      requireResolve: () => join(packageRoot, 'package.json'),
    });
    await assert.rejects(invoke('term-build-wrong12345678', '2026-08-28T12:00:00Z'), /not registered.*build/);
    await assert.rejects(invoke('term-build-allowed123456', '2026-08-28T11:29:59Z'), /outside.*validity window/);
    await assert.rejects(invoke('term-build-allowed123456', '2026-08-31T00:00:00Z'), /outside.*validity window/);
    await assert.rejects(
      withTerminalNativeBuildInputs.materializeTerminalNativeBuildIdentity({
        projectRoot: join(root, 'apps', 'ui'),
        platform: 'ios',
        config: { version: '0.2.10', ios: { bundleIdentifier: 'dev.happier.app.dev.internal.devclient', buildNumber: '123' } },
        buildIdentity: { buildEvidenceId: 'term-build-allowed123456', sourceStateSha256: '1'.repeat(64), dependencyClosureSha256: '2'.repeat(64) },
        env: {
          HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID: 'qa-capture',
          HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH: keyPath,
          HAPPIER_TERMINAL_NATIVE_BUILD_IDENTITY_GENERATED_AT: '2026-08-28T12:00:00Z',
        },
        now: () => new Date('2026-08-31T00:00:00Z'),
        requireResolve: () => join(packageRoot, 'package.json'),
      }),
      /outside.*validity window/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal-native evidence build fails before packaging without a governed capture authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'term-build-identity-untrusted-'));
  try {
    const packageRoot = join(root, 'packages', 'terminal-native');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{}');
    await writeFile(join(packageRoot, 'device-evidence-capture-authorities.json'), '{"schemaVersion":2,"authorities":[]}');
    const keys = generateKeyPairSync('ed25519');
    const keyPath = join(root, 'capture-private.pem');
    await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await assert.rejects(
      withTerminalNativeBuildInputs.materializeTerminalNativeBuildIdentity({
        projectRoot: join(root, 'apps', 'ui'),
        platform: 'ios',
        config: { version: '0.2.10', ios: { bundleIdentifier: 'dev.happier.app.dev.internal.devclient', buildNumber: '123' } },
        buildIdentity: {
          buildEvidenceId: 'term-build-1234567890abcdef',
          sourceStateSha256: '1'.repeat(64),
          dependencyClosureSha256: '2'.repeat(64),
        },
        env: {
          HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID: 'qa-capture',
          HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH: keyPath,
        },
        requireResolve: () => join(packageRoot, 'package.json'),
      }),
      /not registered for ios-ghosttykit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
