// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApiSurfaceGenerationPlan } from './apiSurface.mjs';
import {
  collectCanonicalSourceGraph,
  createApiSurfaceProgressReporter,
  readCurrentApiSurfaceInventory,
  renderCliSummary,
  runApiSurfaceCli,
  runApiSurfaceMaterializer,
  runApiSurfaceSourceHarnessForTests,
} from './apiSurfaceCli.mjs';
import * as apiSurfaceCli from './apiSurfaceCli.mjs';
import { preparePluginSdkWorkspaceDeclarations } from './bundleWorkspaceDeps.mjs';

const CLI_PATH = fileURLToPath(new URL('./apiSurfaceCli.mjs', import.meta.url));

let currentPackageSourceReportPromise;

test('API-surface progress reporting identifies phase and elapsed cost', () => {
  const lines = [];
  const readings = [100, 125, 180];
  const report = createApiSurfaceProgressReporter({
    now: () => readings.shift(),
    write: (line) => lines.push(line),
  });

  report('source-preflight');
  report('realm-closure');

  assert.deepEqual(lines, [
    'api-surface: phase=source-preflight deltaMs=25 totalMs=25\n',
    'api-surface: phase=realm-closure deltaMs=55 totalMs=80\n',
  ]);
});

test('canonical source graph parses a shared physical module once per invocation', async () => {
  const shared = Object.freeze({
    sourceModule: 'src/shared.ts',
    absolutePath: '/fixture/src/shared.ts',
    physicalPath: '/fixture/src/shared.ts',
    contents: 'export const shared = true;',
  });
  const roots = [
    Object.freeze({
      sourceModule: 'src/a.ts',
      absolutePath: '/fixture/src/a.ts',
      physicalPath: '/fixture/src/a.ts',
      contents: "export { shared } from './shared.js';",
    }),
    Object.freeze({
      sourceModule: 'src/b.ts',
      absolutePath: '/fixture/src/b.ts',
      physicalPath: '/fixture/src/b.ts',
      contents: "export { shared } from './shared.js';",
    }),
  ];
  const parseCounts = new Map();

  const graph = await collectCanonicalSourceGraph({
    roots,
    collectRelativeModuleSpecifiersImpl(source) {
      parseCounts.set(source.physicalPath, (parseCounts.get(source.physicalPath) ?? 0) + 1);
      return source === shared ? [] : ['./shared.js'];
    },
    async resolveRelativeSourceEdgeImpl() {
      return Object.freeze({ source: shared });
    },
  });

  assert.equal(graph.size, 3);
  assert.equal(parseCounts.get(shared.physicalPath), 1);
  assert.equal(parseCounts.get(roots[0].physicalPath), 1);
  assert.equal(parseCounts.get(roots[1].physicalPath), 1);
});

function readCurrentPackageSourceReport() {
  currentPackageSourceReportPromise ??= runApiSurfaceSourceHarnessForTests({
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
  });
  return currentPackageSourceReportPromise;
}

test('checked-in browser barrels expose the runtime exports from their publication specs', async () => {
  const runtimeExports = (path, text) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
    return new Set(source.statements.flatMap(statement => {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly ||
          !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return [];
      return statement.exportClause.elements.filter(entry => !entry.isTypeOnly).map(entry => entry.name.text);
    }));
  };
  const inventory = await readCurrentApiSurfaceInventory();
  const { sourceBarrels } = createApiSurfaceGenerationPlan(inventory);
  const browserBarrels = Object.entries(sourceBarrels).filter(([path]) => path.endsWith('/index.browser.ts'));
  assert.ok(browserBarrels.length > 0, 'expected realm-split browser barrels');
  const missingExports = await Promise.all(browserBarrels.map(async ([path, expected]) => {
    const actual = runtimeExports(path, await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
    return [...runtimeExports(path, expected)].filter(name => !actual.has(name)).map(name => `${path}: ${name}`);
  }));
  assert.deepEqual(missingExports.flat(), []);
});

test('SDK signature governance keeps portable internal support types private', async () => {
  const root = await createPackageFixture();
  try {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFixtureFile(root, 'package.json', JSON.stringify({ ...packageJson,
      bundledDependencies: ['@happier-dev/protocol'],
    }));
    await writeFixtureFile(root, 'node_modules/@happier-dev/protocol/package.json', JSON.stringify({
      name: '@happier-dev/protocol', private: true, type: 'module',
      exports: { './contributions': { types: './contributions.d.ts', default: './contributions.js' } },
    }));
    await writeFixtureFile(root, 'node_modules/@happier-dev/protocol/contributions.d.ts',
      'export type DeploymentTargetContributionV1 = Readonly<{ id: string; target: { region: string } }>;\ntype PrivateReviewAuthority = { scope: string };\nexport declare function produceTarget(input: PrivateReviewAuthority): DeploymentTargetContributionV1;\n');
    await writeFixtureFile(root, 'node_modules/@happier-dev/protocol/contributions.js',
      "export const produceTarget = input => ({ id: input.scope, target: { region: 'fixture' } });\n");
    await writeFixtureFile(root, 'src/actions/support.ts',
      'export type MachineSetupSourceFactsMapV1 = Readonly<Record<string, { state: string }>>;\n');
    await writeFixtureFile(root, 'src/actions/service.ts', [
      "import type { DeploymentTargetContributionV1 as CanonicalDeploymentTargetContributionV1 } from '@happier-dev/protocol/contributions';",
      "import { produceTarget as canonicalProduceTarget } from '@happier-dev/protocol/contributions';",
      "import type { MachineSetupSourceFactsMapV1 } from './support.js';",
      'export interface ActionsService {}',
      'export type ManagedMachinesActionResultById = { setup: { sourceFacts?: MachineSetupSourceFactsMapV1 } };',
      'type ReadonlyAuthorDeclaration<T> = { readonly [K in keyof T]: T[K] };',
      'export type DeploymentTargetContributionV1 = ReadonlyAuthorDeclaration<CanonicalDeploymentTargetContributionV1>;',
      'export const produceTarget: typeof canonicalProduceTarget = canonicalProduceTarget;',
    ].join('\n'));
    await publishFixtureSymbols(root, ['ManagedMachinesActionResultById', 'DeploymentTargetContributionV1']
      .map((name) => ({ specifier: './actions', exportName: name, kind: 'type',
        sourceModule: 'src/actions/service.ts', sourceExport: name, realm: 'any' })));
    await publishFixtureSymbols(root, [{ specifier: './actions', exportName: 'produceTarget', kind: 'value',
      sourceModule: 'src/actions/service.ts', sourceExport: 'produceTarget', realm: 'any' }]);
    const { inventory } = await runApiSurfaceSourceHarnessForTests({ packageRoot: root });
    for (const name of ['MachineSetupSourceFactsMapV1', 'CanonicalDeploymentTargetContributionV1', 'PrivateReviewAuthority']) {
      assert.equal(inventory.symbols.some(({ exportName }) => exportName === name), false,
        `${name} is a declaration dependency, not an authored public export`);
    }
    await writeFixtureFile(root, 'src/host/private.ts', 'export interface HostInternal { secret: string }\n');
    await writeFixtureFile(root, 'src/actions/support.ts', [
      "import type { HostInternal } from '../host/private.js';",
      'export type MachineSetupSourceFactsMapV1 = { nested: HostInternal };',
    ].join('\n'));
    await assert.rejects(runApiSurfaceSourceHarnessForTests({ packageRoot: root }),
      /public signature references author type HostInternal/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// These are the three author-owned publication specs. Keep the census exact:
// generated convenience barrels are outputs, while these files are the source
// of truth for what each package subpath may publish.
const VOICE_PUBLIC_EXPORTS_BY_ENTRYPOINT = Object.freeze({
  './voice': Object.freeze([
    'ConnectedAccountHttpHeadersRequest',
    'PluginVoiceProviderDefinition',
    'RegisteredVoiceProviderRuntime',
    'VOICE_SPEECH_OUTPUT_MAX_BYTES',
    'VoiceAccountOperationService',
    'VoiceAvailabilityPlatform',
    'VoiceCredentialAccess',
    'VoiceCredentialAccessPhase',
    'VoiceCredentialDeclaration',
    'VoiceCredentialOperationProjection',
    'VoiceCredentialSlotId',
    'VoiceCredentialSlotIdSchema',
    'VoiceModelPackContributionV1',
    'VoiceModelPackContributionV1Schema',
    'VoiceModelPackDirectoryArtifactV1',
    'VoiceModelPackDirectoryArtifactV1Schema',
    'VoiceModelPackExecutionHostV1',
    'VoiceModelPackExecutionHostV1Schema',
    'VoiceModelPackFileArtifactV1',
    'VoiceModelPackFileArtifactV1Schema',
    'VoiceModelPackKokoroArtifactsV1',
    'VoiceModelPackKokoroArtifactsV1Schema',
    'VoiceModelPackLicenseV1',
    'VoiceModelPackLicenseV1Schema',
    'VoiceModelPackLocalIdV1Schema',
    'VoiceModelPackManifestV1',
    'VoiceModelPackManifestV1Schema',
    'VoiceModelPackRuntimeV1',
    'VoiceModelPackRuntimeV1Schema',
    'VoiceModelPackSupportArtifactKindV1',
    'VoiceModelPackSupportArtifactKindV1Schema',
    'VoiceModelPackSupportArtifactV1',
    'VoiceModelPackSupportArtifactV1Schema',
    'VoiceModelPackTransducerArtifactsV1',
    'VoiceModelPackTransducerArtifactsV1Schema',
    'VoicePrivacyFacts',
    'VoiceProviderContribution',
    'VoiceProviderContributionSchema',
    'VoiceProviderSettings',
    'VoiceProviderSettingsPresentation',
    'VoiceProviderSettingsPresentationField',
    'VoiceProviderSettingsPresentationSchema',
    'VoiceProvidersRegistrationApi',
    'VoiceRawCredentialAccess',
    'VoiceRawCredentialGrantDeclaration',
    'VoiceSchema',
    'VoiceServiceMark',
    'VoiceServiceMarkSchema',
    'VoiceSettingReadinessDeclaration',
    'VoiceSettingsActionContext',
    'classifyVoiceProviderHttpFailure',
    'createVoiceRecordSchema',
    'resolveVoiceProviderLanguagePreference',
    'withVoiceSchemaField',
  ]),
  './voice/client': Object.freeze([
    'HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE',
    'HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE',
    'PluginVoiceAgentSessionRealtimeService',
    'RealtimeVoiceProviderProtocol',
    'RealtimeVoiceProviderRuntime',
    'RealtimeVoiceProviderSettingsOperations',
    'VoiceAudioContextHandle',
    'VoiceClientAuthArtifact',
    'VoiceClientToolAgentPromptOptions',
    'VoiceClientToolDefinition',
    'VoiceConnectionMediaHost',
    'VoiceConversationCapabilities',
    'VoiceConversationProviderRole',
    'VoiceGuidanceAvailability',
    'VoiceHostedConversationService',
    'VoiceMediaStreamHandle',
    'VoiceMicSession',
    'VoiceMicrophoneMode',
    'VoiceOutputFocusApplication',
    'VoiceOutputFocusState',
    'VoiceOutputInterruptionResolution',
    'VoiceProviderConversationService',
    'VoiceProviderExecutionAuthority',
    'VoiceRealtimeAttemptPolicy',
    'VoiceRealtimeCanonicalEvent',
    'VoiceRealtimeConnection',
    'VoiceRealtimeConnectionCloseReason',
    'VoiceRealtimeJsonValue',
    'VoiceRealtimeJsonValueSchema',
    'VoiceRealtimePreflight',
    'VoiceRealtimePreparation',
    'VoiceRealtimeToolCall',
    'VoiceRealtimeToolCallV1Schema',
    'VoiceRealtimeToolResult',
    'VoiceRealtimeToolResultV1Schema',
    'VoiceRuntimePlatform',
    'VoiceSdkHandleConnectionDriver',
    'VoiceTranscriptCanonicalEvent',
    'VoiceTranscriptCanonicalEventV1Schema',
    'VoiceTranscriptLadderMapper',
    'VoiceTranscriptLadderMode',
    'VoiceTranscriptLadderObservation',
    'VoiceTurnControlAction',
    'buildVoiceClientToolAgentPrompt',
    'createVoiceTranscriptLadderMapper',
    'describeActionForVoiceTool',
    'describeActionInputFieldForVoice',
    'isVoiceSdkSafeActionSpec',
    'listVoiceSdkSafeToolActionSpecs',
  ]),
  './voice/speech': Object.freeze([
    'SpeechProviderRuntime',
    'VoiceProviderCatalogItem',
    'VoiceSpeechCatalogDeclaration',
    'VoiceSpeechInputMimeType',
    'VoiceSpeechOperationContext',
    'VoiceSpeechProviderLimits',
    'VoiceSpeechProviderRole',
    'VoiceSpeechSynthesizeRequest',
    'VoiceSpeechSynthesizeResult',
    'VoiceSpeechTranscribeRequest',
    'VoiceSpeechTranscribeResult',
  ]),
});
const INVENTORY = Object.freeze({
  schemaVersion: 1,
  entrypoints: [{
    specifier: './actions', sourceModule: 'src/actions/index.ts', visibility: 'author', realm: 'any',
    conditions: { types: './dist/actions/index.d.ts', default: './dist/actions/index.js' },
  }],
  symbols: [{
    specifier: './actions', exportName: 'ActionsService', kind: 'type',
    sourceModule: 'src/actions/service.ts', sourceExport: 'ActionsService', realm: 'any',
  }],
});

async function createWorkspaceRootFixture(root, packages) {
  await writeFixtureFile(root, 'package.json', '{"private":true}\n');
  await writeFixtureFile(root, 'pnpm-workspace.yaml', `packages: ${JSON.stringify(packages)}\n`);
  await writeFixtureFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
}

async function writeFixtureFile(root, relativePath, contents) {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function seedFixturePublicationSpecs(root) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const specifiers = Object.keys(packageJson.exports).filter((specifier) => (
    specifier === '.' || (specifier.startsWith('./') && !specifier.includes('*') && specifier !== './package.json')
  ));
  for (const specifier of specifiers) {
    const generatedBarrel = specifier === '.'
      ? 'src/index.ts'
      : `src/${specifier.slice(2)}/index.ts`;
    const publicationSpec = generatedBarrel.replace(/index\.ts$/u, 'index.public.ts');
    await writeFixtureFile(
      root,
      publicationSpec,
      await readFile(join(root, generatedBarrel), 'utf8'),
    );
  }
}

async function createPackageFixture(root = undefined) {
  root ??= await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-cli-'));
  await mkdir(root, { recursive: true });
  const packageJson = {
    name: '@happier-dev/plugin-sdk-fixture',
    private: true,
    exports: {
      './actions': {
        types: './dist/actions/index.d.ts',
        default: './dist/actions/index.js',
      },
    },
  };
  await writeFixtureFile(root, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFixtureFile(root, 'api-surface.json', `${JSON.stringify(INVENTORY, null, 2)}\n`);
  await writeFixtureFile(root, 'src/actions/index.ts', [
    "export type { ActionsService } from './service.js';",
    '',
  ].join('\n'));
  await writeFixtureFile(root, 'src/actions/service.ts', 'export interface ActionsService {}\n');
  await seedFixturePublicationSpecs(root);
  return root;
}

async function createVendoredDeclarationStalenessFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-vendored-stale-'));
  const root = join(repoRoot, 'packages/plugin-sdk');
  const workspaceProtocolRoot = join(repoRoot, 'packages/protocol');
  await writeFile(join(repoRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8');
  await writeFile(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFixtureFile(
    repoRoot,
    'package.json',
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  await writeFixtureFile(
    workspaceProtocolRoot,
    'package.json',
    `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
  );
  await writeFixtureFile(
    workspaceProtocolRoot,
    'dist/current.d.ts',
    'export type CurrentProtocolDeclaration = string;\n',
  );
  await mkdir(join(repoRoot, 'node_modules/@happier-dev'), { recursive: true });
  await symlink(
    workspaceProtocolRoot,
    join(repoRoot, 'node_modules/@happier-dev/protocol'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFixtureFile(
    root,
    'node_modules/@happier-dev/protocol/package.json',
    `${JSON.stringify({ name: '@happier-dev/protocol', version: '0.0.0' }, null, 2)}\n`,
  );
  await writeFixtureFile(
    root,
    'node_modules/@happier-dev/protocol/dist/retired.d.ts',
    'export type RetiredProtocolDeclaration = string;\n',
  );
  await createPackageFixture(root);
  // This regression isolates vendoring, so keep its unrelated host surface
  // valid through the current source inventory rather than a stale name list.
  const inventory = await readCurrentApiSurfaceInventory({
    packageRoot: resolve(import.meta.dirname, '..'),
  });
  for (const entrypoint of inventory.entrypoints.filter(({ visibility }) => visibility === 'host')) {
    const symbols = inventory.symbols.filter(({ specifier }) => specifier === entrypoint.specifier);
    const directory = `src/${entrypoint.specifier.slice(2)}`;
    await writeFixtureFile(root, `${directory}/contract.ts`, [
      `/** @moduleRealm ${entrypoint.realm} */`,
      ...symbols.map(({ exportName, kind }) => kind === 'type'
        ? `export type ${exportName} = unknown;`
        : `export const ${exportName} = null;`),
      '',
    ].join('\n'));
    await writeFixtureFile(root, `${directory}/index.public.ts`, symbols.map(({ exportName, kind }) => (
      `export${kind === 'type' ? ' type' : ''} { ${exportName} } from './contract.js';\n`
    )).join(''));
  }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFixtureFile(root, 'package.json', JSON.stringify({ ...packageJson,
    bundledDependencies: ['@happier-dev/protocol'],
  }));
  // Already-emitted producer output is the filesystem boundary. Preparation,
  // bundle resolution, copying, pruning and declaration checks remain real.
  await writeFixtureFile(repoRoot, 'packages/cli-common/package.json',
    JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' }));
  await writeFixtureFile(repoRoot, 'packages/cli-common/dist/workspaces/index.js',
    `export * from ${JSON.stringify(new URL('../../cli-common/src/workspaces/index.ts', import.meta.url).href)};\n`);
  return { repoRoot, root };
}

/**
 * Every input and output the full publisher reads for this package, copied as a
 * whole so a test can drift a generated artifact without ever writing a byte
 * inside the checkout's own package root. `node_modules` is deliberately not
 * copied: the copy lives under the real package root, so type resolution walks
 * up into the same vendored `@happier-dev/*` copies the real run reads.
 */
const CURRENT_PACKAGE_GOVERNED_ENTRIES = Object.freeze([
  'package.json',
  'tsconfig.json',
  'api-surface.schema.json',
  'API.md',
  'capability-matrix.json',
  'src',
  'dist',
]);

/**
 * Copies this package into a Git-ignored scratch root beside it. The name
 * follows the repository's `.tmp.<ms>.<pid>.<hex>` scratch convention, which
 * `.gitignore` already excludes, so a killed run leaves no tracked residue.
 */
async function createCurrentPackageCopy() {
  const packageRoot = resolve(import.meta.dirname, '..');
  const root = join(
    packageRoot,
    `.tmp.${Date.now()}.${process.pid}.${randomUUID().replaceAll('-', '')}`,
  );
  await mkdir(root, { recursive: true });
  await Promise.all(CURRENT_PACKAGE_GOVERNED_ENTRIES.map((entry) => (
    cp(join(packageRoot, entry), join(root, entry), { recursive: true })
  )));
  return { packageRoot, root };
}

/**
 * Publishes symbols the way package source publishes them: through the
 * author-owned entrypoint publication spec, with the realm declared on the
 * canonical module. The rows keep the inventory shape because the inventory
 * is what they project into.
 */
async function publishFixtureSymbols(root, rows) {
  const rowsByPublicationSpec = new Map();
  for (const row of rows) {
    const generatedBarrelModule = row.specifier === '.'
      ? 'src/index.ts'
      : `src/${row.specifier.slice(2)}/index.ts`;
    const publicationSpecModule = generatedBarrelModule.replace(/index\.ts$/u, 'index.public.ts');
    rowsByPublicationSpec.set(
      publicationSpecModule,
      [...rowsByPublicationSpec.get(publicationSpecModule) ?? [], row],
    );
  }
  for (const [publicationSpecModule, publicationRows] of rowsByPublicationSpec) {
    const existing = await readFile(join(root, publicationSpecModule), 'utf8');
    const lines = [];
    for (const [index, line] of existing.split('\n').entries()) {
      if (!line.startsWith('export')) continue;
      const previous = existing.split('\n')[index - 1] ?? '';
      lines.push({
        exportName: /\{ (?:\w+ as )?(\w+) \}/u.exec(line)[1],
        text: previous.startsWith('/**') ? `${previous}\n${line}` : line,
      });
    }
    for (const row of publicationRows) {
      const imported = row.sourceExport === row.exportName
        ? row.exportName
        : `${row.sourceExport} as ${row.exportName}`;
      const doc = row.replacement === undefined
        ? ''
        : `/** @deprecated ${row.replacement}; remove when ${row.removalCondition} */\n`;
      lines.push({
        exportName: row.exportName,
        text: `${doc}export${row.kind === 'type' ? ' type' : ''} { ${imported} } from '${relativeFixtureModule(publicationSpecModule, row.sourceModule)}';`,
      });
    }
    lines.sort((left, right) => (left.exportName < right.exportName ? -1 : left.exportName > right.exportName ? 1 : 0));
    await writeFixtureFile(
      root,
      publicationSpecModule,
      `${lines.map((line) => line.text).join('\n')}\n`,
    );
  }
}

function relativeFixtureModule(barrelModule, sourceModule) {
  const from = barrelModule.split('/').slice(0, -1);
  const to = sourceModule.replace(/\.tsx?$/u, '.js').split('/');
  while (from.length > 0 && to.length > 1 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const prefix = from.length === 0 ? './' : '../'.repeat(from.length);
  return `${prefix}${to.join('/')}`;
}

/** Declares a canonical module realm the way package source declares one. */
async function declareFixtureModuleRealm(root, sourceModule, realm) {
  const contents = await readFile(join(root, sourceModule), 'utf8');
  await writeFixtureFile(root, sourceModule, `/** @moduleRealm ${realm} */\n${contents}`);
}

async function addPortableValueFixture(root, realm, sourceContents) {
  await writeFixtureFile(root, 'src/actions/portableValue.ts', sourceContents);
  if (realm !== 'any') await declareFixtureModuleRealm(root, 'src/actions/portableValue.ts', realm);
  await publishFixtureSymbols(root, [{
    specifier: './actions',
    exportName: 'PortableValue',
    kind: 'value',
    sourceModule: 'src/actions/portableValue.ts',
    sourceExport: 'PortableValue',
    realm,
  }]);
}

const MATERIALIZER_CLI_SOURCE = `
import {
  parseApiSurfaceCliArgs,
  renderCliSummary,
  runApiSurfaceMaterializer,
} from ${JSON.stringify(pathToFileURL(CLI_PATH).href)};

const options = parseApiSurfaceCliArgs(process.argv.slice(1));
const onProgress = (phase) => {
  process.stderr.write(\`api-surface: phase=\${phase}\\n\`);
};
try {
  const report = await runApiSurfaceMaterializer({ ...options, onProgress });
  process.stdout.write(options.json
    ? \`\${JSON.stringify(report, null, 2)}\\n\`
    : renderCliSummary(report));
  if (options.check && report.summary.changedFiles > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
}
`;

// Synthetic package fixtures own only the API-surface artifacts. The complete
// SDK CLI additionally derives the capability matrix from the real package's
// definePlugin/services declarations, so fixture assertions use the lower
// materializer owner through the same CLI-shaped progress/report contract.
function runCli(packageRoot, args = []) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', MATERIALIZER_CLI_SOURCE, '--', '--package-root', packageRoot, ...args],
    { encoding: 'utf8' },
  );
}

function runJsonCli(packageRoot, args = []) {
  return runCli(packageRoot, ['--json', ...args]);
}

function runProductionCli(packageRoot, args = []) {
  return spawnSync(
    process.execPath,
    [CLI_PATH, '--package-root', packageRoot, ...args],
    { encoding: 'utf8' },
  );
}

test('source materialization updates generated barrels before declaration preparation', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/actions/newlyPublished.ts', [
      'export type NewlyPublishedActionOptions = Readonly<{ id: string }>;',
      '',
    ].join('\n'));
    await writeFile(join(root, 'src/actions/index.public.ts'), [
      "export type { ActionsService } from './service.js';",
      "export type { NewlyPublishedActionOptions } from './newlyPublished.js';",
      '',
    ].join('\n'), 'utf8');

    const result = runProductionCli(root, ['--materialize-source', '--write']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), "export * from './index.public.js';\n");
    assert.doesNotMatch(result.stdout, /publicDeclarationReport/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source materialization check reports a stale generated barrel without repairing it', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/actions/newlyPublished.ts', [
      'export type NewlyPublishedActionOptions = Readonly<{ id: string }>;',
      '',
    ].join('\n'));
    await writeFile(join(root, 'src/actions/index.public.ts'), [
      "export type { ActionsService } from './service.js';",
      "export type { NewlyPublishedActionOptions } from './newlyPublished.js';",
      '',
    ].join('\n'), 'utf8');
    const generatedBarrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');

    const result = runProductionCli(root, ['--materialize-source', '--check']);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /drift sourceBarrels src\/actions\/index\.ts/u);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), generatedBarrelBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real CLI default output is a concise summary with bounded real-phase progress', async () => {
  const root = await createPackageFixture();
  try {
    const result = runCli(root);
    const machineReadable = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        'api-surface dry-run: drift (planned=7 changed=6 written=0)',
        '  drift packageExports package.json',
        '  drift sourceBarrels src/actions/index.ts',
        '  drift authorApiMarkdown API.md',
        '',
      ].join('\n'),
    );
    assert.equal(
      result.stderr,
      [
        'api-surface: phase=package-root',
        'api-surface: phase=vendored-declarations',
        'api-surface: phase=source-preflight',
        'api-surface: phase=inventory',
        'api-surface: phase=output-preflight',
        'api-surface: phase=source-projection',
        'api-surface: phase=author-signature-closure',
        'api-surface: phase=realm-closure',
      ].join('\n').concat('\n'),
    );
    // One header line plus one line per committed file that drifted: the
    // default output stays scannable while naming the whole delta. The
    // generated inventory is not committed, so it never reports drift.
    assert.equal(result.stdout.trimEnd().split('\n').length, 7);
    assert.equal(machineReadable.status, result.status, machineReadable.stderr);
    const report = JSON.parse(machineReadable.stdout);
    assert.deepEqual(report.summary, {
      plannedFiles: 7,
      changedFiles: 6,
      writtenFiles: 0,
    });
    assert.ok(machineReadable.stdout.length > result.stdout.length);
    assert.equal(report.generationPlan.authorApiMarkdown.includes('ActionsService'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source-only harness validates author specs while the publisher-owned vendored declarations are stale', async () => {
  const { repoRoot, root } = await createVendoredDeclarationStalenessFixture();
  try {
    assert.equal(typeof apiSurfaceCli.runApiSurfaceSourceHarnessForTests, 'function');
    const report = await apiSurfaceCli.runApiSurfaceSourceHarnessForTests({ packageRoot: root });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.status, 'drift');
    assert.equal(report.summary.writtenFiles, 0);
    assert.deepEqual(
      report.inventory.symbols
        .filter((symbol) => symbol.specifier === './actions')
        .map(({ exportName, kind, realm }) => ({ exportName, kind, realm })),
      [{ exportName: 'ActionsService', kind: 'type', realm: 'any' }],
    );
    assert.equal(Object.hasOwn(report.generationPlan.packageExports, './actions'), true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('API-surface prerequisite repairs stale worker declarations through the canonical producer', async () => {
  const { repoRoot, root } = await createVendoredDeclarationStalenessFixture();
  const env = { ...process.env, HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1' };
  try {
    const vendor = join(root, 'node_modules/@happier-dev/protocol/dist');
    const current = join(repoRoot, 'packages/protocol/dist/current.d.ts');
    await runApiSurfaceMaterializer({ packageRoot: root, write: true, env });
    await writeFixtureFile(root, 'node_modules/@happier-dev/protocol/dist/current.d.ts',
      'export type CurrentProtocolDeclaration = never;\n');
    await writeFixtureFile(root, 'node_modules/@happier-dev/protocol/dist/retired.d.ts',
      'export type RetiredProtocolDeclaration = string;\n');
    const report = await runApiSurfaceMaterializer({ packageRoot: root, check: true, env });
    assert.equal(report.status, 'current');
    assert.equal(await readFile(join(vendor, 'current.d.ts'), 'utf8'), await readFile(current, 'utf8'));
    await assert.rejects(stat(join(vendor, 'retired.d.ts')), { code: 'ENOENT' });
    const published = await stat(join(vendor, 'current.d.ts'), { bigint: true });
    assert.equal((await runApiSurfaceMaterializer({ packageRoot: root, check: true, env })).status, 'current');
    assert.equal((await stat(join(vendor, 'current.d.ts'), { bigint: true })).mtimeNs, published.mtimeNs);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('API-surface writer retains its admitted copy and the next check refreshes it', async () => {
  const { repoRoot, root } = await createVendoredDeclarationStalenessFixture();
  const env = {
    ...process.env,
    HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1',
    HAPPIER_WORKSPACE_CAPTURE_SOURCE_REPO_DIR: join(repoRoot, 'producer'),
  };
  const current = join(repoRoot, 'packages/protocol/dist/current.d.ts');
  const vendored = join(root, 'node_modules/@happier-dev/protocol/dist/current.d.ts');
  try {
    await preparePluginSdkWorkspaceDeclarations({
      repoRoot,
      pluginSdkDir: root,
      env,
      consumePreparedWorkspace: async ({ preparedWorkspaceEnv }) => {
        const admitted = await readFile(vendored, 'utf8');
        await writeFile(current, 'export type CurrentProtocolDeclaration = number;\n');
        await runApiSurfaceMaterializer({ packageRoot: root, write: true, env: preparedWorkspaceEnv });
        assert.equal(await readFile(vendored, 'utf8'), admitted);
      },
    });
    assert.equal((await runApiSurfaceMaterializer({ packageRoot: root, check: true, env })).status, 'current');
    assert.equal(await readFile(vendored, 'utf8'), await readFile(current, 'utf8'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('source harness projects direct bundled Protocol schemas through the approved public structural types only', async () => {
  const root = await createPackageFixture();
  try {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await writeFixtureFile(root, 'package.json', JSON.stringify({ ...packageJson,
      bundledDependencies: ['@happier-dev/protocol'],
    }));
    await writeFixtureFile(
      root,
      'node_modules/@happier-dev/protocol/package.json',
      `${JSON.stringify({
        name: '@happier-dev/protocol',
        version: '0.0.0',
        exports: {
          './connect/canonical-schema': {
            types: './dist/connect/canonical-schema.d.ts',
            default: './dist/connect/canonical-schema.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(
      root,
      'node_modules/@happier-dev/protocol/dist/connect/canonical-schema.d.ts',
      [
        "export type PluginJsonSchemaV2 = { type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object'; };",
        'export type ProtocolValidationIssue = Readonly<{ path: readonly (string | number)[]; code: string; message: string; }>;',
        'export interface ProtocolValidationError extends Error { readonly issues: readonly ProtocolValidationIssue[]; }',
        'export type ProtocolSchemaSafeParseResult<TOutput> = Readonly<{ success: true; data: TOutput }> | Readonly<{ success: false; error: ProtocolValidationError }>;',
        'export interface ProtocolComposableSchema<TInput, TOutput = TInput> {',
        '  readonly jsonSchema: PluginJsonSchemaV2;',
        '  parse(value: unknown): TOutput;',
        '  safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;',
        '  optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;',
        '  nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;',
        '}',
        'export type ProtocolZodComposableSchema<TOutput> = ProtocolComposableSchema<TOutput, TOutput> & Readonly<{ _privateValidatorView: true; }>;',
        'export declare const CanonicalSchema: ProtocolZodComposableSchema<Readonly<{ id: string }>>;',
        'export declare const CanonicalJsonSchema: PluginJsonSchemaV2;',
        'export type CanonicalContribution = Readonly<{ schema: ProtocolComposableSchema<string> }>;',
        'export interface PrivateProtocolParser<TOutput> {',
        '  parse(value: unknown): TOutput;',
        '  safeParse(value: unknown): Readonly<{ success: true; data: TOutput }> | Readonly<{ success: false; error: ProtocolValidationError }>;',
        '  optional(): PrivateProtocolParser<TOutput | undefined>;',
        '  nullable(): PrivateProtocolParser<TOutput | null>;',
        '}',
        'export type CanonicalInputV1 = Readonly<{ id: string }>;',
        'export declare const CanonicalInputV1Schema: PrivateProtocolParser<CanonicalInputV1>;',
        '',
      ].join('\n'),
    );
    await writeFixtureFile(
      root,
      'node_modules/@happier-dev/protocol/dist/connect/canonical-schema.js',
      'export {};\n',
    );
    await writeFixtureFile(
      root,
      'src/actions/service.ts',
      [
        'export type PluginJsonSchema = { type?: \'null\' | \'boolean\' | \'number\' | \'integer\' | \'string\' | \'array\' | \'object\'; };',
        'export interface ProtocolComposableSchema<TInput, TOutput = TInput> {',
        '  readonly jsonSchema: PluginJsonSchema;',
        '  parse(value: unknown): TOutput;',
        '  safeParse(value: unknown): Readonly<{ success: true; data: TOutput }> | Readonly<{ success: false; error: Error & Readonly<{ issues: readonly Readonly<{ path: readonly (string | number)[]; code: string; message: string; }>[]; }> }>;',
        '  optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;',
        '  nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;',
        '}',
        'export interface ActionsService {}',
        "export type { CanonicalContribution } from '@happier-dev/protocol/connect/canonical-schema';",
        "export { CanonicalInputV1Schema, CanonicalJsonSchema, CanonicalSchema } from '@happier-dev/protocol/connect/canonical-schema';",
        "export type { CanonicalInputV1 } from '@happier-dev/protocol/connect/canonical-schema';",
        '',
      ].join('\n'),
    );
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'CanonicalContribution',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'CanonicalContribution',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'PluginJsonSchema',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'PluginJsonSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'ProtocolComposableSchema',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'ProtocolComposableSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'CanonicalInputV1',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'CanonicalInputV1',
        realm: 'any',
      },
    ]);
    const publicTypeInventory = await runApiSurfaceSourceHarnessForTests({ packageRoot: root });
    assert.equal(
      publicTypeInventory.inventory.symbols.some((symbol) => (
        symbol.kind === 'type' && symbol.sourceExport === 'PluginJsonSchema'
      )),
      true,
    );
    assert.equal(
      publicTypeInventory.inventory.symbols.some((symbol) => (
        symbol.kind === 'type' && symbol.sourceExport === 'ProtocolComposableSchema'
      )),
      true,
    );
    assert.equal(
      publicTypeInventory.inventory.symbols.some((symbol) => (
        symbol.kind === 'type' && symbol.sourceExport === 'CanonicalInputV1'
      )),
      true,
    );

    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'CanonicalJsonSchema',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'CanonicalJsonSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'CanonicalSchema',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'CanonicalSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'CanonicalInputV1Schema',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'CanonicalInputV1Schema',
        realm: 'any',
      },
    ]);

    const direct = await runApiSurfaceSourceHarnessForTests({ packageRoot: root });
    assert.equal(direct.status, 'drift');

    await writeFixtureFile(
      root,
      'src/actions/service.ts',
      [
        "import { CanonicalSchema } from '@happier-dev/protocol/connect/canonical-schema';",
        "export type { CanonicalContribution } from '@happier-dev/protocol/connect/canonical-schema';",
        'export type PluginJsonSchema = { type?: \'null\' | \'boolean\' | \'number\' | \'integer\' | \'string\' | \'array\' | \'object\'; };',
        'export interface ProtocolComposableSchema<TInput, TOutput = TInput> {',
        '  readonly jsonSchema: PluginJsonSchema;',
        '  parse(value: unknown): TOutput;',
        '  safeParse(value: unknown): Readonly<{ success: true; data: TOutput }> | Readonly<{ success: false; error: Error & Readonly<{ issues: readonly Readonly<{ path: readonly (string | number)[]; code: string; message: string; }>[]; }> }>;',
        '  optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;',
        '  nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;',
        '}',
        'export interface ActionsService {}',
        "export { CanonicalInputV1Schema, CanonicalJsonSchema, CanonicalSchema } from '@happier-dev/protocol/connect/canonical-schema';",
        "export type { CanonicalInputV1 } from '@happier-dev/protocol/connect/canonical-schema';",
        'export const wrappedSchema = CanonicalSchema;',
        '',
      ].join('\n'),
    );
    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'wrappedSchema',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'wrappedSchema',
      realm: 'any',
    }]);

    await assert.rejects(
      runApiSurfaceSourceHarnessForTests({ packageRoot: root }),
      /wrappedSchema public signature references author type /u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source harness permits portable local schema declarations without public aliases', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(
      root,
      'src/actions/service.ts',
      [
        "export type PluginJsonSchema = { type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object'; };",
        'export interface ProtocolComposableSchema<TInput, TOutput = TInput> {',
        '  readonly jsonSchema: PluginJsonSchema;',
        '  parse(value: unknown): TOutput;',
        '  safeParse(value: unknown): Readonly<{ success: true; data: TOutput }> | Readonly<{ success: false; error: Error }>;',
        '  optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;',
        '  nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;',
        '}',
        "type PrivatePluginJsonSchema = { type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object'; };",
        'interface PrivateProtocolSchema<TOutput> {',
        '  readonly jsonSchema: PrivatePluginJsonSchema;',
        '  parse(value: unknown): TOutput;',
        '  safeParse(value: unknown): Readonly<{ success: true; data: TOutput }> | Readonly<{ success: false; error: Error }>;',
        '  optional(): PrivateProtocolSchema<TOutput | undefined>;',
        '  nullable(): PrivateProtocolSchema<TOutput | null>;',
        '}',
        'declare const LocalSchema: PrivateProtocolSchema<Readonly<{ id: string }>>;',
        'export { LocalSchema };',
        'export interface ActionsService {}',
        '',
      ].join('\n'),
    );
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'PluginJsonSchema',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'PluginJsonSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'ProtocolComposableSchema',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'ProtocolComposableSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'LocalSchema',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'LocalSchema',
        realm: 'any',
      },
    ]);

    const report = await runApiSurfaceSourceHarnessForTests({ packageRoot: root });
    assert.equal(report.inventory.symbols.some(({ exportName }) => exportName === 'PrivateProtocolSchema'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK Voice runtime public signature closes through the author inventory', async () => {
  const report = await readCurrentPackageSourceReport();

  assert.equal(
    report.inventory.symbols.some((symbol) => (
      symbol.specifier === './voice/client'
      && symbol.exportName === 'RealtimeVoiceProviderRuntime'
      && symbol.kind === 'type'
    )),
    true,
  );
});

test('SDK Action and request-auth signatures publish their named author dependencies', async () => {
  const report = await readCurrentPackageSourceReport();
  const dependenciesBySpecifier = {
    '.': [
      'PluginActionAuthorConfirmation',
    ],
    './actions': [
      'BuiltinWidgetIdV1',
      'CapabilityRulesActionInputById',
      'CapabilityRulesActionResultById',
      'SkillsActionInputById',
      'SkillsActionResultById',
      'RegistriesActionInputById',
      'RegistriesActionResultById',
      'PersonalSavedSecretsActionInputById',
      'PersonalSavedSecretsActionResultById',
      'SessionCapabilitiesActionInputById',
      'SessionCapabilitiesActionResultById',
      'ManagedSessionMcpPortabilityV1',
      'ManagedSessionMcpReasonCodeV1',
    ],
    './connected-accounts': [
      'ConnectedAccountAuthFailureRequestV1',
      'ConnectedAccountQuotaFailureRequestV1',
      'OAuthBearerLeaseV1',
      'QualifiedConnectedAccountPurposeV1',
      'RequestAuthFailureOutcomeV1',
    ],
    './protocol': [
      'TranscriptAnnotationV1',
    ],
    './ui': [
      'PluginUiActionControlEventV1',
      'PluginUiActionControlRequestV1',
      'PluginUiActionControlExecutionV1',
      'PluginUiActionControlPreparationV1',
      'PluginUiActionControlPresentationV1',
    ],
  };

  for (const [specifier, exportNames] of Object.entries(dependenciesBySpecifier)) {
    for (const exportName of exportNames) {
      assert.equal(report.inventory.symbols.some((symbol) => (
        symbol.specifier === specifier
        && symbol.exportName === exportName
        && symbol.kind === 'type'
      )), true, `${specifier} must publish the ${exportName} public signature dependency`);
    }
  }

  // Declaration emit must be able to name the DTO itself, not only a facade
  // alias whose public signature happens to reach the same structural shape.
  for (const exportName of [
    'ActionApprovalRequestCreatedResult',
    'ActionExecuteResult',
    'PluginActionWorkflowAuthoredResultReferenceV1',
    'SessionTranscriptGetExternalShareableInputV1',
    'SessionTranscriptGetExternalShareableResultV1',
    'SessionUsageLimitCheckNowRequestV1Input',
    'SessionUsageLimitConsumeResetCreditRequestV1Input',
  ]) {
    const symbol = report.inventory.symbols.find((entry) => (
      entry.specifier === './actions' && entry.exportName === exportName
    ));
    assert.equal(symbol?.sourceModule, 'src/actions/dtos/pluginActionDtoSupport.generated.ts',
      `${exportName} must expose its canonical DTO identity to external declaration emit`);
    assert.equal(symbol?.sourceExport, exportName);
  }
});

test('SDK Automation occurrence Action maps are available in the authored inventory', async () => {
  const inventory = await apiSurfaceCli.readCurrentApiSurfaceInventory({
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
  });
  for (const exportName of ['AutomationOccurrencesActionInputById', 'AutomationOccurrencesActionResultById']) {
    assert.equal(inventory.symbols.some(symbol => symbol.specifier === './actions'
      && symbol.exportName === exportName && symbol.kind === 'type'), true, exportName);
  }
});

test('SDK Machine reboot Action maps are available in the authored inventory', async () => {
  const inventory = await apiSurfaceCli.readCurrentApiSurfaceInventory({
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
  });
  for (const exportName of ['MachineRebootActionInputById', 'MachineRebootActionResultById']) {
    const symbol = inventory.symbols.find(symbol => symbol.specifier === './actions'
      && symbol.exportName === exportName && symbol.kind === 'type');
    assert.equal(symbol?.sourceModule, 'src/actions/dtos/machineRebootActionDtos.generated.ts', exportName);
    assert.equal(symbol?.sourceExport, exportName);
  }
});

test('SDK workflow Action ingress projection closes through the author inventory', async () => {
  const report = await readCurrentPackageSourceReport();

  assert.deepEqual(
    report.inventory.symbols.find((symbol) => (
      symbol.specifier === './actions'
      && symbol.exportName === 'PluginActionWorkflowIngressBlockV1'
    )),
    {
      specifier: './actions',
      exportName: 'PluginActionWorkflowIngressBlockV1',
      kind: 'type',
      sourceModule: 'src/actions/actionTypeMap.generated.ts',
      sourceExport: 'PluginActionWorkflowIngressBlockV1',
      realm: 'any',
    },
  );
});

test('SDK source inventory assigns Voice exports to the three author publication specs', async () => {
  const report = await readCurrentPackageSourceReport();
  const voiceRows = report.inventory.symbols.filter(({ specifier }) => (
    Object.hasOwn(VOICE_PUBLIC_EXPORTS_BY_ENTRYPOINT, specifier)
  ));

  assert.deepEqual(
    [...new Set(voiceRows.map(({ specifier }) => specifier))].sort(),
    Object.keys(VOICE_PUBLIC_EXPORTS_BY_ENTRYPOINT).sort(),
  );
  for (const [specifier, expectedExports] of Object.entries(VOICE_PUBLIC_EXPORTS_BY_ENTRYPOINT)) {
    assert.deepEqual(
      voiceRows
        .filter((row) => row.specifier === specifier)
        .map(({ exportName }) => exportName)
        .sort(),
      expectedExports,
      `Voice exports drifted for the authoritative ${specifier}/index.public.ts owner`,
    );
  }

  assert.equal(
    voiceRows.some(({ exportName }) => exportName === 'VoiceProviderRuntime'),
    false,
    'the retired generic VoiceProviderRuntime alias must not be published by any Voice spec',
  );
});

test('generic provider limit evidence is published from connected accounts', async () => {
  const inventory = await apiSurfaceCli.readCurrentApiSurfaceInventory();
  const names = [
    'PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1',
    'classifyProviderLimitEvidence',
    'ProviderLimitCategory',
    'ProviderLimitEvidenceClassification',
    'ProviderLimitEvidenceConfidence',
    'ProviderLimitEvidenceContext',
    'ProviderLimitEvidenceProvenance',
  ];
  for (const name of names) {
    const symbol = inventory.symbols.find((row) => (
      row.specifier === './connected-accounts' && row.exportName === name
    ));
    assert.equal(symbol?.sourceModule, 'src/cloud/providerLimitEvidence.ts', name);
    const previous = inventory.symbols.find((row) => (
      row.specifier === './first-party/connected-accounts' && row.exportName === name
    ));
    const identity = (row) => row && ({
      sourceModule: row.sourceModule,
      sourceExport: row.sourceExport,
      kind: row.kind,
      realm: row.realm,
    });
    assert.deepEqual(identity(previous), identity(symbol), `${name} retains the same migration identity`);
  }
  assert.equal(inventory.symbols.find((row) => (
    row.specifier === './collections' && row.exportName === 'projectPluginAccountCollectionDeclaration'
  ))?.sourceModule, 'src/definePlugin.ts');
});

test('client activation testkit is reachable through the public testing entrypoint', async () => {
  const path = new URL('../src/testing/index.public.ts', import.meta.url);
  const source = ts.createSourceFile(path.pathname, await readFile(path, 'utf8'), ts.ScriptTarget.Latest);
  const exports = source.statements.flatMap((statement) => (
    ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause
      && ts.isStringLiteral(statement.moduleSpecifier) && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.map((entry) => ({ name: entry.name.text, source: statement.moduleSpecifier.text }))
      : []
  ));
  assert.deepEqual(exports.filter(({ name }) => name === 'createPluginClientTestkit'), [
    { name: 'createPluginClientTestkit', source: './client.js' },
  ]);
});

test('SDK source inventory keeps the raw mutable manifest input private', async () => {
  const report = await readCurrentPackageSourceReport();
  const manifestTypeExports = report.inventory.symbols
    .filter((symbol) => symbol.specifier === './manifest' && symbol.kind === 'type')
    .map((symbol) => symbol.exportName);

  assert.equal(manifestTypeExports.includes('PluginManifestAuthorInput'), false);
  assert.equal(manifestTypeExports.includes('PluginAgentUiContribution'), true);
  assert.equal(manifestTypeExports.includes('PluginManifest'), true);
});

test('SDK source inventory publishes the review scope producer with its result type', async () => {
  const report = await readCurrentPackageSourceReport();
  const reviewScopeExports = report.inventory.symbols
    .filter((symbol) => (
      symbol.specifier === './reviews'
      && ['ScmPullRequestReviewScopeProductionV1', 'produceScmPullRequestReviewScope'].includes(symbol.exportName)
    ))
    .map(({ exportName, sourceExport, kind, realm }) => ({ exportName, sourceExport, kind, realm }));

  assert.deepEqual(reviewScopeExports, [
    {
      exportName: 'ScmPullRequestReviewScopeProductionV1',
      sourceExport: 'ScmPullRequestReviewScopeProductionV1',
      kind: 'type',
      realm: 'daemon',
    },
    {
      exportName: 'produceScmPullRequestReviewScope',
      sourceExport: 'produceScmPullRequestReviewScope',
      kind: 'value',
      realm: 'daemon',
    },
  ]);
});

test('SDK source inventory assigns client realm ownership to client Action service exports', async () => {
  const report = await readCurrentPackageSourceReport();
  const clientActionTypes = report.inventory.symbols
    .filter((symbol) => (
      symbol.specifier === './actions'
      && symbol.sourceModule === 'src/actions/service.ts'
      && ['PluginClientActionContext', 'PluginClientActionHandler'].includes(symbol.exportName)
    ))
    .map(({ exportName, sourceExport, kind, realm }) => ({ exportName, sourceExport, kind, realm }));

  assert.deepEqual(clientActionTypes, [
    {
      exportName: 'PluginClientActionContext',
      sourceExport: 'PluginClientActionContext',
      kind: 'type',
      realm: 'client',
    },
    {
      exportName: 'PluginClientActionHandler',
      sourceExport: 'PluginClientActionHandler',
      kind: 'type',
      realm: 'client',
    },
  ]);
});

test('SDK source inventory closes Agent runtime signature dependencies through the runtime entrypoint', async () => {
  const report = await readCurrentPackageSourceReport();
  const runtimeTypeExports = report.inventory.symbols
    .filter((symbol) => symbol.specifier === './agents/runtime' && symbol.kind === 'type')
    .map((symbol) => symbol.exportName);

  assert.equal(runtimeTypeExports.includes('AgentDaemonSpawnHooks'), true);
  assert.equal(runtimeTypeExports.includes('AgentDaemonSpawnRuntimeSelectionV1'), true);
  assert.equal(runtimeTypeExports.includes('AgentDaemonSpawnConnectedServicesV1'), true);
  assert.equal(runtimeTypeExports.includes('PluginAgentAcpNativeSessionMcpConfigV2'), true);
  assert.equal(runtimeTypeExports.includes('AgentExecutionRunHostServicesV1'), true);
  assert.equal(runtimeTypeExports.includes('AgentExecutionRunHooksServiceV1'), true);
});

test('SDK source inventory publishes the structural fixture testkit contract without an operation issuer', async () => {
  const report = await readCurrentPackageSourceReport();
  const testkitTypeExports = report.inventory.symbols
    .filter((symbol) => symbol.specifier === './testing' && symbol.kind === 'type')
    .map((symbol) => symbol.exportName);

  assert.equal(testkitTypeExports.includes('PluginTestkit'), true);
  assert.equal(testkitTypeExports.includes('PluginTestkitOptions'), true);
  assert.equal(testkitTypeExports.includes('PluginTestkitAdmittedTargetedOperationIssue'), false);
});

test('real CLI --json is read-only by default and reports the complete source-tooling plan', async () => {
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const barrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    const pathsBefore = (await readdir(root, { recursive: true })).sort();

    const result = runJsonCli(root);
    const repeatedResult = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(repeatedResult.status, 0, repeatedResult.stderr);
    assert.equal(repeatedResult.stdout, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.status, 'drift');
    assert.equal(report.sourceToolingComplete, true);
    assert.equal(Object.hasOwn(report, 'eu3Complete'), false);
    assert.deepEqual(report.materializedPlanOutputs, [
      'apiSurfaceInventory',
      'packageExports',
      'sourceBarrels',
      'authorApiMarkdown',
    ]);
    assert.deepEqual(report.inMemoryPlanOutputs, [
      'authorDeclarationAssertions',
      'testkitAssertions',
    ]);
    assert.deepEqual(report.unmaterializedPlanOutputs, []);
    // The inventory is the producer's own projection of package source rather
    // than an entry of the plan the inventory drives, so it is materialized
    // without appearing in `generationPlan`. Everything else is accounted for.
    assert.deepEqual(
      [...report.materializedPlanOutputs, ...report.inMemoryPlanOutputs]
        .filter((owner) => owner !== 'apiSurfaceInventory')
        .sort(),
      Object.keys(report.generationPlan).sort(),
    );
    assert.deepEqual(
      report.files.find((file) => file.owner === 'apiSurfaceInventory').path,
      'api-surface.json',
    );
    assert.deepEqual(report.generationPlan.authorDeclarationAssertions, {
      './actions': ['ActionsService'],
    });
    assert.match(report.generationPlan.authorApiMarkdown, /ActionsService/u);
    assert.deepEqual(report.generationPlan.testkitAssertions, {
      './actions': ['ActionsService'],
    });
    // Each fixture barrel still copies its export list. Materialization replaces
    // those lists with forwarders; the inventory is generated on demand.
    assert.deepEqual(
      report.files.filter((file) => file.changed).map((file) => file.owner).sort(),
      [
        'authorApiMarkdown',
        'packageExports',
        'sourceBarrels',
      ],
    );
    assert.equal(
      report.files.find((file) => file.owner === 'apiSurfaceInventory').generated,
      true,
    );
    assert.equal(report.summary.changedFiles, 3);
    assert.equal(report.summary.writtenFiles, 0);
    assert.equal(report.files.find((file) => file.owner === 'authorApiMarkdown').path, 'API.md');

    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), barrelBefore);
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), pathsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit write preflights and materializes exports, barrels, and author API docs', async () => {
  const root = await createPackageFixture();
  try {
    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'write');
    assert.equal(report.status, 'current');
    assert.equal(report.sourceToolingComplete, true);
    assert.equal(Object.hasOwn(report, 'eu3Complete'), false);
    assert.equal(report.summary.changedFiles, 4);
    assert.equal(report.summary.writtenFiles, 4);

    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(packageJson.exports, report.generationPlan.packageExports);
    assert.equal(
      await readFile(join(root, 'src/actions/index.ts'), 'utf8'),
      report.generationPlan.sourceBarrels['src/actions/index.ts'],
    );
    assert.equal(
      await readFile(join(root, 'API.md'), 'utf8'),
      report.generationPlan.authorApiMarkdown,
    );
    assert.doesNotMatch(await readFile(join(root, 'API.md'), 'utf8'), /host\/registration/u);
    assert.doesNotMatch(await readFile(join(root, 'API.md'), 'utf8'), /@since/u);

    const second = runJsonCli(root);
    assert.equal(second.status, 0, second.stderr);
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.summary.changedFiles, 0);
    assert.equal(secondReport.summary.writtenFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source materialization repairs and checks split browser barrel drift', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/actions/index.browser.ts', 'export {};\n');

    const written = await runApiSurfaceMaterializer({ packageRoot: root, write: true });
    assert.equal(written.status, 'current');
    assert.match(
      await readFile(join(root, 'src/actions/index.browser.ts'), 'utf8'),
      /export type \{ ActionsService \} from '\.\/service\.js';/u,
    );
    const current = await runApiSurfaceMaterializer({ packageRoot: root, check: true });
    assert.equal(current.summary.changedFiles, 0);

    await writeFixtureFile(root, 'src/actions/index.browser.ts', 'export {};\n');
    const drifted = await runApiSurfaceMaterializer({ packageRoot: root, check: true });
    assert.ok(drifted.files.some((output) => (
      output.path === 'src/actions/index.browser.ts' && output.changed
    )));
    assert.equal(await readFile(join(root, 'src/actions/index.browser.ts'), 'utf8'), 'export {};\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication mode stamps and retains @since from the immediately prior inventory', async () => {
  const root = await createPackageFixture();
  const firstInventoryPath = join(root, 'published-1.0.0-api-surface.json');
  const secondInventoryPath = join(root, 'published-1.1.0-api-surface.json');
  try {
    const first = runJsonCli(root, ['--write', '--published-version', '1.0.0']);
    assert.equal(first.status, 0, first.stderr);
    await cp(join(root, 'api-surface.json'), firstInventoryPath);

    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export interface ReplacementActionsService {}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      "export type { ReplacementActionsService } from './service.js';\n",
      'utf8',
    );
    const second = runJsonCli(root, [
      '--write',
      '--published-version',
      '1.1.0',
      '--previous-published-inventory',
      firstInventoryPath,
    ]);
    assert.equal(second.status, 0, second.stderr);
    await cp(join(root, 'api-surface.json'), secondInventoryPath);

    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        "export type { ActionsService } from './service.js';",
        "export type { ReplacementActionsService } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );
    const third = runJsonCli(root, [
      '--write',
      '--published-version',
      '1.2.0',
      '--previous-published-inventory',
      secondInventoryPath,
    ]);
    assert.equal(third.status, 0, third.stderr);
    const thirdReport = JSON.parse(third.stdout);
    assert.deepEqual(thirdReport.publication, {
      publishedVersion: '1.2.0',
      previousPublishedInventoryPath: secondInventoryPath,
    });

    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(
      inventory.symbols
        .filter((symbol) => symbol.specifier === './actions')
        .map(({ exportName, since }) => ({ exportName, since })),
      [
        { exportName: 'ActionsService', since: '1.2.0' },
        { exportName: 'ReplacementActionsService', since: '1.1.0' },
      ],
    );
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), "export * from './index.public.js';\n");
    assert.match(
      await readFile(join(root, 'API.md'), 'utf8'),
      /\| `\.\/actions` \| `ReplacementActionsService` \| type \| any \| 1\.1\.0 \|/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary source checks do not retain publisher-owned @since', async () => {
  const root = await createPackageFixture();
  try {
    const published = runJsonCli(root, ['--write', '--published-version', '1.0.0']);
    assert.equal(published.status, 0, published.stderr);
    const ordinaryCheck = runJsonCli(root, ['--check']);
    assert.equal(ordinaryCheck.status, 1, ordinaryCheck.stderr);
    const ordinaryReport = JSON.parse(ordinaryCheck.stdout);
    assert.equal(ordinaryReport.status, 'drift');
    assert.ok(ordinaryReport.summary.changedFiles > 0);

    const ordinaryWrite = runJsonCli(root, ['--write']);
    assert.equal(ordinaryWrite.status, 0, ordinaryWrite.stderr);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.equal(inventory.symbols.some((symbol) => Object.hasOwn(symbol, 'since')), false);
    assert.doesNotMatch(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), /@since/u);
    assert.doesNotMatch(await readFile(join(root, 'API.md'), 'utf8'), /1\.0\.0/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary checks leave all source symbols unstamped after a publication-shaped write', async () => {
  const root = await createPackageFixture();
  try {
    const published = runJsonCli(root, ['--write', '--published-version', '1.0.0']);
    assert.equal(published.status, 0, published.stderr);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export interface UnpublishedActionsService {}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        "export type { ActionsService } from './service.js';",
        "export type { UnpublishedActionsService } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );

    const ordinaryWrite = runJsonCli(root, ['--write']);
    assert.equal(ordinaryWrite.status, 0, ordinaryWrite.stderr);
    const actionSymbols = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'))
      .symbols
      .filter((symbol) => symbol.specifier === './actions')
      .map(({ exportName, since }) => ({ exportName, since }));
    assert.deepEqual(actionSymbols, [
      { exportName: 'ActionsService', since: undefined },
      { exportName: 'UnpublishedActionsService', since: undefined },
    ]);

    const ordinaryCheck = runJsonCli(root, ['--check']);
    assert.equal(ordinaryCheck.status, 0, ordinaryCheck.stderr);
    assert.equal(JSON.parse(ordinaryCheck.stdout).status, 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication mode rejects missing or unsafe previous-inventory inputs before writing', async () => {
  const root = await createPackageFixture();
  const missingPreviousInventoryPath = join(root, 'missing-prior.json');
  const unsafePreviousInventoryPath = join(root, 'unsafe-prior.json');
  try {
    const inventoryBefore = await readFile(join(root, 'api-surface.json'), 'utf8');
    const barrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');

    const missingVersion = runJsonCli(root, [
      '--previous-published-inventory',
      missingPreviousInventoryPath,
    ]);
    assert.equal(missingVersion.status, 1, missingVersion.stdout);
    assert.match(
      missingVersion.stderr,
      /--previous-published-inventory requires --published-version/u,
    );

    const missingInventory = runJsonCli(root, [
      '--write',
      '--published-version',
      '1.1.0',
      '--previous-published-inventory',
      missingPreviousInventoryPath,
    ]);
    assert.equal(missingInventory.status, 1, missingInventory.stdout);
    assert.match(
      missingInventory.stderr,
      /previous published API surface inventory is missing/u,
    );

    await writeFile(unsafePreviousInventoryPath, '{"symbols":[]}', 'utf8');
    const unsafeInventory = runJsonCli(root, [
      '--write',
      '--published-version',
      '1.1.0',
      '--previous-published-inventory',
      unsafePreviousInventoryPath,
    ]);
    assert.equal(unsafeInventory.status, 1, unsafeInventory.stdout);
    assert.match(
      unsafeInventory.stderr,
      /Invalid Plugin SDK API surface/u,
    );

    assert.equal(await readFile(join(root, 'api-surface.json'), 'utf8'), inventoryBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), barrelBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plans the capability matrix through the same atomic output corridor', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const report = await runApiSurfaceCli({
    packageRoot,
    write: false,
    check: false,
  });

  assert.equal(report.materializedPlanOutputs.includes('capabilityMatrix'), true);
  const capabilityFile = report.files.find((file) => file.owner === 'capabilityMatrix');
  assert.equal(capabilityFile?.path, 'capability-matrix.json');
  assert.equal(typeof capabilityFile?.changed, 'boolean');
  assert.equal(capabilityFile?.written, false);
});

test('the finite governance transaction fails on capability-matrix-only drift', async () => {
  // The drift has to be introduced in a copy of this package. Writing the
  // tracked matrix in place made a concurrently running publisher in the same
  // checkout read — or restore over — half-written canonical bytes, so the
  // whole transaction is exercised against governed inputs the test owns.
  const { packageRoot, root } = await createCurrentPackageCopy();
  const trackedMatrixPath = join(packageRoot, 'capability-matrix.json');
  const trackedBefore = await readFile(trackedMatrixPath, 'utf8');
  const trackedStatBefore = await stat(trackedMatrixPath);
  try {
    const matrixPath = join(root, 'capability-matrix.json');
    const current = (await runApiSurfaceCli({ packageRoot: root, write: false, check: true }))
      .files
      .find((file) => file.owner === 'capabilityMatrix');
    assert.equal(current?.path, 'capability-matrix.json');
    assert.equal(current?.changed, false);

    // Mutate only the copied matrix bytes; every declaration input stays untouched.
    await writeFile(matrixPath, `${await readFile(matrixPath, 'utf8')}\n`, 'utf8');
    const drift = await runApiSurfaceCli({ packageRoot: root, write: false, check: true });
    assert.equal(drift.status, 'drift');
    const matrixFile = drift.files.find((file) => file.owner === 'capabilityMatrix');
    assert.equal(matrixFile?.path, 'capability-matrix.json');
    assert.equal(matrixFile?.changed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const trackedStatAfter = await stat(trackedMatrixPath);
  assert.equal(await readFile(trackedMatrixPath, 'utf8'), trackedBefore);
  assert.equal(trackedStatAfter.mtimeMs, trackedStatBefore.mtimeMs);
});

test('plans the public declaration record through the same atomic output corridor', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const report = await runApiSurfaceCli({
    packageRoot,
    write: false,
    check: false,
  });

  assert.equal(report.materializedPlanOutputs.includes('publicDeclarationReport'), true);
  const declarationFile = report.files.find((file) => file.owner === 'publicDeclarationReport');
  assert.equal(declarationFile?.path, 'api-declarations.md');
  assert.equal(typeof declarationFile?.changed, 'boolean');
  assert.equal(declarationFile?.written, false);
});

test('a publication spec must use named package-local re-exports before any output is touched', async () => {
  const root = await createPackageFixture();
  try {
    const generatedBarrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      "export * from './service.js';\n",
      'utf8',
    );
    const malformedPublicationSpec = await readFile(
      join(root, 'src/actions/index.public.ts'),
      'utf8',
    );

    for (const mode of ['--check', '--write']) {
      const result = runJsonCli(root, [mode]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /API surface publication spec src\/actions\/index\.public\.ts must contain only named re-export declarations/u,
      );
    }

    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), generatedBarrelBefore);
    assert.equal(
      await readFile(join(root, 'src/actions/index.public.ts'), 'utf8'),
      malformedPublicationSpec,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication specs reject retired per-symbol posture metadata before any output is touched', async () => {
  const root = await createPackageFixture();
  try {
    const generatedBarrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        '/** @preview */',
        "export type { ActionsService } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );

    for (const mode of ['--check', '--write']) {
      const result = runJsonCli(root, [mode]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /API surface publication spec src\/actions\/index\.public\.ts must not use retired per-symbol @preview posture metadata/u,
      );
    }

    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), generatedBarrelBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publication specs reject publisher-owned @since metadata before any output is touched', async () => {
  const root = await createPackageFixture();
  try {
    const generatedBarrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        '/** @since 0.1.0 */',
        "export type { ActionsService } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );

    for (const mode of ['--check', '--write']) {
      const result = runJsonCli(root, [mode]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /API surface publication spec src\/actions\/index\.public\.ts must not use publisher-owned @since metadata/u,
      );
    }

    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), generatedBarrelBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source inputs reject retired per-symbol posture metadata outside publication specs', async () => {
  const root = await createPackageFixture();
  try {
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        '/** @experimental */',
        'export interface ActionsService {}',
        '',
      ].join('\n'),
      'utf8',
    );

    const directSourceResult = runJsonCli(root, ['--check']);
    assert.equal(directSourceResult.status, 1, directSourceResult.stdout);
    assert.match(
      directSourceResult.stderr,
      /API surface source src\/actions\/service\.ts must not use retired per-symbol @experimental posture metadata/u,
    );

    await writeFile(
      join(root, 'src/actions/service.ts'),
      'export interface ActionsService {}\n',
      'utf8',
    );
    await writeFixtureFile(
      root,
      'src/actions/index.browser.ts',
      [
        '/** @incubating */',
        "export type { ActionsService } from './service.js';",
        '',
      ].join('\n'),
    );

    const browserSourceResult = runJsonCli(root, ['--check']);
    assert.equal(browserSourceResult.status, 1, browserSourceResult.stdout);
    assert.match(
      browserSourceResult.stderr,
      /API surface source src\/actions\/index\.browser\.ts must not use retired per-symbol @incubating posture metadata/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source inputs reject publisher-owned @since metadata outside publication specs', async () => {
  const root = await createPackageFixture();
  try {
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        '/** @since 0.1.0 */',
        'export interface ActionsService {}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--check']);
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /API surface source src\/actions\/service\.ts must not use publisher-owned @since metadata/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit check mode reports generated API documentation drift and passes once current', async () => {
  const root = await createPackageFixture();
  try {
    const drift = runJsonCli(root, ['--check']);

    assert.equal(drift.status, 1, drift.stderr);
    const driftReport = JSON.parse(drift.stdout);
    assert.equal(driftReport.mode, 'check');
    assert.equal(driftReport.status, 'drift');
    assert.equal(driftReport.summary.changedFiles, 3);
    assert.equal(driftReport.files.find((file) => file.path === 'API.md').changed, true);

    const write = runJsonCli(root, ['--write']);
    assert.equal(write.status, 0, write.stderr);

    const current = runJsonCli(root, ['--check']);
    assert.equal(current.status, 0, current.stderr);
    const currentReport = JSON.parse(current.stdout);
    assert.equal(currentReport.mode, 'check');
    assert.equal(currentReport.status, 'current');
    assert.equal(currentReport.summary.changedFiles, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write mode changes nothing when any owned output fails all-output preflight', async () => {
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await rm(join(root, 'api-surface.json'));
    await mkdir(join(root, 'api-surface.json'));

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular file or absent: api-surface\.json/u);
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('API documentation participates in all-output preflight before any write', async () => {
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await mkdir(join(root, 'API.md'));

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular file or absent: API\.md/u);
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('API documentation cannot resolve outside the package root', async () => {
  const root = await createPackageFixture();
  const externalRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-external-docs-'));
  try {
    const externalDocs = join(externalRoot, 'API.md');
    await writeFile(externalDocs, 'external docs\n', 'utf8');
    await symlink(externalDocs, join(root, 'API.md'), process.platform === 'win32' ? 'file' : undefined);

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /regular file or absent: API\.md/u);
    assert.equal(await readFile(externalDocs, 'utf8'), 'external docs\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('API documentation staging failure leaves every owned output unchanged', async () => {
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    // Staging names a temporary file per CHANGED output, so the index the API
    // documentation stages under is derived from the run's own report rather
    // than restated here.
    const plannedReport = JSON.parse(runJsonCli(root).stdout);
    const stagingIndex = plannedReport.files
      .filter((file) => file.changed)
      .findIndex((file) => file.owner === 'authorApiMarkdown');
    assert.ok(stagingIndex >= 0);
    const blockingTemporaryPath = join(
      root,
      `.API.md.api-surface-${process.pid}-${stagingIndex}.tmp`,
    );
    await writeFile(blockingTemporaryPath, 'occupied\n', 'utf8');

    await assert.rejects(
      runApiSurfaceMaterializer({ packageRoot: root, write: true, check: false }),
      (error) => error?.code === 'EEXIST',
    );

    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
    await assert.rejects(readFile(join(root, 'API.md'), 'utf8'), (error) => error?.code === 'ENOENT');
    assert.equal(await readFile(blockingTemporaryPath, 'utf8'), 'occupied\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('later promotion failure restores existing and absent outputs and cleans staging files', async () => {
  const root = await createPackageFixture();
  try {
    const existingDestinations = [
      'package.json',
      'src/actions/index.ts',
    ];
    const originalContents = new Map(await Promise.all(existingDestinations.map(async (path) => [
      path,
      await readFile(join(root, path), 'utf8'),
    ])));
    // Both rollback branches need coverage, so one already-absent destination is
    // promoted before the failing one: the restore path rewrites existing files
    // and unlinks the outputs this run created.
    const originallyAbsentDestinations = ['api-surface.json', 'API.md'];
    await rm(join(root, 'api-surface.json'));
    const promotedDestinations = [];
    const forcedFailure = new Error('forced later API documentation promotion failure');

    await assert.rejects(
      runApiSurfaceMaterializer({
        packageRoot: root,
        write: true,
        check: false,
        renameFile: async (from, to) => {
          if (to === join(root, 'API.md')) throw forcedFailure;
          promotedDestinations.push(to);
          await rename(from, to);
        },
      }),
      forcedFailure,
    );

    assert.ok(promotedDestinations.includes(join(root, 'package.json')));
    assert.ok(promotedDestinations.includes(join(root, originallyAbsentDestinations[0])));
    for (const path of existingDestinations) {
      assert.equal(await readFile(join(root, path), 'utf8'), originalContents.get(path));
    }
    for (const path of originallyAbsentDestinations) {
      await assert.rejects(readFile(join(root, path), 'utf8'), (error) => error?.code === 'ENOENT');
    }
    assert.deepEqual(
      (await readdir(root, { recursive: true })).filter((path) => path.includes('.api-surface-')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an entrypoint publication-spec directory linked outside the physical package root is rejected', async () => {
  // The spec is read from package source, so a directory link that leaves the
  // package would make the run consume foreign author selection bytes.
  const root = await createPackageFixture();
  const externalRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-external-parent-'));
  try {
    const publicationSpecContents = await readFile(
      join(root, 'src/actions/index.public.ts'),
      'utf8',
    );
    await rm(join(root, 'src/actions'), { recursive: true, force: true });
    await writeFile(
      join(externalRoot, 'index.public.ts'),
      publicationSpecContents,
      'utf8',
    );
    await symlink(
      externalRoot,
      join(root, 'src/actions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    for (const mode of ['--check', '--write']) {
      const result = runJsonCli(root, [mode]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /API surface publication-spec directory resolves outside package root: src\/actions/u,
      );
    }

    assert.deepEqual((await readdir(externalRoot)).sort(), ['index.public.ts']);
    assert.equal(
      await readFile(join(externalRoot, 'index.public.ts'), 'utf8'),
      publicationSpecContents,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('portable value closures reject Node builtins in check and write preflight', async (t) => {
  for (const realm of ['any', 'browser', 'react-native']) {
    await t.test(realm, async () => {
      const root = await createPackageFixture();
      try {
        await addPortableValueFixture(
          root,
          realm,
          [
            "import { readFileSync } from 'node:fs';",
            "export function PortableValue(): number { readFileSync('fixture'); return 1; }",
            '',
          ].join('\n'),
        );
        const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
        const barrelBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');

        for (const mode of ['--check', '--write']) {
          const result = runJsonCli(root, [mode]);
          assert.equal(result.status, 1);
          const rejectedClosureRealm = realm === 'any' ? 'browser' : realm;
          assert.match(
            result.stderr,
            new RegExp(
              `API surface ${rejectedClosureRealm} value closure .* reaches Node builtin node:fs`,
              'u',
            ),
          );
        }
        assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
        assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), barrelBefore);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('type-only browser projections do not acquire a runtime realm closure', async () => {
  const root = await createPackageFixture();
  try {
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    inventory.entrypoints[0].realm = 'browser';
    inventory.entrypoints[0].conditions.browser = './dist/actions/index.js';
    await writeFile(join(root, 'api-surface.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { Stats } from 'node:fs';",
        'type LocalOnlyStats = Stats;',
        'export interface ActionsService { stat: number }',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a browser value source does not follow its explicit type-only Node import', async () => {
  const root = await createPackageFixture();
  try {
    await addPortableValueFixture(
      root,
      'browser',
      [
        "import type { Stats } from 'node:fs';",
        'export const PortableValue = 1 satisfies number;',
        'export type PortableStats = Stats;',
        '',
      ].join('\n'),
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser value closures reject a relative edge through a daemon entrypoint', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/daemon/index.public.ts', "export { DaemonValue } from './value.js';\n");
    await writeFixtureFile(root, 'src/daemon/value.ts', '/** @moduleRealm daemon */\nexport const DaemonValue = 1;\n');
    await addPortableValueFixture(
      root,
      'browser',
      [
        "import { DaemonValue } from '../daemon/index.js';",
        'export const PortableValue = DaemonValue;',
        '',
      ].join('\n'),
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API surface browser value closure .* reaches incompatible daemon entrypoint .*daemon/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser value closures follow bare workspace imports under browser conditions', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-workspace-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const sharedRoot = join(workspaceRoot, 'packages/portable-workspace');
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk', 'packages/portable-workspace']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'browser',
      "import { workspaceValue } from '@fixture/portable-workspace';\nexport const PortableValue = workspaceValue;\n",
    );
    await writeFixtureFile(sharedRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/portable-workspace',
      private: true,
      type: 'module',
      exports: {
        '.': {
          browser: './dist/browser.js',
          default: './dist/node.js',
        },
      },
    }, null, 2)}\n`);
    await writeFixtureFile(
      sharedRoot,
      'src/browser.ts',
      "export { workspaceValue } from './nested.js';\n",
    );
    await writeFixtureFile(
      sharedRoot,
      'src/nested.ts',
      "import { readFileSync } from 'node:fs';\nexport const workspaceValue = readFileSync;\n",
    );
    await writeFixtureFile(
      sharedRoot,
      'src/node.ts',
      "import { readFileSync } from 'node:fs';\nexport const workspaceValue = readFileSync;\n",
    );
    await mkdir(join(workspaceRoot, 'node_modules/@fixture'), { recursive: true });
    await symlink(
      sharedRoot,
      join(workspaceRoot, 'node_modules/@fixture/portable-workspace'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const rejected = runJsonCli(root, ['--write']);

    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /API surface browser value closure .* reaches Node builtin node:fs/u,
    );
    assert.match(rejected.stderr, /@fixture\/portable-workspace\/src\/nested\.ts/u);

    await writeFile(
      join(sharedRoot, 'src/nested.ts'),
      'export const workspaceValue = 1;\n',
      'utf8',
    );
    const accepted = runJsonCli(root);
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('browser and React Native value closures inspect ordinary installed package exports', async (t) => {
  for (const realm of ['browser', 'react-native']) {
    await t.test(realm, async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-installed-'));
      const root = join(workspaceRoot, 'packages/plugin-sdk');
      const installedRoot = join(workspaceRoot, 'node_modules/@fixture/portable-installed');
      try {
        await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
        await createPackageFixture(root);
        await addPortableValueFixture(
          root,
          realm,
          "import { installedValue } from '@fixture/portable-installed';\nexport const PortableValue = installedValue;\n",
        );
        await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
          name: '@fixture/portable-installed',
          type: 'module',
          exports: {
            '.': {
              [realm]: './portable.js',
              default: './node.js',
            },
          },
        }, null, 2)}\n`);
        await writeFixtureFile(
          installedRoot,
          'portable.js',
          "import { readFileSync } from 'node:fs';\nexport const installedValue = readFileSync;\n",
        );
        await writeFixtureFile(installedRoot, 'node.js', 'export const installedValue = 1;\n');

        const result = runJsonCli(root);

        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          new RegExp(`API surface ${realm} value closure .* reaches Node builtin node:fs`, 'u'),
        );
        assert.match(result.stderr, /@fixture\/portable-installed\/portable\.js/u);
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
});

test('client value closures independently inspect browser and React Native package conditions', async (t) => {
  for (const unsafeRealm of ['browser', 'react-native']) {
    await t.test(unsafeRealm, async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-client-'));
      const root = join(workspaceRoot, 'packages/plugin-sdk');
      const installedRoot = join(workspaceRoot, 'node_modules/@fixture/client-installed');
      try {
        await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
        await createPackageFixture(root);
        await addPortableValueFixture(
          root,
          'client',
          "import { installedValue } from '@fixture/client-installed';\nexport const PortableValue = installedValue;\n",
        );
        await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
          name: '@fixture/client-installed',
          type: 'module',
          exports: {
            '.': {
              browser: './browser.js',
              'react-native': './react-native.js',
              default: './default.js',
            },
          },
        }, null, 2)}\n`);
        for (const realm of ['browser', 'react-native']) {
          await writeFixtureFile(
            installedRoot,
            `${realm}.js`,
            realm === unsafeRealm
              ? "import { readFileSync } from 'node:fs';\nexport const installedValue = readFileSync;\n"
              : 'export const installedValue = 1;\n',
          );
        }
        await writeFixtureFile(installedRoot, 'default.js', 'export const installedValue = 1;\n');

        const result = runJsonCli(root);

        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          new RegExp(`API surface ${unsafeRealm} value closure .* reaches Node builtin node:fs`, 'u'),
        );
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
});

test('portable value closures honor an installed package disabled browser builtin without hiding other builtins', async (t) => {
  for (const realm of ['browser', 'react-native']) {
    await t.test(realm, async () => {
      const root = await createPackageFixture();
      const installedRoot = join(root, 'node_modules/@fixture/portable-installed');
      try {
        await addPortableValueFixture(
          root,
          realm,
          "import { installedValue } from '@fixture/portable-installed';\nexport const PortableValue = installedValue;\n",
        );
        await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
          name: '@fixture/portable-installed',
          main: 'index.js',
          browser: { crypto: false },
        }, null, 2)}\n`);
        await writeFixtureFile(installedRoot, 'index.js', "const crypto = require('crypto');\nexports.installedValue = crypto;\n");

        const accepted = runJsonCli(root);
        assert.equal(accepted.status, 0, accepted.stderr);

        if (realm === 'react-native') {
          await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
            name: '@fixture/portable-installed',
            main: 'index.js',
            browser: { crypto: false },
            'react-native': { crypto: 'crypto' },
          }, null, 2)}\n`);
          const nativeOverride = runJsonCli(root);
          assert.equal(nativeOverride.status, 1);
          assert.match(nativeOverride.stderr, /reaches Node builtin crypto/u);
        }

        await writeFixtureFile(installedRoot, 'index.js', "exports.installedValue = require('node:fs');\n");
        const rejected = runJsonCli(root, ['--write']);
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /reaches Node builtin node:fs/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('browser value closures accept a safe installed package selected by browser conditions', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-installed-safe-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const installedRoot = join(workspaceRoot, 'node_modules/@fixture/portable-installed');
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'browser',
      "import { installedValue } from '@fixture/portable-installed';\nexport const PortableValue = installedValue;\n",
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/portable-installed',
      type: 'module',
      exports: {
        '.': {
          browser: './browser.js',
          default: './node.js',
        },
      },
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'browser.js', 'export const installedValue = 1;\n');
    await writeFixtureFile(
      installedRoot,
      'node.js',
      "import { readFileSync } from 'node:fs';\nexport const installedValue = readFileSync;\n",
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime dependency wildcard exports preserve conditional targets and Node specificity', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-wildcard-exports-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const installedRoot = join(workspaceRoot, 'node_modules/@fixture/wildcard-exports');
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(root, 'any', [
      "import { installedValue as locale } from '@fixture/wildcard-exports/locales/en.js';",
      "import { installedValue as nested } from '@fixture/wildcard-exports/locales/nested/en.js';",
      "import { installedValue as exact } from '@fixture/wildcard-exports/locales/exact.js';",
      'export const PortableValue = locale + nested + exact;',
    ].join('\n'));
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/wildcard-exports',
      type: 'module',
      exports: {
        './locales/*': './unsafe.js',
        './locales/*.js': { import: './safe/*.js', default: './unsafe.js' },
        './locales/nested/*': './safe/*',
        './locales/exact.js': './safe/en.js',
      },
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'safe/en.js', 'export const installedValue = 1;\n');
    await writeFixtureFile(installedRoot, 'unsafe.js', "import { readFileSync } from 'node:fs';\nexport const installedValue = readFileSync;\n");

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
    const packageJson = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
    packageJson.exports['./locales/en.js'] = null;
    await writeFixtureFile(installedRoot, 'package.json', JSON.stringify(packageJson));
    const blocked = runJsonCli(root);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /cannot resolve runtime package export @fixture\/wildcard-exports\/locales\/en\.js/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('portable dependency export conditions follow declaration order', async (t) => {
  for (const scenario of [
    {
      title: 'rejects an earlier unsafe import before safe client conditions',
      exports: {
        import: './unsafe.js',
        browser: './safe.js',
        'react-native': './safe.js',
        default: './safe.js',
      },
      expectedStatus: 1,
    },
    {
      title: 'accepts an earlier safe import before unsafe client conditions',
      exports: {
        import: './safe.js',
        browser: './unsafe.js',
        'react-native': './unsafe.js',
        default: './unsafe.js',
      },
      expectedStatus: 0,
    },
  ]) {
    await t.test(scenario.title, async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-condition-order-'));
      const root = join(workspaceRoot, 'packages/plugin-sdk');
      const installedRoot = join(workspaceRoot, 'node_modules/@fixture/ordered-conditions');
      try {
        await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
        await createPackageFixture(root);
        await addPortableValueFixture(
          root,
          'any',
          "import { installedValue } from '@fixture/ordered-conditions';\nexport const PortableValue = installedValue;\n",
        );
        await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
          name: '@fixture/ordered-conditions',
          type: 'module',
          exports: { '.': scenario.exports },
        }, null, 2)}\n`);
        await writeFixtureFile(installedRoot, 'safe.js', 'export const installedValue = 1;\n');
        await writeFixtureFile(
          installedRoot,
          'unsafe.js',
          "import { readFileSync } from 'node:fs';\nexport const installedValue = readFileSync;\n",
        );

        const result = runJsonCli(root);

        assert.equal(result.status, scenario.expectedStatus, result.stderr);
        if (scenario.expectedStatus === 1) {
          assert.match(result.stderr, /reaches Node builtin node:fs/u);
        }
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
});

test('browser and any value closures resolve legacy package entry targets without a dot slash', async (t) => {
  for (const { realm, field } of [
    { realm: 'browser', field: 'main' },
    { realm: 'any', field: 'module' },
  ]) {
    await t.test(`${realm} ${field}`, async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-legacy-entry-'));
      const root = join(workspaceRoot, 'packages/plugin-sdk');
      const packageName = `portable-legacy-${field}`;
      const installedRoot = join(workspaceRoot, 'node_modules', packageName);
      try {
        await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
        await createPackageFixture(root);
        await addPortableValueFixture(
          root,
          realm,
          `import { installedValue } from '${packageName}';\nexport const PortableValue = installedValue;\n`,
        );
        await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
          name: packageName,
          type: 'module',
          [field]: 'index.js',
        }, null, 2)}\n`);
        await writeFixtureFile(installedRoot, 'index.js', 'export const installedValue = 1;\n');

        const result = runJsonCli(root);

        assert.equal(result.status, 0, result.stderr);
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }
});

test('daemon value closures resolve trailing-slash legacy package root imports', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-legacy-root-slash-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-legacy-root-slash';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'daemon',
      `import { installedValue } from '${packageName}/';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      type: 'module',
      main: 'entry.js',
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'entry.js', 'export const installedValue = 1;\n');

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('package exports maps do not reinterpret trailing-slash imports as package roots', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-exported-root-slash-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-exported-root-slash';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'daemon',
      `import { installedValue } from '${packageName}/';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      type: 'module',
      exports: { '.': './entry.js' },
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'entry.js', 'export const installedValue = 1;\n');

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /cannot resolve runtime package export portable-exported-root-slash\//u,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('legacy package entry targets cannot escape the runtime package root', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-legacy-escape-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-legacy-escape';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'browser',
      `import { installedValue } from '${packageName}';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      type: 'module',
      main: '../outside.js',
    }, null, 2)}\n`);
    await writeFixtureFile(
      join(workspaceRoot, 'node_modules'),
      'outside.js',
      'export const installedValue = 1;\n',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot resolve runtime package source portable-legacy-escape/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('any value closures resolve extensionless deep subpaths from legacy packages without exports', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-legacy-subpath-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-legacy-subpath';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'any',
      `import { installedValue } from '${packageName}/dist/compile/codegen';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      type: 'module',
      main: 'index.js',
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'index.js', 'export const rootValue = 1;\n');
    await writeFixtureFile(
      installedRoot,
      'dist/compile/codegen.js',
      'export const installedValue = 1;\n',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('value closures resolve conditional wildcard exports without reviving private exact subpaths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-pattern-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-pattern';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(root, 'browser',
      `import { installedValue } from '${packageName}/v4/locales/en.js';\nexport const PortableValue = installedValue;\n`);
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName, type: 'module', exports: {
        './v4/*': './unsafe/*',
        './v4/locales/*': { browser: './v4/locales/*', default: './unsafe/*' },
        './v4/locales/private.js': null,
      },
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'v4/locales/en.js', 'export const installedValue = 1;\n');
    await writeFixtureFile(installedRoot, 'unsafe/locales/en.js',
      "import { readFileSync } from 'node:fs';\nexport const installedValue = readFileSync;\n");
    const accepted = runJsonCli(root);
    assert.equal(accepted.status, 0, accepted.stderr);

    await writeFixtureFile(root, 'src/actions/portableValue.ts',
      `/** @moduleRealm browser */\nimport { installedValue } from '${packageName}/v4/locales/private.js';\nexport const PortableValue = installedValue;\n`);
    await writeFixtureFile(installedRoot, 'v4/locales/private.js', 'export const installedValue = 1;\n');
    const refused = runJsonCli(root);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cannot resolve runtime package export portable-pattern\/v4\/locales\/private\.js/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('package exports maps keep unmapped deep subpaths private', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-private-subpath-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-private-subpath';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'any',
      `import { installedValue } from '${packageName}/private';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      type: 'module',
      exports: { '.': './index.js' },
    }, null, 2)}\n`);
    await writeFixtureFile(installedRoot, 'index.js', 'export const rootValue = 1;\n');
    await writeFixtureFile(installedRoot, 'private.js', 'export const installedValue = 1;\n');

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /cannot resolve runtime package export portable-private-subpath\/private/u,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime closure treats contained JSON requires as data leaves', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-json-leaf-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-json-leaf';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'any',
      `import { installedValue } from '${packageName}';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      main: 'index.js',
    }, null, 2)}\n`);
    await writeFixtureFile(
      installedRoot,
      'index.js',
      "const data = require('./data.json');\nexports.installedValue = data.value;\n",
    );
    await writeFixtureFile(installedRoot, 'data.json', '{"value":1}\n');

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime closure rejects JSON data leaves symlinked outside the runtime package', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-json-link-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-json-external-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const packageName = 'portable-json-link';
  const installedRoot = join(workspaceRoot, 'node_modules', packageName);
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'any',
      `import { installedValue } from '${packageName}';\nexport const PortableValue = installedValue;\n`,
    );
    await writeFixtureFile(installedRoot, 'package.json', `${JSON.stringify({
      name: packageName,
      main: 'index.js',
    }, null, 2)}\n`);
    await writeFixtureFile(
      installedRoot,
      'index.js',
      "const data = require('./data.json');\nexports.installedValue = data.value;\n",
    );
    const externalJson = join(externalRoot, 'data.json');
    await writeFile(externalJson, '{"value":1}\n', 'utf8');
    await symlink(
      externalJson,
      join(installedRoot, 'data.json'),
      process.platform === 'win32' ? 'file' : undefined,
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /value closure resolves outside its package .*\.\/data\.json/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('browser value closures resolve nested installed dependencies transitively', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-installed-nested-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const outerRoot = join(workspaceRoot, 'node_modules/@fixture/portable-outer');
  const nestedRoot = join(outerRoot, 'node_modules/@fixture/portable-nested');
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'browser',
      "import { outerValue } from '@fixture/portable-outer';\nexport const PortableValue = outerValue;\n",
    );
    await writeFixtureFile(outerRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/portable-outer',
      type: 'module',
      exports: { '.': { browser: './browser.js', default: './node.js' } },
    }, null, 2)}\n`);
    await writeFixtureFile(
      outerRoot,
      'browser.js',
      "export { nestedValue as outerValue } from '@fixture/portable-nested';\n",
    );
    await writeFixtureFile(outerRoot, 'node.js', 'export const outerValue = 1;\n');
    await writeFixtureFile(nestedRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/portable-nested',
      type: 'module',
      exports: { '.': { browser: './browser.js', default: './node.js' } },
    }, null, 2)}\n`);
    await writeFixtureFile(
      nestedRoot,
      'browser.js',
      "import { readFileSync } from 'node:fs';\nexport const nestedValue = readFileSync;\n",
    );
    await writeFixtureFile(nestedRoot, 'node.js', 'export const nestedValue = 1;\n');

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API surface browser value closure .* reaches Node builtin node:fs/u,
    );
    assert.match(result.stderr, /@fixture\/portable-nested\/browser\.js/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('browser value closures select require conditions for static CommonJS dependency edges', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-installed-cjs-'));
  const root = join(workspaceRoot, 'packages/plugin-sdk');
  const outerRoot = join(workspaceRoot, 'node_modules/@fixture/portable-cjs-outer');
  const nestedRoot = join(outerRoot, 'node_modules/@fixture/portable-cjs-nested');
  try {
    await createWorkspaceRootFixture(workspaceRoot, ['packages/plugin-sdk']);
    await createPackageFixture(root);
    await addPortableValueFixture(
      root,
      'browser',
      "import outer from '@fixture/portable-cjs-outer';\nexport const PortableValue = outer.outerValue;\n",
    );
    await writeFixtureFile(outerRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/portable-cjs-outer',
      exports: { '.': { browser: './browser.cjs', default: './node.cjs' } },
    }, null, 2)}\n`);
    await writeFixtureFile(
      outerRoot,
      'browser.cjs',
      "module.exports.outerValue = require('@fixture/portable-cjs-nested').nestedValue;\n",
    );
    await writeFixtureFile(outerRoot, 'node.cjs', 'module.exports.outerValue = 1;\n');
    await writeFixtureFile(nestedRoot, 'package.json', `${JSON.stringify({
      name: '@fixture/portable-cjs-nested',
      type: 'module',
      exports: {
        '.': {
          browser: {
            require: './browser.cjs',
            import: './browser.js',
          },
          default: './node.js',
        },
      },
    }, null, 2)}\n`);
    await writeFixtureFile(
      nestedRoot,
      'browser.cjs',
      "const { readFileSync } = require('node:fs');\nmodule.exports.nestedValue = readFileSync;\n",
    );
    await writeFixtureFile(nestedRoot, 'browser.js', 'export const nestedValue = 1;\n');
    await writeFixtureFile(nestedRoot, 'node.js', 'export const nestedValue = 1;\n');

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API surface browser value closure .* reaches Node builtin node:fs/u,
    );
    assert.match(result.stderr, /@fixture\/portable-cjs-nested\/browser\.cjs/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('browser value closures fail closed for unresolved runtime bare imports', async () => {
  const root = await createPackageFixture();
  try {
    await addPortableValueFixture(
      root,
      'browser',
      "import { missingValue } from '@fixture/missing-runtime';\nexport const PortableValue = missingValue;\n",
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /cannot resolve runtime package @fixture\/missing-runtime/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI validates the inventory it projects before planning or writing', async () => {
  // The inventory is projected from source, so an invalid one can only come
  // from invalid source: here a declared export key inside the reserved author
  // namespace. Validation must run before anything is written.
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const inventoryBefore = await readFile(join(root, 'api-surface.json'), 'utf8');
    await writeFixtureFile(root, 'src/internal/tools/index.public.ts', [
      "export type { ActionsService as InternalTool } from '../../actions/service.js';",
      '',
    ].join('\n'));

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /author entrypoint cannot use reserved namespace \.\/internal\/tools/u,
    );
    assert.equal(await readFile(join(root, 'api-surface.json'), 'utf8'), inventoryBefore);
    await assert.rejects(readFile(join(root, 'API.md'), 'utf8'), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the inventory destination is package-owned and cannot be redirected by an option', async () => {
  // The producer derives its destination from the selected package root. A
  // caller-supplied path is not an input, so a stray option can neither be read
  // nor written.
  const root = await createPackageFixture();
  const externalRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-external-inventory-'));
  try {
    const externalInventoryPath = join(externalRoot, 'api-surface.json');
    await writeFile(externalInventoryPath, 'external inventory\n', 'utf8');
    await rm(join(root, 'api-surface.json'));

    const report = await runApiSurfaceMaterializer({
      packageRoot: root,
      inventoryPath: externalInventoryPath,
      write: true,
      check: false,
    });

    assert.equal(report.inventoryPath, join(root, 'api-surface.json'));
    assert.equal(await readFile(externalInventoryPath, 'utf8'), 'external inventory\n');
    assert.match(await readFile(join(root, 'api-surface.json'), 'utf8'), /"schemaVersion": 1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('CLI rejects output parents redirected outside the package by an intermediate link', async () => {
  const root = await createPackageFixture();
  const externalRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-external-output-'));
  try {
    await rm(join(root, 'src'), { recursive: true, force: true });
    await writeFixtureFile(externalRoot, 'actions/index.ts', '// external actions barrel\n');
    await writeFixtureFile(externalRoot, 'actions/service.ts', 'export interface ActionsService {}\n');
    await symlink(externalRoot, join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    // Source preflight may reject the redirected tree before it reaches the
    // output-parent-specific check. The stable contract is a publication-spec
    // rejection with no external write, not a particular preflight phase.
    assert.match(result.stderr, /API surface publication-spec/u);
    assert.equal(
      await readFile(join(externalRoot, 'actions/index.ts'), 'utf8'),
      '// external actions barrel\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('CLI rejects canonical source modules redirected outside the package', async () => {
  const root = await createPackageFixture();
  const externalRoot = await mkdtemp(join(tmpdir(), 'plugin-sdk-api-surface-external-source-'));
  try {
    await writeFixtureFile(externalRoot, 'canonical/service.ts', 'export interface ActionsService {}\n');
    await symlink(
      externalRoot,
      join(root, 'src/actions/redirect'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFixtureFile(root, 'src/actions/index.public.ts', [
      "export type { ActionsService } from './redirect/canonical/service.js';",
      '',
    ].join('\n'));
    const publicationSpecBefore = await readFile(join(root, 'src/actions/index.public.ts'), 'utf8');

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    // Keep this at the public rejection category: preflight ordering is an
    // implementation detail, while a nonzero result and no rewritten spec are
    // the safety contract.
    assert.match(result.stderr, /API surface publication-spec/u);
    assert.equal(
      await readFile(join(root, 'src/actions/index.public.ts'), 'utf8'),
      publicationSpecBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('CLI rejects missing and wrong-kind canonical source projections before writing', async () => {
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    // The publication spec is the deliberately broken input here, so the
    // "unchanged" baseline is the broken spec itself: a rejected run rewrites
    // nothing.
    await writeFixtureFile(root, 'src/actions/index.public.ts', [
      "export type { MissingActionsService } from './service.js';",
      '',
    ].join('\n'));
    const missingPublicationSpec = await readFile(join(root, 'src/actions/index.public.ts'), 'utf8');

    const missing = runJsonCli(root, ['--write']);

    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /canonical source src\/actions\/service\.ts does not export MissingActionsService/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(
      await readFile(join(root, 'src/actions/index.public.ts'), 'utf8'),
      missingPublicationSpec,
    );

    await writeFixtureFile(root, 'src/actions/index.public.ts', [
      "export { ActionsService } from './service.js';",
      '',
    ].join('\n'));
    const wrongKindPublicationSpec = await readFile(join(root, 'src/actions/index.public.ts'), 'utf8');

    const wrongKind = runJsonCli(root, ['--write']);

    assert.equal(wrongKind.status, 1);
    assert.match(
      wrongKind.stderr,
      /canonical export src\/actions\/service\.ts#ActionsService does not provide value kind/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(
      await readFile(join(root, 'src/actions/index.public.ts'), 'utf8'),
      wrongKindPublicationSpec,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects a host type in an author value signature', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type UnlistedAuthorType = Readonly<{ id: string; secret?: string }>;\n');
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'createActionsService',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'createActionsService',
      realm: 'any',
    },
    ]);
    // Publishing rewrites the entrypoint barrel, so the "unchanged" baseline is
    // taken after the fixture finishes publishing.
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { UnlistedAuthorType } from '../host/private.js';",
        'export interface ActionsService {}',
        'export declare function createActionsService(input: UnlistedAuthorType): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /author value src\/actions\/service\.ts#createActionsService public signature references author type UnlistedAuthorType, which is absent from the author inventory/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);

    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export type UnlistedAuthorType = Readonly<{ id: string }>;',
        'export interface ActionsService {}',
        'export declare function createActionsService(input: UnlistedAuthorType): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );
    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'UnlistedAuthorType',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'UnlistedAuthorType',
      realm: 'any',
    }]);

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects host types in public type members', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenMember = Readonly<{ id: string; secret?: string }>;\n');
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'PublicOptions',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'PublicOptions',
      realm: 'any',
    },
    ]);
    // Publishing rewrites the entrypoint barrel, so the "unchanged" baseline is
    // taken after the fixture finishes publishing.
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { HiddenMember } from '../host/private.js';",
        'export interface ActionsService {}',
        'export type PublicOptions = Readonly<{ hidden: HiddenMember }>;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /author type src\/actions\/service\.ts#PublicOptions public signature references author type HiddenMember, which is absent from the author inventory/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);

    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export type HiddenMember = Readonly<{ id: string }>;',
        'export interface ActionsService {}',
        'export type PublicOptions = Readonly<{ hidden: HiddenMember }>;',
        '',
      ].join('\n'),
      'utf8',
    );
    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'HiddenMember',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'HiddenMember',
      realm: 'any',
    }]);

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI treats an inventoried direct type alias as covering its exact target identity', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'PublicAlias',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'PublicAlias',
      realm: 'any',
    },
    ]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'type HiddenTarget = Readonly<{ id: string }>;',
        'export type PublicAlias = HiddenTarget;',
        'export interface ActionsService { read(): HiddenTarget; }',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI does not admit nested host members through an inventoried direct alias', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenMember = Readonly<{ id: string; secret?: string }>;\n');
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'PublicAlias',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'PublicAlias',
      realm: 'any',
    },
    ]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { HiddenMember } from '../host/private.js';",
        'type HiddenTarget = Readonly<{ member: HiddenMember }>;',
        'export type PublicAlias = HiddenTarget;',
        'export interface ActionsService { read(): HiddenMember; }',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /ActionsService public signature references author type HiddenMember, which is absent from the author inventory/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects an import type that reaches a host declaration', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenType = Readonly<{ id: string; secret?: string }>;\n');
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'PublicAlias',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'PublicAlias',
      realm: 'any',
    },
    ]);
    // Publishing rewrites the entrypoint barrel, so the "unchanged" baseline is
    // taken after the fixture finishes publishing.
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/hidden.ts'),
      [
        "export type { HiddenType } from '../host/private.js';",
        "import type { HiddenType } from '../host/private.js';",
        'export declare const hiddenValue: HiddenType;',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        "export type PublicAlias = import('./hidden.js').HiddenType;",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /author type src\/actions\/service\.ts#PublicAlias public signature references author type HiddenType, which is absent from the author inventory/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);

    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        "export type PublicAlias = typeof import('./hidden.js').hiddenValue;",
        '',
      ].join('\n'),
      'utf8',
    );

    const valueQueryRefused = runJsonCli(root);

    assert.equal(valueQueryRefused.status, 1, 'a type query must not conceal a host type');
    assert.match(valueQueryRefused.stderr, /public signature references author type HiddenType/u);

    await writeFixtureFile(root, 'src/actions/hidden.ts',
      'export type HiddenType = Readonly<{ id: string }>;\nexport declare const hiddenValue: HiddenType;\n');
    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'HiddenType',
      kind: 'type',
      sourceModule: 'src/actions/hidden.ts',
      sourceExport: 'HiddenType',
      realm: 'any',
    }]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        "export type PublicAlias = import('./hidden.js').HiddenType;",
        '',
      ].join('\n'),
      'utf8',
    );

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects host types named by public class and inferred object members', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenMember = Readonly<{ id: string; secret?: string }>;\n');
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'PublicError',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'PublicError',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'publicObject',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'publicObject',
        realm: 'any',
      },
    ]);
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { HiddenMember } from '../host/private.js';",
        'export interface ActionsService {}',
        'export declare class PublicError { readonly hidden: HiddenMember; }',
        'export const publicObject = {',
        "  read(): HiddenMember { return { id: 'fixture' }; },",
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /author type .*#PublicError .*HiddenMember/u);
    assert.match(result.stderr, /author value .*#publicObject .*HiddenMember/u);
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);

    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export type HiddenMember = Readonly<{ id: string }>;',
        'export interface ActionsService {}',
        'export declare class PublicError { readonly hidden: HiddenMember; }',
        'export const publicObject = {',
        "  read(): HiddenMember { return { id: 'fixture' }; },",
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'HiddenMember',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'HiddenMember',
      realm: 'any',
    }]);

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI closes selected indexed members without treating unrelated host members as public', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts',
      'export interface HiddenMember { readonly id: string }\n');
    await writeFixtureFile(root, 'src/actions/service.ts', [
      "import type { HiddenMember } from '../host/private.js';",
      'type Context = { selected: { visible: string }; unrelated: HiddenMember };',
      "export type ActionsService = NonNullable<Context['selected']>;",
      '',
    ].join('\n'));

    const accepted = runJsonCli(root);
    assert.equal(accepted.status, 0, accepted.stderr);

    await writeFixtureFile(root, 'src/actions/service.ts', [
      "import type { HiddenMember } from '../host/private.js';",
      'type Context<T> = { selected: T; unrelated: { visible: string } };',
      "export type ActionsService = NonNullable<Context<HiddenMember>['selected']>;",
      '',
    ].join('\n'));

    const rejected = runJsonCli(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /public signature references author type HiddenMember/u);

    await writeFixtureFile(root, 'src/actions/service.ts', [
      "export type ActionsService = import('../host/private.js').HiddenMember['id'];",
      '',
    ].join('\n'));
    const hostOwner = runJsonCli(root);
    assert.equal(hostOwner.status, 1, 'a member projection must not admit a host-owned type');
    assert.match(hostOwner.stderr, /public signature references author type HiddenMember/u);

    await writeFixtureFile(root, 'src/actions/service.ts', [
      "import type { HiddenMember } from '../host/private.js';",
      'type LocalAlias = HiddenMember;',
      "export type ActionsService = LocalAlias['id'];",
      '',
    ].join('\n'));
    const aliasedHostOwner = runJsonCli(root);
    assert.equal(aliasedHostOwner.status, 1, 'a local alias must preserve host ownership');
    assert.match(aliasedHostOwner.stderr, /public signature references author type HiddenMember/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI closes annotated recursive type queries without instantiating growing generic signatures', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts',
      'export interface HiddenMember { readonly id: string }\n');
    await writeFixtureFile(root, 'src/actions/service.ts', [
      'declare function recursive<T>(): { next: typeof recursive<readonly T[]> };',
      'export type ActionsService = ReturnType<typeof recursive>;',
      '',
    ].join('\n'));

    const accepted = runJsonCli(root);
    assert.equal(accepted.status, 0, accepted.stderr);

    await writeFixtureFile(root, 'src/actions/service.ts', [
      "import type { HiddenMember } from '../host/private.js';",
      'declare function recursive<T>(): { next: typeof recursive<readonly T[]> };',
      'declare function recursive<T>(input: HiddenMember): { next: typeof recursive<readonly T[]> };',
      'export type ActionsService = ReturnType<typeof recursive>;',
      '',
    ].join('\n'));

    const rejected = runJsonCli(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /public signature references author type HiddenMember/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI terminates on recursive values without hiding host annotation types', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenMember = Readonly<{ id: string; secret?: string }>;\n');
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'RecursiveSchema',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'RecursiveSchema',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'recursiveValue',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'recursiveValue',
        realm: 'any',
      },
    ]);
    await writeFile(join(root, 'src/actions/extra.ts'), 'export const unrelated = true;\n', 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "export * from './extra.js';",
        "import type { HiddenMember } from '../host/private.js';",
        'export interface ActionsService {}',
        'export interface RecursiveSchema<TValue> {',
        '  parse(value: unknown): TValue;',
        '  optional(): RecursiveSchema<TValue | undefined>;',
        '  array(): RecursiveSchema<readonly TValue[]>;',
        '}',
        'export declare const recursiveValue: RecursiveSchema<HiddenMember>;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /recursiveValue public signature references author type HiddenMember, which is absent from the author inventory/u,
    );

    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'HiddenMember',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'HiddenMember',
      realm: 'any',
    }]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "export * from './extra.js';",
        'export type HiddenMember = Readonly<{ id: string }>;',
        'export interface ActionsService {}',
        'export interface RecursiveSchema<TValue> {',
        '  parse(value: unknown): TValue;',
        '  optional(): RecursiveSchema<TValue | undefined>;',
        '  array(): RecursiveSchema<readonly TValue[]>;',
        '}',
        'export declare const recursiveValue: RecursiveSchema<HiddenMember>;',
        '',
      ].join('\n'),
      'utf8',
    );

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI terminates on recursive return types without hiding nested host types', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenMember = Readonly<{ id: string; secret?: string }>;\n');
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'recursiveFunction',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'recursiveFunction',
        realm: 'any',
      },
    ]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { HiddenMember } from '../host/private.js';",
        'export interface ActionsService {}',
        'export type RecursiveSchema<TValue> = Readonly<{',
        '  parse(value: unknown): TValue;',
        '  optional(): RecursiveSchema<TValue | undefined>;',
        '  array(): RecursiveSchema<readonly TValue[]>;',
        '}>;',
        'export function recursiveFunction<TOutput>(',
        '  valueSchema: RecursiveSchema<TOutput>,',
        '): RecursiveSchema<Readonly<Record<string, TOutput & HiddenMember>>> {',
        "  throw new Error('fixture');",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /recursiveFunction public signature references author type HiddenMember, which is absent from the author inventory/u,
    );

    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'RecursiveSchema',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'RecursiveSchema',
      realm: 'any',
    }]);
    const hiddenResult = runJsonCli(root);

    assert.equal(hiddenResult.status, 1);
    assert.match(
      hiddenResult.stderr,
      /recursiveFunction public signature references author type HiddenMember, which is absent from the author inventory/u,
    );

    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'HiddenMember',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'HiddenMember',
      realm: 'any',
    }]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export type HiddenMember = Readonly<{ id: string }>;',
        'export interface ActionsService {}',
        'export type RecursiveSchema<TValue> = Readonly<{',
        '  parse(value: unknown): TValue;',
        '  optional(): RecursiveSchema<TValue | undefined>;',
        '  array(): RecursiveSchema<readonly TValue[]>;',
        '}>;',
        'export function recursiveFunction<TOutput>(',
        '  valueSchema: RecursiveSchema<TOutput>,',
        '): RecursiveSchema<Readonly<Record<string, TOutput & HiddenMember>>> {',
        "  throw new Error('fixture');",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI does not treat public generic parameters as inventory-owned named types', async () => {
  const root = await createPackageFixture();
  try {
    const inventory = structuredClone(INVENTORY);
    inventory.symbols.push(
      {
        specifier: './actions',
        exportName: 'PublicOptions',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'PublicOptions',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'createActionsService',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'createActionsService',
        realm: 'any',
      },
    );
    await writeFile(join(root, 'api-surface.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export type PublicOptions<TValue extends object = Readonly<Record<string, never>>> = Readonly<{ value: TValue }>;',
        'export declare function createActionsService<TInput>(input: TInput): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('current author signature closure terminates for recursive public author graphs with a published schema output extractor', async () => {
  const report = await readCurrentPackageSourceReport();

  assert.equal(report.sourceToolingComplete, true);
  assert.deepEqual(
    report.inventory.symbols.find((symbol) => (
      symbol.specifier === './protocol'
      && symbol.exportName === 'ProtocolSchemaOutput'
    )),
    {
      specifier: './protocol',
      exportName: 'ProtocolSchemaOutput',
      kind: 'type',
      sourceModule: 'src/protocol/protocolFacade.ts',
      sourceExport: 'ProtocolSchemaOutput',
      realm: 'any',
    },
  );
});

test('CLI exempts standard library types that have ambient declaration merges', async () => {
  const root = await createPackageFixture();
  try {
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {',
        '  execute(options?: { signal?: AbortSignal }): Promise<void>;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI accepts named types from non-private published third-party packages', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'createActionsService',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'createActionsService',
      realm: 'any',
    },
    ]);
    // Publishing rewrites the entrypoint barrel, so the "unchanged" baseline is
    // taken after the fixture finishes publishing.
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/package.json',
      `${JSON.stringify({
        name: '@fixture/external',
        type: 'module',
        exports: {
          '.': {
            types: './index.d.ts',
            default: './index.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/index.d.ts',
      'export interface ExternalThing { readonly id: string }\n',
    );
    await writeFixtureFile(root, 'node_modules/@fixture/external/index.js', 'export {};\n');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { ExternalThing } from '../../node_modules/@fixture/external/index.js';",
        'export interface ActionsService {}',
        'export declare function createActionsService(input: ExternalThing): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI accepts named types from an explicit published third-party subpath', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'createActionsService',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'createActionsService',
      realm: 'any',
    },
    ]);
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/package.json',
      `${JSON.stringify({
        name: '@fixture/external',
        type: 'module',
        exports: {
          '.': {
            types: './index.d.ts',
            default: './index.js',
          },
          './contracts': {
            types: './contracts.d.ts',
            default: './contracts.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(root, 'node_modules/@fixture/external/index.d.ts', 'export {};\n');
    await writeFixtureFile(root, 'node_modules/@fixture/external/index.js', 'export {};\n');
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/contracts.d.ts',
      'export interface ExternalContract { readonly id: string }\n',
    );
    await writeFixtureFile(root, 'node_modules/@fixture/external/contracts.js', 'export {};\n');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { ExternalContract } from '@fixture/external/contracts';",
        'export interface ActionsService {}',
        'export declare function createActionsService(input: ExternalContract): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects a third-party internal type absent from every published specifier', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'createActionsService',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'createActionsService',
      realm: 'any',
    },
    ]);
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/package.json',
      `${JSON.stringify({
        name: '@fixture/external',
        type: 'module',
        exports: {
          '.': {
            types: './index.d.ts',
            default: './index.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(root, 'node_modules/@fixture/external/index.d.ts', 'export {};\n');
    await writeFixtureFile(root, 'node_modules/@fixture/external/index.js', 'export {};\n');
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/internal.d.ts',
      'export interface ExternalHidden { readonly id: string }\n',
    );
    await writeFixtureFile(root, 'node_modules/@fixture/external/internal.js', 'export {};\n');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { ExternalHidden } from '../../node_modules/@fixture/external/internal.js';",
        'export interface ActionsService {}',
        'export declare function createActionsService(input: ExternalHidden): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /createActionsService public signature references author type ExternalHidden, which is absent from the author inventory/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI stops closure traversal at an importable third-party named value type', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'externalValue',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'externalValue',
      realm: 'any',
    },
    ]);
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/package.json',
      `${JSON.stringify({
        name: '@fixture/external',
        type: 'module',
        exports: {
          '.': {
            types: './index.d.ts',
            default: './index.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(
      root,
      'node_modules/@fixture/external/index.d.ts',
      [
        'interface ExternalHidden { readonly id: string }',
        'export interface ExternalBox { readonly hidden: ExternalHidden }',
        'export declare const externalValue: ExternalBox;',
        '',
      ].join('\n'),
    );
    await writeFixtureFile(root, 'node_modules/@fixture/external/index.js', 'export {};\n');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "export { externalValue } from '@fixture/external';",
        'export interface ActionsService {}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects author signatures that expose unpublished dependency types', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'createActionsService',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'createActionsService',
      realm: 'any',
    },
    ]);
    await writeFixtureFile(
      root,
      'node_modules/@fixture/private-contract/package.json',
      `${JSON.stringify({
        name: '@fixture/private-contract',
        private: true,
        type: 'module',
        exports: {
          '.': {
            types: './index.d.ts',
            default: './index.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(
      root,
      'node_modules/@fixture/private-contract/index.d.ts',
      'export interface PrivateThing { readonly id: string }\n',
    );
    await writeFixtureFile(root, 'node_modules/@fixture/private-contract/index.js', 'export {};\n');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { PrivateThing } from '../../node_modules/@fixture/private-contract/index.js';",
        'export interface ActionsService {}',
        'export declare function createActionsService(input: PrivateThing): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /createActionsService public signature references author type PrivateThing, which is absent from the author inventory/u,
    );

    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export type ProjectedThing = Readonly<{ id: string }>;',
        'export declare function createActionsService(input: ProjectedThing): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );
    await publishFixtureSymbols(root, [{
      specifier: './actions',
      exportName: 'ProjectedThing',
      kind: 'type',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'ProjectedThing',
      realm: 'any',
    }]);

    const accepted = runJsonCli(root);

    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI permits one Preview aggregate to reach another Preview author contract', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'ExperimentalOptions',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'ExperimentalOptions',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'StableAggregate',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'StableAggregate',
        realm: 'any',
      },
    ]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export interface ExperimentalOptions { readonly enabled: boolean }',
        'export interface StableAggregate { readonly options: ExperimentalOptions }',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI permits one Preview callable to reach another Preview author contract', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
      {
        specifier: './actions',
        exportName: 'ExperimentalOptions',
        kind: 'type',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'ExperimentalOptions',
        realm: 'any',
      },
      {
        specifier: './actions',
        exportName: 'stableCallable',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'stableCallable',
        realm: 'any',
      },
    ]);
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export interface ExperimentalOptions { readonly enabled: boolean }',
        'export function stableCallable(options: ExperimentalOptions): void {}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI closes a declaration alias chain without hiding nested host types', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/host/private.ts', 'export type HiddenMember = Readonly<{ id: string; secret?: string }>;\n');
    await publishFixtureSymbols(root, [
      { specifier: './actions', exportName: 'PublicOptions', kind: 'type',
        sourceModule: 'src/actions/service.ts', sourceExport: 'PublicOptions', realm: 'any' },
      { specifier: './actions', exportName: 'createActionsService', kind: 'value',
        sourceModule: 'src/actions/service.ts', sourceExport: 'createActionsService', realm: 'any' },
    ]);
    await writeFile(join(root, 'src/actions/service.ts'), [
      'export interface ActionsService {}',
      'interface CanonicalOptions { readonly enabled: boolean }',
      'type ProjectedOptions = CanonicalOptions;',
      'export type PublicOptions = ProjectedOptions;',
      'export declare function createActionsService(input: CanonicalOptions): ActionsService;',
      '',
    ].join('\n'), 'utf8');
    const result = runJsonCli(root);
    assert.equal(result.status, 0, result.stderr);
    await writeFile(join(root, 'src/actions/service.ts'), [
      'export interface ActionsService {}',
      "import type { HiddenMember } from '../host/private.js';",
      'interface CanonicalOptions { readonly hidden: HiddenMember }',
      'type ProjectedOptions = CanonicalOptions;',
      'export type PublicOptions = ProjectedOptions;',
      'export declare function createActionsService(input: CanonicalOptions): ActionsService;',
      '',
    ].join('\n'), 'utf8');
    const hidden = runJsonCli(root);
    assert.equal(hidden.status, 1, 'publishing an alias chain must not hide unlisted member types');
    assert.match(hidden.stderr, /public signature references author type HiddenMember, which is absent from the author inventory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects workspace dependency types that are absent from the author inventory', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [
{
      specifier: './actions',
      exportName: 'createActionsService',
      kind: 'value',
      sourceModule: 'src/actions/service.ts',
      sourceExport: 'createActionsService',
      realm: 'any',
    },
    ]);
    await writeFixtureFile(
      root,
      'node_modules/@happier-dev/public-contract/package.json',
      `${JSON.stringify({
        name: '@happier-dev/public-contract',
        type: 'module',
        exports: {
          '.': {
            types: './index.d.ts',
            default: './index.js',
          },
        },
      }, null, 2)}\n`,
    );
    await writeFixtureFile(
      root,
      'node_modules/@happier-dev/public-contract/index.d.ts',
      'export interface PublicThing { readonly id: string }\n',
    );
    await writeFixtureFile(root, 'node_modules/@happier-dev/public-contract/index.js', 'export {};\n');
    await writeFixtureFile(
      root,
      'node_modules/@happier-dev/public-contract/internal.d.ts',
      'export interface InternalThing { readonly secret: string }\n',
    );
    await writeFixtureFile(root, 'node_modules/@happier-dev/public-contract/internal.js', 'export {};\n');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        "import type { InternalThing } from '../../node_modules/@happier-dev/public-contract/internal.js';",
        'export interface ActionsService {}',
        'export declare function createActionsService(input: InternalThing): ActionsService;',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /createActionsService public signature references author type InternalThing, which is absent from the author inventory/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects two publication specs that resolve to one package file', async () => {
  // Two source specs reaching one file through a directory link would give a
  // generated output two conflicting source owners.
  const root = await createPackageFixture();
  try {
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await symlink(
      join(root, 'src/actions'),
      join(root, 'src/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /publication specs src\/actions\/index\.public\.ts and src\/link\/index\.public\.ts resolve to the same package file|publication specs src\/link\/index\.public\.ts and src\/actions\/index\.public\.ts resolve to the same package file/u,
    );
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects case-colliding author publication specs before output preflight', async (t) => {
  const root = await createPackageFixture();
  try {
    const caseVariantDirectory = join(root, 'src/Actions');
    try {
      await mkdir(caseVariantDirectory);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        t.skip('the fixture filesystem already enforces case-insensitive path uniqueness');
        return;
      }
      throw error;
    }
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFixtureFile(root, 'src/Actions/service.ts', 'export interface UpperActionsService {}\n');
    await writeFixtureFile(root, 'src/Actions/index.public.ts', [
      "export type { UpperActionsService } from './service.js';",
      '',
    ].join('\n'));

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /publication specifier \.\/Actions has a case-insensitive collision with \.\/actions|publication specifier \.\/actions has a case-insensitive collision with \.\/Actions/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects a canonical source that resolves to a generated barrel', async () => {
  const root = await createPackageFixture();
  try {
    await symlink(
      join(root, 'src'),
      join(root, 'src/link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // The publication spec re-exports through the link back into the generated
    // entrypoint, so its canonical source is a file the run is about to
    // overwrite.
    await writeFixtureFile(root, 'src/actions/index.public.ts', [
      "export type { ActionsService } from '../link/actions/index.js';",
      '',
    ].join('\n'));
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /canonical source .* resolves to generated barrel/u);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects a canonical source that re-exports from its generated entrypoint barrel', async () => {
  const root = await createPackageFixture();
  try {
    const packageJsonBefore = await readFile(join(root, 'package.json'), 'utf8');
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      "export type { ActionsService } from './index.js';\n",
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /canonical source src\/actions\/service\.ts reaches its generated entrypoint barrel src\/actions\/index\.ts/u,
    );
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), packageJsonBefore);
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects a canonical source that imports its generated entrypoint barrel', async () => {
  const root = await createPackageFixture();
  try {
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      "import './index.js';\nexport interface ActionsService {}\n",
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /canonical source src\/actions\/service\.ts reaches its generated entrypoint barrel src\/actions\/index\.ts/u,
    );
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects transitive local source reachability to the generated entrypoint barrel', async () => {
  const root = await createPackageFixture();
  try {
    const actionsBefore = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    await writeFile(
      join(root, 'src/actions/service.ts'),
      "export type { ActionsService } from './bridge.js';\n",
      'utf8',
    );
    await writeFixtureFile(
      root,
      'src/actions/bridge.ts',
      "export type { ActionsService } from './index.js';\n",
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /canonical source src\/actions\/service\.ts reaches its generated entrypoint barrel src\/actions\/index\.ts/u,
    );
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), actionsBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('current Actions canonical source does not reach its generated entrypoint barrel', async () => {
  // Runs the real `src/actions/**` corridor through the producer: the fixture
  // publishes one probe symbol from the shipped canonical module, so the
  // reachability walk covers the module graph this package actually ships
  // without pulling in entrypoints the fixture does not declare.
  const root = await createPackageFixture();
  try {
    await cp(new URL('../src/', import.meta.url), join(root, 'src'), {
      force: true,
      recursive: true,
    });
    // This fixture examines the real Actions source graph but not every
    // currently authored entrypoint. Publication specs are now the topology
    // owner, so remove the copied specs before declaring the fixture's one
    // deliberate entrypoint below.
    await Promise.all((await readdir(join(root, 'src'), { recursive: true }))
      .filter((path) => path.endsWith('index.public.ts'))
      .map((path) => rm(join(root, 'src', path))));
    const servicePath = join(root, 'src/actions/service.ts');
    const serviceContents = await readFile(servicePath, 'utf8');
    await writeFile(
      servicePath,
      `${serviceContents}\nexport type ReachabilityProbe = string;\n`,
      'utf8',
    );
    await writeFixtureFile(root, 'src/actions/index.public.ts', [
      "export type { ReachabilityProbe } from './service.js';",
      '',
    ].join('\n'));
    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.ok(inventory.symbols.some((symbol) => (
      symbol.specifier === './actions'
      && symbol.exportName === 'ReachabilityProbe'
      && symbol.sourceModule === 'src/actions/service.ts'
    )));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('projects added and removed author publication-spec exports into generated topology', async () => {
  const root = await createPackageFixture();
  try {
    await writeFile(
      join(root, 'src/actions/service.ts'),
      'export interface ActionsService {}\nexport interface ActionOutcome {}\n',
      'utf8',
    );
    // The author publishes a symbol through the named-reexport publication
    // spec. `api-surface.json` records that source selection, so the new
    // symbol must survive a regeneration.
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        "export type { ActionOutcome } from './service.js';",
        "export type { ActionsService } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.ok(
      inventory.symbols.some((symbol) => (
        symbol.specifier === './actions'
        && symbol.exportName === 'ActionOutcome'
        && symbol.kind === 'type'
        && symbol.sourceModule === 'src/actions/service.ts'
      )),
      `api-surface.json dropped the published symbol: ${JSON.stringify(inventory.symbols)}`,
    );
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), "export * from './index.public.js';\n");

    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        "export type { ActionOutcome } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );
    const removed = runJsonCli(root, ['--write']);
    assert.equal(removed.status, 0, removed.stderr);
    const removedInventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.equal(
      removedInventory.symbols.some((symbol) => (
        symbol.specifier === './actions' && symbol.exportName === 'ActionsService'
      )),
      false,
    );
    assert.equal(await readFile(join(root, 'src/actions/index.ts'), 'utf8'), "export * from './index.public.js';\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derives added and removed entrypoint topology solely from author-owned publication specs', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/webhooks.ts', [
      'export type PluginWebhookEndpointIdV1 = string;',
      'export const PluginWebhookEndpointIdV1Schema = { parse: (value) => value };',
      "export const PluginWebhookEndpointIdV1JsonSchema = { type: 'string' };",
      'export type PluginWebhookEndpointPrivateState = Readonly<{ secret: string }>;',
      '',
    ].join('\n'));
    await writeFixtureFile(root, 'src/webhooks/index.public.ts', [
      "export type { PluginWebhookEndpointIdV1 } from '../webhooks.js';",
      "export { PluginWebhookEndpointIdV1Schema } from '../webhooks.js';",
      "export { PluginWebhookEndpointIdV1JsonSchema } from '../webhooks.js';",
      '',
    ].join('\n'));
    const publicationSpecBefore = await readFile(join(root, 'src/webhooks/index.public.ts'), 'utf8');

    // `package.json` is a generated output. A newly authored spec must add an
    // entrypoint even while the previous package output knows nothing about it.
    const added = runJsonCli(root, ['--write']);

    assert.equal(added.status, 0, added.stderr);
    const addedPackageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(addedPackageJson.exports['./webhooks'], {
      'happier-source': './src/webhooks/index.ts',
      types: './dist/webhooks/index.d.ts',
      default: './dist/webhooks/index.js',
    });
    const addedInventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.equal(
      addedInventory.entrypoints.some((entrypoint) => entrypoint.specifier === './webhooks'),
      true,
    );
    assert.equal(
      addedInventory.symbols.some((symbol) => (
        symbol.specifier === './webhooks'
        && symbol.exportName === 'PluginWebhookEndpointPrivateState'
      )),
      false,
    );
    assert.equal(await readFile(join(root, 'src/webhooks/index.ts'), 'utf8'), "export * from './index.public.js';\n");
    assert.equal(
      await readFile(join(root, 'src/webhooks/index.public.ts'), 'utf8'),
      publicationSpecBefore,
    );

    // Once it has been materialized, the old package export must not keep a
    // removed source spec alive as a second topology owner.
    await rm(join(root, 'src/webhooks/index.public.ts'));
    const removed = runJsonCli(root, ['--write']);

    assert.equal(removed.status, 0, removed.stderr);
    const removedPackageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(Object.hasOwn(removedPackageJson.exports, './webhooks'), false);
    const removedInventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.equal(
      removedInventory.entrypoints.some((entrypoint) => entrypoint.specifier === './webhooks'),
      false,
    );
    assert.equal(
      removedInventory.symbols.some((symbol) => symbol.specifier === './webhooks'),
      false,
    );
    assert.doesNotMatch(await readFile(join(root, 'API.md'), 'utf8'), /\.\/webhooks/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derives a generated subpath barrel from its author-owned publication spec instead of stale barrel bytes', async () => {
  const root = await createPackageFixture();
  try {
    await writeFixtureFile(root, 'src/webhooks.ts', [
      'export type PluginWebhookEndpointIdV1 = string;',
      'export const PluginWebhookEndpointIdV1Schema = { parse: (value) => value };',
      "export const PluginWebhookEndpointIdV1JsonSchema = { type: 'string' };",
      'export type PluginWebhookEndpointPrivateState = Readonly<{ secret: string }>;',
      '',
    ].join('\n'));
    await writeFixtureFile(root, 'src/webhooks/index.public.ts', [
      "export type { PluginWebhookEndpointIdV1 } from '../webhooks.js';",
      "export { PluginWebhookEndpointIdV1Schema } from '../webhooks.js';",
      "export { PluginWebhookEndpointIdV1JsonSchema } from '../webhooks.js';",
      '',
    ].join('\n'));
    const publicationSpecBefore = await readFile(join(root, 'src/webhooks/index.public.ts'), 'utf8');
    // This is a previous generator output: it advertises the retired alias and
    // lacks every current V1 declaration. A regeneration must not use it as an
    // input, because it is also one of the files the transaction replaces.
    await writeFixtureFile(root, 'src/webhooks/index.ts', [
      "export type { PluginWebhookEndpointId } from '../webhooks.js';",
      '',
    ].join('\n'));

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    assert.deepEqual(
      inventory.symbols
        .filter((symbol) => symbol.specifier === './webhooks')
        .map(({ exportName, kind, sourceModule, sourceExport }) => ({
          exportName,
          kind,
          sourceModule,
          sourceExport,
        })),
      [
        {
          exportName: 'PluginWebhookEndpointIdV1',
          kind: 'type',
          sourceModule: 'src/webhooks.ts',
          sourceExport: 'PluginWebhookEndpointIdV1',
        },
        {
          exportName: 'PluginWebhookEndpointIdV1JsonSchema',
          kind: 'value',
          sourceModule: 'src/webhooks.ts',
          sourceExport: 'PluginWebhookEndpointIdV1JsonSchema',
        },
        {
          exportName: 'PluginWebhookEndpointIdV1Schema',
          kind: 'value',
          sourceModule: 'src/webhooks.ts',
          sourceExport: 'PluginWebhookEndpointIdV1Schema',
        },
      ],
    );
    const barrel = await readFile(join(root, 'src/webhooks/index.ts'), 'utf8');
    assert.equal(barrel, "export * from './index.public.js';\n");
    assert.equal(
      await readFile(join(root, 'src/webhooks/index.public.ts'), 'utf8'),
      publicationSpecBefore,
    );
    const authorApi = await readFile(join(root, 'API.md'), 'utf8');
    assert.match(authorApi, /PluginWebhookEndpointIdV1/u);
    assert.doesNotMatch(authorApi, /PluginWebhookEndpointId\b|PluginWebhookEndpointPrivateState/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('projects package-level Developer Preview source without per-symbol posture while retaining structured deprecations', async () => {
  const root = await createPackageFixture();
  try {
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        'export interface ActionsService {}',
        'export interface DeprecatedAuthorOptions {}',
        'export interface StableAuthorOptions {}',
        'export interface UnmarkedAuthorOptions {}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        "export type { ActionsService } from './service.js';",
        '/** @deprecated Use CurrentAuthorOptions; remove when the public replacement is adopted */',
        "export type { DeprecatedAuthorOptions } from './service.js';",
        "export type { StableAuthorOptions } from './service.js';",
        "export type { UnmarkedAuthorOptions } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    const authorRows = inventory.symbols.filter((symbol) => symbol.specifier === './actions');
    assert.deepEqual(
      authorRows.map(({ exportName, replacement, removalCondition }) => ({
        exportName,
        replacement,
        removalCondition,
      })),
      [
        {
          exportName: 'ActionsService',
          replacement: undefined,
          removalCondition: undefined,
        },
        {
          exportName: 'DeprecatedAuthorOptions',
          replacement: 'Use CurrentAuthorOptions',
          removalCondition: 'the public replacement is adopted',
        },
        {
          exportName: 'StableAuthorOptions',
          replacement: undefined,
          removalCondition: undefined,
        },
        {
          exportName: 'UnmarkedAuthorOptions',
          replacement: undefined,
          removalCondition: undefined,
        },
      ],
    );
    const generatedBarrel = await readFile(join(root, 'src/actions/index.ts'), 'utf8');
    assert.doesNotMatch(generatedBarrel, /@preview|@experimental|@stable/u);
    assert.equal(generatedBarrel, "export * from './index.public.js';\n");
    assert.match(await readFile(join(root, 'src/actions/index.public.ts'), 'utf8'), /@deprecated Use CurrentAuthorOptions/u);
    const authorApi = await readFile(join(root, 'API.md'), 'utf8');
    assert.match(authorApi, /> This package is Developer Preview\./u);
    assert.doesNotMatch(authorApi, /\| Stability \||\| preview \||\| deprecated \|/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('projects exact daemon value exports from an entrypoint publication spec', async () => {
  const root = await createPackageFixture();
  try {
    await writeFile(
      join(root, 'src/actions/service.ts'),
      [
        '/** @moduleRealm daemon */',
        'export interface ActionsService {}',
        'export function compareExternalSessionCandidatePrecedence() { return 0; }',
        'export function resolveExternalSessionCandidateIdentityKey() { return \'candidate\'; }',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'src/actions/index.public.ts'),
      [
        "export type { ActionsService } from './service.js';",
        "export { compareExternalSessionCandidatePrecedence } from './service.js';",
        "export { resolveExternalSessionCandidateIdentityKey } from './service.js';",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runJsonCli(root, ['--write']);

    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(join(root, 'api-surface.json'), 'utf8'));
    const candidateValues = inventory.symbols.filter((symbol) => (
      symbol.specifier === './actions'
      && symbol.kind === 'value'
      && symbol.exportName.includes('ExternalSessionCandidate')
    ));
    assert.deepEqual(candidateValues, [
      {
        specifier: './actions',
        exportName: 'compareExternalSessionCandidatePrecedence',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'compareExternalSessionCandidatePrecedence',
        realm: 'daemon',
      },
      {
        specifier: './actions',
        exportName: 'resolveExternalSessionCandidateIdentityKey',
        kind: 'value',
        sourceModule: 'src/actions/service.ts',
        sourceExport: 'resolveExternalSessionCandidateIdentityKey',
        realm: 'daemon',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI closes private structural helpers without publishing them or admitting host types', async () => {
  const root = await createPackageFixture();
  try {
    await publishFixtureSymbols(root, [{
      specifier: './actions', exportName: 'PublicOptions', kind: 'type',
      sourceModule: 'src/actions/service.ts', sourceExport: 'PublicOptions', realm: 'any',
    }]);
    await writeFixtureFile(root, 'src/actions/service.ts', [
      'export interface ActionsService {}',
      'interface PrivateHelper { readonly id: string }',
      'export type PublicOptions = Readonly<{ helper: PrivateHelper }>;',
      '',
    ].join('\n'));
    const valid = runJsonCli(root);
    assert.equal(valid.status, 0, valid.stderr);
    const inventory = await apiSurfaceCli.readCurrentApiSurfaceInventory({ packageRoot: root });
    assert.equal(inventory.symbols.some((row) => row.exportName === 'PrivateHelper'), false);
    await writeFixtureFile(root, 'src/host/private.ts', 'export interface HiddenHost { readonly secret: string }\n');
    await writeFixtureFile(root, 'src/actions/service.ts', [
      'export interface ActionsService {}',
      "import type { HiddenHost } from '../host/private.js';",
      'interface PrivateHelper { readonly host: HiddenHost }',
      'export type PublicOptions = Readonly<{ helper: PrivateHelper }>;',
      '',
    ].join('\n'));
    const forbidden = runJsonCli(root);
    assert.equal(forbidden.status, 1);
    assert.match(forbidden.stderr, /HiddenHost.*absent from the author inventory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
