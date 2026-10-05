import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
} from '@happier-dev/protocol';

import {
  CAPABILITY_HOST_BINDING_OWNERS_V1,
  CapabilityMatrixValidationError,
  deriveCapabilityMatrixMetadata,
  projectCapabilityMatrix,
  readDefinePluginCapabilityPolicy,
  readPluginServicesCapabilityCatalog,
} from './capabilityMatrix.mjs';
import { createCapabilityMatrixOutput } from './capabilityMatrixCli.mjs';
import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';
import {
  readCurrentApiSurfaceInventory,
} from './apiSurfaceCli.mjs';

const CATALOG = Object.freeze([
  Object.freeze({
    manifestKey: 'actions',
    allowedRuntimeRegistration: 'actions',
    registrationHost: 'daemon',
    consumer: 'action-dispatch',
    lifecycleStages: Object.freeze(['declared', 'active']),
    disposition: 'reshaped',
  }),
]);

const HOST_ACCESS_CATALOG = Object.freeze([
  Object.freeze({ capability: 'network.client', authorizationClass: 'cooperativeDisclosure' }),
]);

const DEFINE_PLUGIN_POLICY = Object.freeze({
  actions: Object.freeze({
    authorKey: 'actions',
    classification: 'adapter',
    inputShape: 'structured',
  }),
});

const API_INVENTORY = Object.freeze({
  entrypoints: Object.freeze([
    Object.freeze({
      specifier: '.',
      sourceModule: 'src/index.ts',
      visibility: 'author',
      realm: 'any',
    }),
    Object.freeze({
      specifier: './http',
      sourceModule: 'src/http/index.ts',
      visibility: 'author',
      realm: 'any',
    }),
  ]),
  symbols: Object.freeze([
    Object.freeze({
      specifier: '.',
      exportName: 'definePlugin',
      kind: 'value',
      sourceModule: 'src/definePlugin.ts',
      sourceExport: 'definePlugin',
      realm: 'any',
    }),
    Object.freeze({
      specifier: './http',
      exportName: 'HttpService',
      kind: 'type',
      sourceModule: 'src/services/io.ts',
      sourceExport: 'HttpService',
      realm: 'any',
    }),
  ]),
});

const SERVICES = Object.freeze([
  Object.freeze({ id: 'http', property: 'http', publicType: 'HttpService' }),
]);

/**
 * The host owners an available row may cite, with the canonical symbol that
 * proves each one really binds, projects, or runs the capability. Declaration
 * catalogs, `PluginServices` members, and published source modules are
 * deliberately absent: they declare capabilities and bind none.
 */
const HOST_BINDING_OWNER_EVIDENCE = Object.freeze({
  'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts': 'export async function resolveExecutablePluginRuntimeRegistry',
  'apps/ui/sources/components/plugins/reactNative/clientExecutableContributions.ts': 'export function createPluginUiClientExecutableRegistrationIndex',
  'apps/cli/src/plugins/projection/registry/ui/projection.ts': 'export const pluginUiProjectionFamily',
  'apps/cli/src/plugins/projection/registry/browser.ts': 'export const pluginBrowserProjectionFamily',
  'apps/cli/src/plugins/projection/registry/composer.ts': 'export const composerControlsProjectionFamily',
  'apps/cli/src/plugins/projection/registry/managedDependencies.ts': 'export const managedDependenciesProjectionFamily',
  'apps/cli/src/plugins/projection/registry/accountCollections.ts': 'export const accountCollectionsProjectionFamily',
  'apps/cli/src/plugins/projection/registry/voiceDeclarations.ts': 'export const voiceModelPackProjectionFamily',
  'apps/cli/src/plugins/projection/registry/roles.ts': 'export const rolesProjectionFamily',
  'apps/cli/src/plugins/projection/registry/workflows.ts': 'export const workflowsProjectionFamily',
  'apps/cli/src/plugins/projection/registry/targetedContributions.ts': 'export function resolveAdmittedTargetedContributions',
  'apps/cli/src/cli/pluginCommandContributions.ts': 'export async function handlePluginCommandCliCommand',
  'apps/cli/src/plugins/runtime/toolCatalog.ts': 'export function projectExecutablePluginToolCatalog',
  'apps/cli/src/capabilities/registry/toolExecutionRuns.ts': 'export const executionRunsCapability',
  'apps/cli/src/plugins/runtime/exec/system/tools/definitions.ts': 'export function projectPluginSystemToolContributions',
  'apps/cli/src/plugins/runtime/invocation/services/settings.ts': 'export function createStablePluginSettingsHost',
  'apps/cli/src/plugins/runtime/invocation/services/notifications.ts': 'export function createStablePluginNotificationsOwner',
  'apps/cli/src/plugins/runtime/lifecycle/manager.ts': 'export async function activatePluginRuntimeRegistry',
  'apps/cli/src/plugins/daemon/runtimeOwner.ts': 'export function createDaemonPluginRuntimeOwner',
  'apps/server/sources/app/plugins/webhooks/currentContribution.ts': 'export async function resolveCurrentPluginWebhookContributionTxV1',
  'apps/server/sources/app/plugins/webhooks/claimStore.ts': 'export async function claimPluginWebhookDeliveryV1',
  'apps/cli/src/plugins/runtime/invocation/services/factory.ts': 'export function createUnavailablePluginInvocationServiceBinding',
  'apps/cli/src/plugins/runtime/invocation/services/production.ts': 'export function createProductionPluginInvocationServiceOwners',
  'apps/cli/src/plugins/runtime/invocation/lifetime.ts': 'export function createPluginInvocationLifetime',
  'apps/cli/src/plugins/runtime/hostAccess/resolve.ts': 'export function createPluginInvocationHostPolicyResolver',
  'apps/cli/src/plugins/runtime/context/terminalHost.ts': 'export function createPluginTerminalHostService',
  'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts': 'export function createNativeAgentSessionHostServiceOwners',
  'apps/cli/src/plugins/runtime/loadPluginModule.ts': 'export async function loadVerifiedPluginModule',
  'packages/plugin-ui/src/surfaceEntry.tsx': 'export function defineUiSurface',
  'packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts': 'export async function buildUniversalPluginUiArtifacts',
  'packages/plugin-sdk/package.json': '"exports"',
});
const HOST_BINDING_OWNER_MODULES = new Set(Object.keys(HOST_BINDING_OWNER_EVIDENCE));

function metadata(overrides = {}) {
  return Object.freeze({
    manifestFamilies: Object.freeze({
      actions: Object.freeze({
        producer: 'packages/protocol/src/plugins/contributions/catalog.ts#actions',
        provingConsumer: 'packages/plugins/channels/src/manifest.ts',
        specialistOwner: 'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts',
        lifecycleOwner: 'apps/cli/src/plugins/runtime/lifecycle/manager.ts',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    services: Object.freeze({
      http: Object.freeze({
        producer: 'src/services/io.ts',
        lifecycle: 'invocation-scoped',
        provingConsumer: 'packages/plugins/channel-telegram/src/channelActions.ts',
        specialistOwner: 'apps/cli/src/plugins/runtime/invocation/services/factory.ts',
        lifecycleOwner: 'apps/cli/src/plugins/runtime/invocation/lifetime.ts',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    hostAccess: Object.freeze({
      'network.client': Object.freeze({
        producer: 'packages/protocol/src/plugins/manifest/v2.ts#network.client',
        lifecycle: 'invocation-scoped',
        provingConsumer: 'packages/plugins/channels',
        specialistOwner: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
        lifecycleOwner: 'apps/cli/src/plugins/runtime/invocation/services/factory.ts',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    subpaths: Object.freeze({
      '.': Object.freeze({
        producer: 'src/index.ts',
        lifecycle: 'published',
        provingConsumer: 'packages/plugins/channels',
        specialistOwner: 'packages/plugin-sdk/package.json',
        lifecycleOwner: 'apps/cli/src/plugins/runtime/loadPluginModule.ts',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
      './http': Object.freeze({
        producer: 'src/http/index.ts',
        lifecycle: 'published',
        provingConsumer: 'packages/plugins/channels',
        specialistOwner: 'packages/plugin-sdk/package.json',
        lifecycleOwner: 'apps/cli/src/plugins/runtime/loadPluginModule.ts',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    ...overrides,
  });
}

function project(overrides = {}) {
  return projectCapabilityMatrix({
    contributionCatalog: CATALOG,
    hostAccessCatalog: HOST_ACCESS_CATALOG,
    definePluginPolicy: DEFINE_PLUGIN_POLICY,
    apiInventory: API_INVENTORY,
    services: SERVICES,
    metadata: metadata(overrides),
  });
}

let currentApiInventoryPromise;

function readCurrentApiInventory(packageRoot) {
  currentApiInventoryPromise ??= readCurrentApiSurfaceInventory({ packageRoot });
  return currentApiInventoryPromise;
}

test('rejects an omitted canonical manifest-family metadata row', () => {
  assert.throws(
    () => project({ manifestFamilies: Object.freeze({}) }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes('missing manifest-family metadata: actions'),
  );
});

test('rejects a contribution catalog family that carries its own availability posture', () => {
  assert.throws(
    () => projectCapabilityMatrix({
      contributionCatalog: Object.freeze([Object.freeze({ ...CATALOG[0], stability: 'stable' })]),
      hostAccessCatalog: HOST_ACCESS_CATALOG,
      definePluginPolicy: DEFINE_PLUGIN_POLICY,
      apiInventory: API_INVENTORY,
      services: SERVICES,
      metadata: metadata(),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        "contribution catalog family 'actions' uses retired family stability metadata"
        + '; capability-matrix.json owns family availability',
      ),
  );
});

test('rejects metadata that does not join a canonical public subpath', () => {
  assert.throws(
    () => project({
      subpaths: Object.freeze({
        ...metadata().subpaths,
        './not-published': metadata().subpaths['./http'],
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes('unknown published-subpath metadata: ./not-published'),
  );
});

test('publishes exactly the canonical host binding owners, each owning its capability in source', async () => {
  // Availability may only cite these owners, so an invented, moved, or retired
  // owner path must fail here rather than reach a published matrix row.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  assert.deepEqual(
    [...Object.values(CAPABILITY_HOST_BINDING_OWNERS_V1)].sort(),
    [...HOST_BINDING_OWNER_MODULES].sort(),
  );
  for (const [module, evidence] of Object.entries(HOST_BINDING_OWNER_EVIDENCE)) {
    const source = await readFile(resolve(repoRoot, module), 'utf8');
    assert.equal(source.includes(evidence), true, `${module} must own ${evidence}`);
  }
});

test('rejects a contribution catalog label as an available family host binder', () => {
  // The Protocol catalog entry declares the family. It registers, projects and
  // runs nothing, so it cannot also stand as the row's host binder.
  assert.throws(
    () => project({
      manifestFamilies: Object.freeze({
        actions: Object.freeze({
          ...metadata().manifestFamilies.actions,
          specialistOwner: 'packages/protocol/src/plugins/contributions/catalog.ts#actions',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'manifestFamilies.actions.specialistOwner must name a canonical host binder/projection owner'
        + '; a declaration catalog, type member, or published source module binds nothing',
      ),
  );
});

test('rejects a PluginServices member spelling as an available service host binder', () => {
  assert.throws(
    () => project({
      services: Object.freeze({
        http: Object.freeze({
          ...metadata().services.http,
          specialistOwner: 'packages/plugin-sdk/src/services/index.ts#PluginServices.http',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'services.http.specialistOwner must name a canonical host binder/projection owner'
        + '; a declaration catalog, type member, or published source module binds nothing',
      ),
  );
});

test('rejects an available row whose host binder repeats its own declaration owner', () => {
  assert.throws(
    () => project({
      hostAccess: Object.freeze({
        'network.client': Object.freeze({
          ...metadata().hostAccess['network.client'],
          producer: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'hostAccess.network.client.specialistOwner must not repeat its own declaration owner',
      ),
  );
});

test('rejects an available row without a canonical runtime lifecycle owner', () => {
  assert.throws(
    () => project({
      subpaths: Object.freeze({
        ...metadata().subpaths,
        './http': Object.freeze({
          ...metadata().subpaths['./http'],
          lifecycleOwner: undefined,
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'subpaths../http.lifecycleOwner must name a canonical runtime lifecycle owner'
        + '; a lifecycle stage label owns no lifecycle',
      ),
  );
});

test('rejects a deferred row that claims a host binder or runtime lifecycle owner', () => {
  assert.throws(
    () => project({
      hostAccess: Object.freeze({
        'network.client': Object.freeze({
          ...metadata().hostAccess['network.client'],
          availabilityDisposition: 'deferred',
          provingConsumer: null,
          unblockCondition: 'no host authority or service owner binds this capability yet',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'hostAccess.network.client must leave specialistOwner and lifecycleOwner null while it is deferred',
      ),
  );
});

test('declares the public Automation projection with its maintained Channels result-delivery consumer', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./automations'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channels/src/automationResultDelivery.ts',
  });
});

test('declares the public Webhooks projection with its maintained SCM GitHub consumer', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./webhooks'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/scm-github/src/webhookAction.ts',
  });
});

test('declares protocol and contribution authoring with their maintained positive consumers', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./protocol'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channels/src/bindingTransition.ts',
  });
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./contributions'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/public-protocol.ts',
  });
});

test('source publication spec closes the public testkit mount contract family without per-symbol posture', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const publicSpecText = await readFile(resolve(packageRoot, 'src/testing/index.public.ts'), 'utf8');
  const publicSpec = ts.createSourceFile(
    'src/testing/index.public.ts',
    publicSpecText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mountContractSymbols = publicSpec.statements
    .filter((statement) => (
      ts.isExportDeclaration(statement)
      && statement.isTypeOnly
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === './uiHost.js'
      && statement.exportClause
      && ts.isNamedExports(statement.exportClause)
    ))
    .flatMap((statement) => statement.exportClause.elements.map((element) => element.name.text))
    .filter((symbol) => symbol.startsWith('PluginUiTestkitMount'))
    .sort((left, right) => left.localeCompare(right));

  assert.deepEqual(mountContractSymbols, [
    'PluginUiTestkitMountAvailability',
    'PluginUiTestkitMountInput',
    'PluginUiTestkitMountOptions',
    'PluginUiTestkitMountResult',
  ]);
  assert.doesNotMatch(publicSpecText, /@(preview|experimental|stable|incubating)\b/u);
  assert.match(
    await readFile(resolve(packageRoot, 'src/testing/uiHost.ts'), 'utf8'),
    /^\/\*\* @moduleRealm daemon \*\//mu,
  );
});

test('declares transcript activities with the maintained Channels resource author', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.transcriptActivities, {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channels/src/manifest.ts',
  });
});

test('declares session info sections with the maintained Channels resource author', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.sessionInfoSections, {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channels/src/manifest.ts',
  });
});

test('derives entity drag families through the client occurrence owner and maintained Triage consumer', () => {
  const entries = PLUGIN_CONTRIBUTION_CATALOG_V2.filter(entry => (
    entry.manifestKey === 'dragSources' || entry.manifestKey === 'dropTargets'
  ));
  assert.equal(entries.length, 2);
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: entries,
    hostAccessCatalog: [],
    apiInventory: { entrypoints: [], symbols: [] },
    services: [],
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });
  for (const entry of entries) {
    const row = metadata.manifestFamilies[entry.manifestKey];
    assert.equal(row.availabilityDisposition, 'available');
    assert.equal(row.specialistOwner, CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration);
    assert.equal(row.lifecycleOwner, CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration);
    assert.equal(row.provingConsumer, 'packages/plugins/triage/src/manifest.ts');
    assert.equal(row.loadedPlatformProof, 'not-recorded');
    assert.equal(row.releaseAvailability, 'not-published');
  }
});

test('derives targeted contribution availability through the maintained external target/contributor fixture consumer', () => {
  const targetedContributionCatalogEntry = PLUGIN_CONTRIBUTION_CATALOG_V2.find(
    (entry) => entry.manifestKey === 'targetedPluginContributions',
  );
  assert.ok(targetedContributionCatalogEntry);

  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: [targetedContributionCatalogEntry],
    hostAccessCatalog: [],
    apiInventory: { entrypoints: [], symbols: [] },
    services: [],
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });

  assert.deepEqual(metadata.manifestFamilies.targetedPluginContributions, {
    producer: 'packages/protocol/src/plugins/contributions/catalog.ts#targetedPluginContributions',
    specialistOwner: 'apps/cli/src/plugins/projection/registry/targetedContributions.ts',
    lifecycleOwner: 'apps/cli/src/plugins/runtime/lifecycle/manager.ts',
    predecessorRemoval: `catalog-disposition:${targetedContributionCatalogEntry.disposition}`,
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugin-sdk/fixtures/external-targeted-packages/contributor/src/index.ts',
    sourceApiAvailability: 'present',
    sourceConsumer: null,
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
});

test('derives daemon database and webhook availability from their real realm owners', () => {
  const entries = PLUGIN_CONTRIBUTION_CATALOG_V2.filter((entry) => (
    entry.manifestKey === 'daemonDatabases' || entry.manifestKey === 'webhooks'
  ));
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: entries,
    hostAccessCatalog: [],
    apiInventory: { entrypoints: [], symbols: [] },
    services: [],
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });

  assert.equal(
    metadata.manifestFamilies.daemonDatabases.specialistOwner,
    'apps/cli/src/plugins/daemon/runtimeOwner.ts',
  );
  assert.equal(
    metadata.manifestFamilies.daemonDatabases.lifecycleOwner,
    'apps/cli/src/plugins/daemon/runtimeOwner.ts',
  );
  assert.equal(
    metadata.manifestFamilies.webhooks.specialistOwner,
    'apps/server/sources/app/plugins/webhooks/currentContribution.ts',
  );
  assert.equal(
    metadata.manifestFamilies.webhooks.lifecycleOwner,
    'apps/server/sources/app/plugins/webhooks/claimStore.ts',
  );
});

test('derives declarative workflow availability from its projection and occurrence lifecycle owners', () => {
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: [{ manifestKey: 'workflows', disposition: 'retained' }],
    hostAccessCatalog: [],
    apiInventory: { entrypoints: [], symbols: [] },
    services: [],
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });

  const { producer, specialistOwner, lifecycleOwner, predecessorRemoval,
    availabilityDisposition, provingConsumer } = metadata.manifestFamilies.workflows;
  assert.deepEqual({ producer, specialistOwner, lifecycleOwner, predecessorRemoval,
    availabilityDisposition, provingConsumer }, {
    producer: 'packages/protocol/src/plugins/contributions/catalog.ts#workflows',
    specialistOwner: 'apps/cli/src/plugins/projection/registry/workflows.ts',
    lifecycleOwner: 'apps/cli/src/plugins/runtime/lifecycle/manager.ts',
    predecessorRemoval: 'catalog-disposition:retained',
    availabilityDisposition: 'available',
    provingConsumer: null,
  });
});

test('names the real realm binder for every catalogued manifest family', () => {
  // Registration, client projection and direct host consumption are different
  // host mechanisms. A catalog registration/projection label selects none of
  // them, and the resolved-contribution registry only reads what others bind,
  // so neither may stand in as a family's binder.
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: PLUGIN_CONTRIBUTION_CATALOG_V2,
    hostAccessCatalog: [],
    apiInventory: { entrypoints: [], symbols: [] },
    services: [],
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });

  const expectedBinders = {
    actions: 'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts',
    // Voice providers ship on web/iOS/Android only, so the daemon registry
    // never binds them; the client executable registration index does.
    voiceProviders: 'apps/ui/sources/components/plugins/reactNative/clientExecutableContributions.ts',
    dragSources: 'apps/ui/sources/components/plugins/reactNative/clientExecutableContributions.ts',
    dropTargets: 'apps/ui/sources/components/plugins/reactNative/clientExecutableContributions.ts',
    transcriptActivities: 'apps/cli/src/plugins/projection/registry/ui/projection.ts',
    'ui.views': 'apps/cli/src/plugins/projection/registry/ui/projection.ts',
    browserActions: 'apps/cli/src/plugins/projection/registry/browser.ts',
    composerControls: 'apps/cli/src/plugins/projection/registry/composer.ts',
    managedDependencies: 'apps/cli/src/plugins/projection/registry/managedDependencies.ts',
    accountCollections: 'apps/cli/src/plugins/projection/registry/accountCollections.ts',
    voiceModelPacks: 'apps/cli/src/plugins/projection/registry/voiceDeclarations.ts',
    commands: 'apps/cli/src/cli/pluginCommandContributions.ts',
    tools: 'apps/cli/src/plugins/runtime/toolCatalog.ts',
    settings: 'apps/cli/src/plugins/runtime/invocation/services/settings.ts',
    'settings.fields': 'apps/cli/src/plugins/runtime/invocation/services/settings.ts',
    executionRunProfiles: 'apps/cli/src/capabilities/registry/toolExecutionRuns.ts',
    notifications: 'apps/cli/src/plugins/runtime/invocation/services/notifications.ts',
    systemTools: 'apps/cli/src/plugins/runtime/exec/system/tools/definitions.ts',
    pluginContributionPoints: 'apps/cli/src/plugins/projection/registry/targetedContributions.ts',
    targetedPluginContributions: 'apps/cli/src/plugins/projection/registry/targetedContributions.ts',
    daemonDatabases: 'apps/cli/src/plugins/daemon/runtimeOwner.ts',
    webhooks: 'apps/server/sources/app/plugins/webhooks/currentContribution.ts',
  };
  for (const [family, binder] of Object.entries(expectedBinders)) {
    assert.equal(metadata.manifestFamilies[family].specialistOwner, binder, family);
  }
  for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
    const row = metadata.manifestFamilies[entry.manifestKey];
    assert.equal(HOST_BINDING_OWNER_MODULES.has(row.specialistOwner), true, `${entry.manifestKey} binder`);
    assert.equal(HOST_BINDING_OWNER_MODULES.has(row.lifecycleOwner), true, `${entry.manifestKey} lifecycle`);
  }
});

test('binds each published service through the host owner that really supplies it', async () => {
  // The host splits `PluginServices` into binding-supplied and host-composed
  // members. Citing the binding owner for a host-composed member — or any
  // `PluginServices` spelling for either — is not a binder.
  const packageRoot = resolve(import.meta.dirname, '..');
  const repoRoot = resolve(packageRoot, '..', '..');
  const [servicesSource, hostServices, apiInventory] = await Promise.all([
    readFile(resolve(packageRoot, 'src/services/index.ts'), 'utf8'),
    readFile(resolve(repoRoot, 'apps/cli/src/plugins/runtime/invocation/services/unavailable.ts'), 'utf8'),
    readCurrentApiInventory(packageRoot),
  ]);
  const services = readPluginServicesCapabilityCatalog(servicesSource);
  const availabilityOwnerById = new Map([...hostServices
    .slice(hostServices.indexOf('export const PLUGIN_SERVICE_DESCRIPTORS'))
    .matchAll(/id: '([a-zA-Z]+)', publicProperty: '[a-zA-Z]+', availabilityOwner: '(binding|host)'/gu)]
    .map(([, id, availabilityOwner]) => [id, availabilityOwner]));
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: [],
    hostAccessCatalog: [],
    apiInventory,
    services,
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });

  assert.equal(availabilityOwnerById.size, services.length);
  for (const service of services) {
    const row = metadata.services[service.id];
    assert.equal(
      row.specialistOwner,
      availabilityOwnerById.get(service.id) === 'binding'
        ? 'apps/cli/src/plugins/runtime/invocation/services/factory.ts'
        : 'apps/cli/src/plugins/runtime/invocation/services/production.ts',
      service.id,
    );
    assert.equal(row.lifecycleOwner, 'apps/cli/src/plugins/runtime/invocation/lifetime.ts', service.id);
    assert.equal(/#PluginServices\./u.test(row.producer), false, service.id);
  }
});

test('leaves a capability the owner map does not name unbound in every group', () => {
  // A row can only be available with a named binder and lifecycle owner, so an
  // unmapped family, service, HostAccess capability, or realm must arrive here
  // unbound instead of inheriting a generic registry, resolver, or loader.
  const declaration = Object.freeze({ availabilityDisposition: 'available', provingConsumer: null });
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: [{
      manifestKey: 'unmappedFamily',
      allowedRuntimeRegistration: 'unmappedFamily',
      projectionFamily: 'unmappedFamily',
      disposition: 'reshaped',
    }],
    hostAccessCatalog: [{ capability: 'unmapped.capability' }],
    apiInventory: {
      entrypoints: [{
        specifier: './unmapped',
        sourceModule: 'src/unmapped/index.ts',
        visibility: 'author',
        realm: 'unmappedRealm',
      }],
      symbols: [],
    },
    services: [{ id: 'unmappedService', property: 'unmappedService', publicType: 'UnmappedService' }],
    declarations: {
      manifestFamilies: { unmappedFamily: declaration },
      services: { unmappedService: declaration },
      hostAccess: { 'unmapped.capability': declaration },
      subpaths: { './unmapped': declaration },
    },
  });

  for (const row of [
    metadata.manifestFamilies.unmappedFamily,
    metadata.services.unmappedService,
    metadata.hostAccess['unmapped.capability'],
    metadata.subpaths['./unmapped'],
  ]) {
    assert.equal(row.specialistOwner, null);
    assert.equal(row.lifecycleOwner, null);
  }
});

test('rejects a PluginServices member spelling as an available row declaration owner', () => {
  assert.throws(
    () => project({
      services: Object.freeze({
        http: Object.freeze({
          ...metadata().services.http,
          producer: 'packages/plugin-sdk/src/services/index.ts#PluginServices.http',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'services.http.producer must name the module that declares the capability'
        + '; a PluginServices member spelling declares no module',
      ),
  );
});

test('projects consumer-free availability for capabilities with a realm binder', () => {
  // MCP servers, Commands, Tools, and the unconsumed invocation services each
  // have a producer, a public projection, and a daemon-realm binder. No
  // maintained consumer exists for any of them, and none is required.
  for (const family of ['mcp.servers', 'commands', 'tools']) {
    assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family], {
      availabilityDisposition: 'available',
      provingConsumer: null,
    });
  }
  for (const service of ['events', 'fs', 'providers', 'resources']) {
    assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.services[service], {
      availabilityDisposition: 'available',
      provingConsumer: null,
    });
  }
});

test('names the Inspector settings declaration as the maintained settings and field consumer', () => {
  const expected = {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/inspector/src/manifest.ts',
  };
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.settings, expected);
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies['settings.fields'], expected);
});

test('names the external Composer dogfood author as the maintained composer-content service consumer', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.services.composerContent, {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/index.mjs',
  });
});

test('declares network clients with their maintained out-of-tree socket provider consumer', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess['network.client'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/tests/fixtures/plugin-platform/out-of-tree-channel-socket-provider/src/index.mjs',
  });
});

test('derives HostAccess metadata from the terminal/session and deferred declaration owners', () => {
  const metadata = deriveCapabilityMatrixMetadata({
    contributionCatalog: [],
    hostAccessCatalog: [
      { capability: 'terminal' },
      { capability: 'browser' },
      { capability: 'clipboard' },
      { capability: 'externalLinks' },
    ],
    apiInventory: { entrypoints: [], symbols: [] },
    services: [],
    declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
  });

  assert.deepEqual(metadata.hostAccess.terminal, {
    producer: 'packages/protocol/src/plugins/manifest/v2.ts#terminal',
    lifecycle: 'session-runtime',
    provingConsumer: 'packages/plugins/claude/src/manifest.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    lifecycleOwner: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
    sourceApiAvailability: 'present',
    sourceConsumer: null,
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
  assert.equal(Object.hasOwn(metadata.hostAccess, 'network.intercept'), false);
  for (const capability of ['browser', 'clipboard', 'externalLinks']) {
    const row = metadata.hostAccess[capability];
    assert.equal(row.producer, `packages/protocol/src/plugins/manifest/v2.ts#${capability}`);
    assert.equal(row.lifecycle, 'declaration-only');
    assert.equal(row.specialistOwner, null);
    assert.equal(row.lifecycleOwner, null);
    assert.equal(row.availabilityDisposition, 'deferred');
    assert.equal(row.provingConsumer, null);
  }
});

test('rejects a HostAccess row without one exact availability disposition', () => {
  assert.throws(
    () => project({
      hostAccess: Object.freeze({
        'network.client': Object.freeze({
          ...metadata().hostAccess['network.client'],
          availabilityDisposition: undefined,
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes('hostAccess.network.client availabilityDisposition must be available, deferred, or retired'),
  );
});

test('keeps an implemented capability available without a proving consumer', () => {
  const matrix = project({
    manifestFamilies: Object.freeze({
      actions: Object.freeze({
        ...metadata().manifestFamilies.actions,
        provingConsumer: undefined,
        sourceConsumer: null,
      }),
    }),
  });

  const actions = matrix.manifestFamilies.find((row) => row.manifestFamily === 'actions');
  assert.equal(actions?.availabilityDisposition, 'available');
  assert.equal(actions?.provingConsumer, null);
  assert.equal(actions?.sourceConsumer, null);
});

test('requires every manifest-family and service row to state one availability disposition', () => {
  assert.throws(
    () => project({
      manifestFamilies: Object.freeze({
        actions: Object.freeze({
          ...metadata().manifestFamilies.actions,
          availabilityDisposition: undefined,
        }),
      }),
      services: Object.freeze({
        http: Object.freeze({
          ...metadata().services.http,
          availabilityDisposition: undefined,
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'manifestFamilies.actions availabilityDisposition must be available, deferred, or retired',
      )
      && error.diagnostics.includes(
        'services.http availabilityDisposition must be available, deferred, or retired',
      ),
  );
});

test('rejects an available matrix row for a family deferred from definePlugin authoring', () => {
  assert.throws(
    () => projectCapabilityMatrix({
      contributionCatalog: Object.freeze([
        ...CATALOG,
        Object.freeze({
          manifestKey: 'requestInterceptors',
          allowedRuntimeRegistration: 'requestInterceptors',
          registrationHost: 'daemon',
          consumer: 'host-private-fetch',
          lifecycleStages: Object.freeze(['declared', 'active']),
          disposition: 'retained',
        }),
      ]),
      hostAccessCatalog: HOST_ACCESS_CATALOG,
      definePluginPolicy: Object.freeze({
        ...DEFINE_PLUGIN_POLICY,
        requestInterceptors: Object.freeze({
          authorKey: 'requestInterceptors',
          classification: 'deferred',
          inputShape: 'deferred',
        }),
      }),
      apiInventory: API_INVENTORY,
      services: SERVICES,
      metadata: metadata({
        manifestFamilies: Object.freeze({
          ...metadata().manifestFamilies,
          requestInterceptors: Object.freeze({
            producer: 'apps/cli/src/plugins/runtime/fetch/service.ts',
            provingConsumer: 'packages/plugins/channels/src/manifest.ts',
            specialistOwner: 'apps/cli/src/plugins/runtime/fetch/service.ts',
            predecessorRemoval: 'none',
            availabilityDisposition: 'available',
          }),
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'manifestFamilies.requestInterceptors deferred definePlugin policy requires deferred availabilityDisposition',
      ),
  );
});

test('requires manifest-family and service deferred rows to name an unblock', () => {
  assert.throws(
    () => project({
      manifestFamilies: Object.freeze({
        actions: Object.freeze({
          ...metadata().manifestFamilies.actions,
          availabilityDisposition: 'deferred',
          provingConsumer: 'packages/plugins/channels/src/manifest.ts',
          unblockCondition: undefined,
        }),
      }),
      services: Object.freeze({
        http: Object.freeze({
          ...metadata().services.http,
          availabilityDisposition: 'deferred',
          provingConsumer: 'packages/plugins/channel-telegram/src/channelActions.ts',
          unblockCondition: undefined,
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'manifestFamilies.actions.unblockCondition must be a non-empty string',
      )
      && error.diagnostics.includes(
        'services.http.unblockCondition must be a non-empty string',
      ),
  );
});

test('derives author and service identities from their canonical SDK source owners', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const [definePluginSource, servicesSource] = await Promise.all([
    readFile(resolve(packageRoot, 'src/definePlugin.ts'), 'utf8'),
    readFile(resolve(packageRoot, 'src/services/index.ts'), 'utf8'),
  ]);

  const policy = readDefinePluginCapabilityPolicy(definePluginSource);
  const services = readPluginServicesCapabilityCatalog(servicesSource);

  assert.deepEqual(policy.actions, {
    authorKey: 'actions',
    classification: 'adapter',
    inputShape: 'structured',
  });
  assert.deepEqual(policy.daemonDatabases, {
    authorKey: 'daemonDatabases',
    classification: 'descriptor-only',
    inputShape: 'descriptor',
  });
  assert.deepEqual(services.find((service) => service.id === 'http'), {
    id: 'http',
    property: 'http',
    publicType: 'HttpService',
  });
});

test('joins the current canonical catalogs without a missing, stale, or dispositionless row', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const [definePluginSource, servicesSource, apiInventory] = await Promise.all([
    readFile(resolve(packageRoot, 'src/definePlugin.ts'), 'utf8'),
    readFile(resolve(packageRoot, 'src/services/index.ts'), 'utf8'),
    readCurrentApiInventory(packageRoot),
  ]);
  const services = readPluginServicesCapabilityCatalog(servicesSource);
  const matrix = projectCapabilityMatrix({
    contributionCatalog: PLUGIN_CONTRIBUTION_CATALOG_V2,
    hostAccessCatalog: PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
    definePluginPolicy: readDefinePluginCapabilityPolicy(definePluginSource),
    apiInventory,
    services,
    metadata: deriveCapabilityMatrixMetadata({
      contributionCatalog: PLUGIN_CONTRIBUTION_CATALOG_V2,
      hostAccessCatalog: PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
      apiInventory,
      services,
      declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
    }),
  });

  assert.equal(matrix.manifestFamilies.length, PLUGIN_CONTRIBUTION_CATALOG_V2.length);
  const capture = matrix.manifestFamilies.find((row) => row.manifestFamily === 'captureSources');
  assert.equal(capture.availabilityDisposition, 'available');
  assert.equal(capture.specialistOwner, CAPABILITY_HOST_BINDING_OWNERS_V1.contributionRuntimeRegistration);
  assert.equal(capture.lifecycleOwner, CAPABILITY_HOST_BINDING_OWNERS_V1.contributionActivationLifecycle);
  assert.equal(capture.loadedPlatformProof, 'not-recorded');
  assert.equal(capture.provingConsumer, null);
  assert.equal(matrix.services.length, services.length);
  assert.equal(matrix.hostAccess.length, PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.length);
  assert.equal(matrix.subpaths.length, apiInventory.entrypoints.filter((entry) => entry.visibility === 'author').length);
  assert.deepEqual(matrix.hostAccess.find((row) => row.capability === 'terminal'), {
    capability: 'terminal',
    authorizationClass: 'presentIntentOrOs',
    realm: 'daemon',
    producer: 'packages/protocol/src/plugins/manifest/v2.ts#terminal',
    lifecycle: 'session-runtime',
    provingConsumer: 'packages/plugins/claude/src/manifest.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    lifecycleOwner: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
    sourceApiAvailability: 'present',
    sourceConsumer: null,
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
  assert.deepEqual(
    matrix.manifestFamilies.find((row) => row.manifestFamily === 'composerReferences'),
    {
      manifestFamily: 'composerReferences',
      pluginApiRegistrationFamily: 'composerReferences',
      registrationHost: 'daemon',
      definePluginAuthorKey: 'composer',
      definePluginInputShape: 'structured',
      definePluginClassification: 'adapter',
      authorEntrypoint: '.',
      realm: 'any',
      lifecycle: ['declared', 'normalized', 'projected', 'bound', 'active', 'unavailable', 'invalid'],
      catalogDisposition: 'reshaped',
      producer: 'packages/protocol/src/plugins/contributions/catalog.ts#composerReferences',
      provingConsumer: 'packages/plugin-ui/fixtures/external-authoring/src/index.ts',
      specialistOwner: 'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts',
      lifecycleOwner: 'apps/cli/src/plugins/runtime/lifecycle/manager.ts',
      predecessorRemoval: 'catalog-disposition:reshaped',
      availabilityDisposition: 'available',
      sourceApiAvailability: 'present',
      sourceConsumer: null,
      loadedPlatformProof: 'not-recorded',
      releaseAvailability: 'not-published',
    },
  );
  assert.equal(matrix.hostAccess.some((entry) => entry.capability === 'network.intercept'), false);
  for (const capability of ['browser', 'clipboard', 'externalLinks']) {
    const row = matrix.hostAccess.find((entry) => entry.capability === capability);
    assert.equal(row?.producer, `packages/protocol/src/plugins/manifest/v2.ts#${capability}`);
    assert.equal(row?.lifecycle, 'declaration-only');
    assert.equal(row?.specialistOwner, null);
    assert.equal(row?.lifecycleOwner, null);
    assert.equal(row?.availabilityDisposition, 'deferred');
    assert.equal(row?.provingConsumer, null);
  }
});

test('plans one deterministic capability-matrix artifact from the same public inventory input', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const apiInventory = await readCurrentApiInventory(packageRoot);
  const output = await createCapabilityMatrixOutput({ packageRoot, apiInventory });

  assert.equal(output.owner, 'capabilityMatrix');
  assert.equal(output.relativePath, 'capability-matrix.json');
  assert.deepEqual(JSON.parse(output.contents).subpaths.map((row) => row.specifier), [
    ...apiInventory.entrypoints
      .filter((entry) => entry.visibility === 'author')
      .map((entry) => entry.specifier)
      .sort(),
  ]);
});

test('plans the current author-source matrix through the sole publisher output', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const apiInventory = await readCurrentApiInventory(packageRoot);
  const output = await createCapabilityMatrixOutput({ packageRoot, apiInventory });
  const matrix = JSON.parse(output.contents);

  assert.equal(matrix.subpaths.some((row) => row.specifier === './automations'), true);
  assert.equal(matrix.subpaths.some((row) => row.specifier === './protocol'), true);
  assert.equal(matrix.subpaths.some((row) => row.specifier === './contributions'), true);
  assert.deepEqual(matrix.services.find((row) => row.serviceId === 'targetedContributions'), {
    serviceId: 'targetedContributions',
    property: 'targetedContributions',
    publicType: 'TargetedContributionsService',
    authorEntrypoints: ['.'],
    realms: ['daemon'],
    producer: 'src/services/targetedContributions.ts',
    lifecycle: 'invocation-scoped',
    provingConsumer: 'packages/plugins/channels/src/ingress.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/invocation/services/production.ts',
    lifecycleOwner: 'apps/cli/src/plugins/runtime/invocation/lifetime.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
    sourceApiAvailability: 'present',
    sourceConsumer: null,
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
});

test('every available row carries its declaration owner, realm binder/projection, lifecycle owner, and supported realm in one matrix', async () => {
  // r0.74: availability is a fact of the canonical producer (declaration
  // owner), the public registration/projection and binder in the applicable
  // realm (specialist owner + lifecycle), and that realm's support — recorded
  // together in the one canonical matrix. A maintained consumer stays optional
  // separately-truthful evidence and never appears as an availability fact.
  const packageRoot = resolve(import.meta.dirname, '..');
  const [definePluginSource, servicesSource, apiInventory] = await Promise.all([
    readFile(resolve(packageRoot, 'src/definePlugin.ts'), 'utf8'),
    readFile(resolve(packageRoot, 'src/services/index.ts'), 'utf8'),
    readCurrentApiInventory(packageRoot),
  ]);
  const services = readPluginServicesCapabilityCatalog(servicesSource);
  const matrix = projectCapabilityMatrix({
    contributionCatalog: PLUGIN_CONTRIBUTION_CATALOG_V2,
    hostAccessCatalog: PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
    definePluginPolicy: readDefinePluginCapabilityPolicy(definePluginSource),
    apiInventory,
    services,
    metadata: deriveCapabilityMatrixMetadata({
      contributionCatalog: PLUGIN_CONTRIBUTION_CATALOG_V2,
      hostAccessCatalog: PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
      apiInventory,
      services,
      declarations: CAPABILITY_MATRIX_DECLARATIONS_V1,
    }),
  });

  const rowId = (group, row) => `${group}:${row.manifestFamily ?? row.serviceId ?? row.capability ?? row.specifier}`;
  const lifecycleStages = (lifecycle) => (Array.isArray(lifecycle) ? lifecycle : [lifecycle]);
  const supportedRealm = (row) => (row.realms !== undefined
    ? (Array.isArray(row.realms) && row.realms.length > 0 ? row.realms : null)
    : (typeof row.realm === 'string' && row.realm !== '' ? row.realm : null));

  for (const group of ['manifestFamilies', 'services', 'hostAccess', 'subpaths']) {
    for (const row of matrix[group]) {
      const id = rowId(group, row);
      if (row.availabilityDisposition !== 'available') {
        // Deferred rows assert no optional consumer evidence, no host binder or
        // lifecycle owner, and name exactly what would unblock them in the
        // applicable realm.
        assert.equal(row.provingConsumer, null, id);
        assert.equal(row.specialistOwner, null, id);
        assert.equal(row.lifecycleOwner, null, id);
        assert.equal(typeof row.unblockCondition === 'string' && row.unblockCondition !== '', true, id);
        continue;
      }
      assert.equal(typeof row.producer === 'string' && row.producer !== '', true, `${id} declaration owner`);
      assert.equal(
        HOST_BINDING_OWNER_MODULES.has(row.specialistOwner),
        true,
        `${id} realm binder/projection owner: ${row.specialistOwner}`,
      );
      assert.equal(
        HOST_BINDING_OWNER_MODULES.has(row.lifecycleOwner),
        true,
        `${id} runtime lifecycle owner: ${row.lifecycleOwner}`,
      );
      assert.notEqual(row.specialistOwner, row.producer, `${id} must not self-prove its binder`);
      assert.notEqual(row.lifecycleOwner, row.producer, `${id} must not self-prove its lifecycle`);
      assert.equal(
        lifecycleStages(row.lifecycle).length > 0 && lifecycleStages(row.lifecycle).every((stage) => stage !== ''),
        true,
        `${id} runtime lifecycle owner`,
      );
      assert.notEqual(supportedRealm(row), null, `${id} supported realm`);
    }
  }
});
