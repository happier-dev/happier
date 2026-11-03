import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const reactNativeDocPath = fileURLToPath(
  new URL('../content/docs/plugins/ui/react-native.mdx', import.meta.url),
);
const pluginUiIndexDocPath = fileURLToPath(
  new URL('../content/docs/plugins/ui/index.mdx', import.meta.url),
);
const pluginDocsIndexPath = fileURLToPath(
  new URL('../content/docs/plugins/index.mdx', import.meta.url),
);
const glossaryDocPath = fileURLToPath(
  new URL('../content/docs/plugins/glossary.mdx', import.meta.url),
);
const hostedWebDocPath = fileURLToPath(
  new URL('../content/docs/plugins/ui/hosted-web.mdx', import.meta.url),
);
const uiArtifactsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/ui/ui-artifacts.mdx', import.meta.url),
);
const crossPluginContributionsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/guides/cross-plugin-contributions.mdx', import.meta.url),
);
const localDevelopmentDocPath = fileURLToPath(
  new URL('../content/docs/plugins/packaging/local-development.mdx', import.meta.url),
);
const manifestContributionsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/manifest/contributions.mdx', import.meta.url),
);
const manifestIndexDocPath = fileURLToPath(
  new URL('../content/docs/plugins/manifest/index.mdx', import.meta.url),
);
const testingDocPath = fileURLToPath(
  new URL('../content/docs/plugins/testing/index.mdx', import.meta.url),
);
const sdkEntrypointsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/api/sdk-entrypoints.mdx', import.meta.url),
);
const pluginSdkPackageJsonPath = fileURLToPath(
  new URL('../../../packages/plugin-sdk/package.json', import.meta.url),
);
const pluginSdkSourcePath = fileURLToPath(
  new URL('../../../packages/plugin-sdk/src/', import.meta.url),
);
const examplesIndexDocPath = fileURLToPath(
  new URL('../content/docs/plugins/examples/index.mdx', import.meta.url),
);
const quickstartDocPath = fileURLToPath(
  new URL('../content/docs/plugins/quickstart.mdx', import.meta.url),
);
const authoringCliDocPath = fileURLToPath(
  new URL('../content/docs/plugins/packaging/authoring-cli.mdx', import.meta.url),
);
const diagnosticsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/testing/diagnostics.mdx', import.meta.url),
);
const hostRuntimeExternalsSourcePath = fileURLToPath(
  new URL('../../../packages/protocol/src/plugins/ui/hostRuntimeExternals.ts', import.meta.url),
);
const packagingIndexDocPath = fileURLToPath(
  new URL('../content/docs/plugins/packaging/index.mdx', import.meta.url),
);
const installTrustDocPath = fileURLToPath(
  new URL('../content/docs/plugins/packaging/install-trust.mdx', import.meta.url),
);
const externalSessionsDocPath = fileURLToPath(
  new URL('../content/docs/plugins/surfaces/external-sessions.mdx', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function normalizedSource(path) {
  return readFileSync(path, 'utf8').replace(/\s+/gu, ' ');
}

test('keeps the React Native author declaration and data/resource boundaries truthful', () => {
  const source = normalizedSource(reactNativeDocPath);

  for (const requiredSource of [
    "requiredHostMethods: ['context', 'executeAction']",
    'admission requirement, not a method-availability claim',
    '`usePluginResource`',
    '`useLivePluginResource`',
    'same-plugin, statically declared Data UI query',
    'not a Happier component contract',
    'the sole provider installation boundary',
    'Artifact targets are not a mobile/tablet availability promise',
  ]) {
    assert.match(source, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('states the public UI testkit fidelity limit', () => {
  const source = normalizedSource(testingDocPath);

  for (const requiredSource of [
    '`createPluginUiTestkit`',
    'does not prove layout, styling, native reconciliation, CSP/origin',
    'installed discovery, on-demand activation, occurrence replacement',
    '`PluginUiTestkitMountAvailability`',
    "`{ kind: 'refused', availability }`",
    'does not calculate destination, platform, policy, renderer, or hosted-web admission',
  ]) {
    assert.match(source, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('documents the deliberate trusted advanced Plugin UI tier without leaking internals', () => {
  const source = normalizedSource(pluginUiIndexDocPath);

  for (const requiredSource of [
    'Trusted React Native and React Native Web authors',
    '`@happier-dev/plugin-ui/components`',
    '`@happier-dev/plugin-ui/environment`',
    'shared React Native/React Native Web primitives and behavior',
    'environment facts, hooks, and its standalone fact provider',
    '`/components` does not re-export environment contracts',
    'Do not construct a host provider, access internal mount state, import app or host internals, or import protocol types from an admitted surface.',
  ]) {
    assert.match(source, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.doesNotMatch(source, /held host\/core sharing seams/u);
  assert.doesNotMatch(source, /presentationHost|PluginUiProvider|PluginUiPresentationHost/u);
});

test('keeps final UI author contracts scoped to the one public owner', () => {
  const reactNative = normalizedSource(reactNativeDocPath);
  const hostedWeb = normalizedSource(hostedWebDocPath);
  const uiArtifacts = normalizedSource(uiArtifactsDocPath);
  const crossPlugin = normalizedSource(crossPluginContributionsDocPath);
  const localDevelopment = normalizedSource(localDevelopmentDocPath);
  const manifestContributions = normalizedSource(manifestContributionsDocPath);
  const pluginDocsIndex = normalizedSource(pluginDocsIndexPath);
  const glossary = normalizedSource(glossaryDocPath);

  for (const requiredSource of [
    'Host API 1.0.0',
    '`search` and `selection` props',
    'do not create, filter, or paginate a Data query',
  ]) {
    assert.match(reactNative, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }

  for (const requiredSource of [
    'Descriptor, operation, and embedded-surface roles are public authoring contracts',
    'ConversationProvidersContributionProtocolV1',
    'does not scan Actions',
  ]) {
    assert.match(crossPlugin, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.doesNotMatch(crossPlugin, /\b(?:Triage|workItemSourcesV1)\b/u);
  assert.match(crossPlugin, /`TargetedSurface`/u);
  assert.match(crossPlugin, /symbolic `targetedSurface` node/u);
  assert.doesNotMatch(normalizedSource(pluginUiIndexDocPath), /## Cross-plugin surface roles/u);
  assert.doesNotMatch(reactNative, /cross-plugin surface role/iu);
  assert.doesNotMatch(glossary, /\| Surface role \|/u);
  assert.match(pluginDocsIndex, /existing Actions to operation roles/u);
  assert.match(glossary, /existing Actions to operation roles/u);
  assert.match(
    manifestContributions,
    /Descriptor, operation, and embedded-surface roles are public authoring contracts/u,
  );
  assert.doesNotMatch(
    manifestContributions,
    /descriptor and embedded-renderer contribution roles are not a current external-author product/iu,
  );

  for (const requiredSource of [
    'Plaintext Accounts only',
    'retires the bridge and controller immediately',
    'cannot recall static bytes already downloaded',
    'not a user-visible hot-module-reload guarantee',
  ]) {
    const source = requiredSource === 'not a user-visible hot-module-reload guarantee'
      ? localDevelopment
      : hostedWeb;
    assert.match(source, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(localDevelopment, /daemon observes the trusted author source/u);
  assert.match(localDevelopment, /does not restore a copied historical source tree/u);
  assert.doesNotMatch(localDevelopment, /operation-local copy/u);

  assert.match(reactNative, /artifact id `main-renderer`/u);
  assert.match(reactNative, /\.\/happier-plugin-ui\/main-renderer/u);
  assert.doesNotMatch(reactNative, /pluginUiBuild\.ts/u);
  assert.doesNotMatch(reactNative, /from '\.\/plugin\.js'/u);
  assert.match(uiArtifacts, /\.\/happier-plugin-ui\/main-native/u);
  assert.match(uiArtifacts, /\.happier-plugin\/ui\/hosted-web\/<artifactId>/u);
  assert.match(uiArtifacts, /entry\.cjs\.bundle/u);
});

test('routes the same-realm host map reference to its canonical source', () => {
  const documentationSource = readFileSync(uiArtifactsDocPath, 'utf8');
  const repositoryPath = relative(repoRoot, hostRuntimeExternalsSourcePath).replaceAll('\\', '/');
  const linkedRepositoryPaths = [...documentationSource.matchAll(/\[[^\]]+\]\((https:\/\/github\.com\/happier-dev\/happier\/blob\/[^)]+)\)/gu)]
    .map(([, href]) => new URL(href).pathname.split('/').slice(5).join('/'));
  assert.ok(existsSync(hostRuntimeExternalsSourcePath), 'canonical host map must exist');
  assert.ok(linkedRepositoryPaths.includes(repositoryPath), 'UI artifact docs must link the canonical host map');
});

test('keeps development observation and renderer failure recovery with their current owners', () => {
  for (const path of [quickstartDocPath, authoringCliDocPath, localDevelopmentDocPath]) {
    const source = normalizedSource(path);
    assert.match(source, /daemon owns|daemon-owned|daemon observes/u);
    assert.doesNotMatch(source, /CLI observes the source/u);
  }

  const localDevelopment = normalizedSource(localDevelopmentDocPath);
  for (const phase of [
    'observing',
    'preparing_dependencies',
    'compiling',
    'validating',
    'active',
    'retained_incumbent',
    'unavailable',
  ]) {
    assert.match(localDevelopment, new RegExp(`\\b${phase}\\b`, 'u'));
  }
  assert.doesNotMatch(localDevelopment, /`source_validated`|`projected`/u);

  const diagnostics = normalizedSource(diagnosticsDocPath);
  assert.match(diagnostics, /contained by the client/u);
  assert.doesNotMatch(diagnostics, /crash_threshold_reached|crash_reset_context|daemon-owned crash watchdog/u);
});

test('keeps live runtime currentness and install decisions on their simplified contracts', () => {
  const pluginUiIndex = normalizedSource(pluginUiIndexDocPath);
  assert.match(pluginUiIndex, /host owns process-local occurrence currentness/u);
  assert.doesNotMatch(pluginUiIndex, /generation replacement|revalidates generation/u);

  const externalSessions = normalizedSource(externalSessionsDocPath);
  assert.match(externalSessions, /current plugin occurrence/u);
  assert.doesNotMatch(externalSessions, /current plugin generation|generation fencing|exact-generation/u);

  for (const path of [packagingIndexDocPath, installTrustDocPath]) {
    assert.doesNotMatch(normalizedSource(path), /Install & Trust/u);
  }
});

test('keeps the default scaffold manifest projection aligned with the action declaration', () => {
  const manifestIndex = normalizedSource(manifestIndexDocPath);

  for (const requiredSource of [
    '"execution": { "target": "daemon" }',
    '"placementBindings": ["commandPalette"]',
  ]) {
    assert.match(manifestIndex, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.doesNotMatch(manifestIndex, /"placement": "commandPalette"/u);
});

test('labels public Triage source fixtures as specialist conformance evidence rather than author templates', () => {
  for (const exampleName of ['triage-source-target', 'triage-source-contributor']) {
    const exampleRoot = join(repoRoot, 'packages', 'plugin-sdk', 'examples', exampleName);
    const readme = normalizedSource(join(exampleRoot, 'README.md'));
    const packageJson = JSON.parse(readFileSync(join(exampleRoot, 'package.json'), 'utf8'));

    assert.match(readme, /public Developer Preview/iu);
    assert.match(readme, /rather than a starter template/u);
    assert.doesNotMatch(readme, /This copyable/u);
    assert.match(packageJson.description, /public Developer Preview fixture/iu);
    assert.doesNotMatch(packageJson.description, /copyable/u);
  }
});

test('maps every package-visible SDK entrypoint as a task route', () => {
  const source = normalizedSource(sdkEntrypointsDocPath);
  const packageJson = JSON.parse(readFileSync(pluginSdkPackageJsonPath, 'utf8'));
  const exports = Object.keys(packageJson.exports).sort();
  const documented = [...source.matchAll(/`@happier-dev\/plugin-sdk([^`]*)`/gu)]
    .map(([, suffix]) => `.${suffix}`)
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .sort();

  assert.deepEqual(documented, exports);
  for (const entrypoint of exports) {
    const relativeSourcePath = entrypoint === '.'
      ? 'index.public.ts'
      : `${entrypoint.slice('./'.length)}/index.public.ts`;
    assert.ok(existsSync(join(pluginSdkSourcePath, relativeSourcePath)), entrypoint);
  }
  assert.match(source, /author-owned `index\.public\.ts`/u);
  assert.doesNotMatch(source, /Host Actions reference/u);
});

test('maps maintained UI references without turning cold-manifest fixtures into a starter path', () => {
  const source = normalizedSource(examplesIndexDocPath);

  for (const requiredSource of [
    '`hdev plugins create` and `definePlugin(...)` remain the normal authoring path',
    '`react-native-installed`',
    '`react-native-dev-hot-reload`',
    '`projects-tasks`',
    '`public-authoring`',
    'semantic `createPluginUiTestkit` companion',
    '`production-hosted-reference`',
    '`descriptor-only`',
    '`multi-mode-fallback`',
    // The maintained feature references must stay discoverable from this
    // index; dropping a row would leave the example unreachable from docs.
    '`operation-only-channel-provider`',
    '`automation-event-source`',
  ]) {
    assert.match(source, new RegExp(requiredSource.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }

  for (const exampleName of [
    'descriptor-only',
    'hosted-web',
    'multi-mode-fallback',
    'operation-only-channel-provider',
    'automation-event-source',
    'production-hosted-reference',
    'projects-tasks',
    'react-native-dev-hot-reload',
    'react-native-installed',
  ]) {
    assert.match(
      source,
      new RegExp(
        `\\]\\(https://github\\.com/happier-dev/happier/tree/v0\\.3/packages/plugin-sdk/examples/${exampleName}\\)`,
        'u',
      ),
    );
  }

  // The cold-manifest conformance references must keep their deliberate
  // not-a-template marker; the maintained feature references instead name
  // themselves as maintained cross-plugin references.
  for (const exampleName of [
    'descriptor-only',
    'hosted-web',
    'multi-mode-fallback',
    'production-hosted-reference',
    'projects-tasks',
    'react-native-dev-hot-reload',
    'react-native-installed',
  ]) {
    const readme = normalizedSource(
      join(repoRoot, 'packages', 'plugin-sdk', 'examples', exampleName, 'README.md'),
    );
    assert.match(readme, /not an ordinary authoring template/u);
  }
  for (const exampleName of ['operation-only-channel-provider', 'automation-event-source']) {
    const readme = normalizedSource(
      join(repoRoot, 'packages', 'plugin-sdk', 'examples', exampleName, 'README.md'),
    );
    assert.match(readme, /maintained (?:public cross-plugin reference|external-plugin example)/iu);
  }
});
