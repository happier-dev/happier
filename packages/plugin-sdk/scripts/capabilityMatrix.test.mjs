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
  CapabilityMatrixValidationError,
  capabilityMatrixProvingConsumerExerciseFailure,
  deriveCapabilityMatrixMetadata,
  projectCapabilityMatrix,
  readDefinePluginCapabilityPolicy,
  readPluginServicesCapabilityCatalog,
} from './capabilityMatrix.mjs';
import {
  createCapabilityMatrixOutput,
  resolveAvailableCapabilityMatrixProvingConsumerSourcePaths,
  selectAvailableCapabilityMatrixProvingConsumerSourcePaths,
} from './capabilityMatrixCli.mjs';
import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';
import {
  readCurrentApiSurfaceInventory,
} from './apiSurfaceCli.mjs';

function assertDeferredExternalDevelopmentProof(declaration) {
  assert.equal(declaration.availabilityDisposition, 'deferred');
  assert.equal(declaration.provingConsumer, 'no current positive consumer');
  assert.match(declaration.unblockCondition, /maintained external development-source plugin/u);
  assert.match(declaration.unblockCondition, /current loaded development stack/u);
  assert.match(declaration.unblockCondition, /real invocation/u);
  assert.match(declaration.unblockCondition, /currentness/u);
}

test('accepts the canonical Account storage guard as a storage service invocation', () => {
  const source = [
    "import { requireAccountStorage } from '@happier-dev/plugin-sdk/storage';",
    'export const run = (context) => requireAccountStorage(context, {',
    "  code: 'storage_unavailable',",
    "  message: 'Storage is required.',",
    '});',
  ].join('\n');

  assert.equal(
    capabilityMatrixProvingConsumerExerciseFailure({ serviceId: 'storage' }, source),
    null,
  );
});

test('rejects storage guard text that is not a named SDK import and call', () => {
  for (const source of [
    [
      "const sdk = '@happier-dev/plugin-sdk/storage';",
      'function requireAccountStorage() {}',
      'requireAccountStorage();',
    ].join('\n'),
    [
      "// import { requireAccountStorage } from '@happier-dev/plugin-sdk/storage';",
      'function requireAccountStorage() {}',
      'requireAccountStorage();',
    ].join('\n'),
    [
      "import storage from '@happier-dev/plugin-sdk/storage';",
      'storage.requireAccountStorage();',
    ].join('\n'),
  ]) {
    assert.equal(
      capabilityMatrixProvingConsumerExerciseFailure({ serviceId: 'storage' }, source),
      'does not invoke services.storage',
    );
  }
});

test('rejects comments and unrelated literals as capability exercise evidence', () => {
  const cases = [
    [{ specifier: './events' }, "// import '@happier-dev/plugin-sdk/events';"],
    [{ serviceId: 'events' }, "const note = 'context.services.events';"],
    [{ capability: 'network.client' }, "const note = 'network.client';"],
    [{ manifestFamily: 'actions', definePluginAuthorKey: 'actions' }, "// definePlugin({ actions: [] });"],
  ];

  for (const [row, source] of cases) {
    assert.notEqual(capabilityMatrixProvingConsumerExerciseFailure(row, source), null);
  }
});

test('accepts syntax-owned imports, service access, HostAccess, and definePlugin declarations', () => {
  const cases = [
    [{ specifier: './events' }, "import type { EventsService } from '@happier-dev/plugin-sdk/events';"],
    [{ serviceId: 'events' }, 'export const run = (context) => context.services.events.plugin.emit(\'ready\');'],
    [{ capability: 'network.client' }, "definePlugin({ hostAccess: { required: [{ capability: 'network.client' }] } });"],
    [{ manifestFamily: 'mcp.discoverySources', definePluginAuthorKey: 'mcp' }, 'definePlugin({ mcp: { discoverySources: {} } });'],
  ];

  for (const [row, source] of cases) {
    assert.equal(capabilityMatrixProvingConsumerExerciseFailure(row, source), null);
  }
});

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

function metadata(overrides = {}) {
  return Object.freeze({
    manifestFamilies: Object.freeze({
      actions: Object.freeze({
        producer: 'apps/cli/src/plugins/runtime/invocation/targetActionRegistry.ts',
        provingConsumer: 'packages/plugins/channels/src/manifest.ts',
        specialistOwner: 'SDK-ACTION-03',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    services: Object.freeze({
      http: Object.freeze({
        producer: 'apps/cli/src/plugins/runtime/invocation/services/factory.ts',
        lifecycle: 'invocation-scoped',
        provingConsumer: 'packages/plugins/channel-telegram/src/channelActions.ts',
        specialistOwner: 'SDK-NETWORK-01',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    hostAccess: Object.freeze({
      'network.client': Object.freeze({
        producer: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
        lifecycle: 'invocation-scoped',
        provingConsumer: 'packages/plugins/channels',
        specialistOwner: 'SDK-NETWORK-01',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
    }),
    subpaths: Object.freeze({
      '.': Object.freeze({
        producer: 'src/index.ts',
        lifecycle: 'published',
        provingConsumer: 'packages/plugins/channels',
        specialistOwner: 'SDK-PUBLIC-SURFACE',
        predecessorRemoval: 'none',
        availabilityDisposition: 'available',
      }),
      './http': Object.freeze({
        producer: 'src/http/index.ts',
        lifecycle: 'published',
        provingConsumer: 'packages/plugins/channels',
        specialistOwner: 'SDK-NETWORK-01',
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

test('derives operation-only targeted contribution availability through the maintained PostHog manifest', () => {
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
    specialistOwner: 'packages/protocol/src/plugins/contributions/catalog.ts#targetedPluginContributions',
    predecessorRemoval: `catalog-disposition:${targetedContributionCatalogEntry.disposition}`,
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/posthog/src/manifest.ts',
    sourceApiAvailability: 'present',
    sourceConsumer: 'packages/plugins/posthog/src/manifest.ts',
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
});

test('keeps MCP servers deferred until a maintained plugin author declares and registers one', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies['mcp.servers'], {
    availabilityDisposition: 'deferred',
    provingConsumer: 'no current positive consumer',
    unblockCondition: 'A maintained plugin author declares and registers an MCP server through the canonical MCP lifecycle.',
  });
});

test('keeps Tools and Commands deferred until loaded development-source proof', () => {
  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.commands);
  assert.match(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.commands.unblockCondition, /canonical plugin command catalog/u);
  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.tools);
  assert.match(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.tools.unblockCondition, /real daemon MCP catalog/u);
});

test('keeps unproven invocation services deferred until loaded development-source proof', () => {
  for (const service of ['events', 'fs', 'providers', 'resources']) {
    assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.services[service]);
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
    producer: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
    lifecycle: 'session-runtime',
    provingConsumer: 'packages/plugins/claude/src/manifest.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
    sourceApiAvailability: 'present',
    sourceConsumer: 'packages/plugins/claude/src/manifest.ts',
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
  assert.equal(Object.hasOwn(metadata.hostAccess, 'network.intercept'), false);
  for (const capability of ['browser', 'clipboard', 'externalLinks']) {
    const row = metadata.hostAccess[capability];
    assert.equal(row.producer, 'packages/protocol/src/plugins/manifest/v2.ts');
    assert.equal(row.lifecycle, 'declaration-only');
    assert.equal(row.specialistOwner, 'apps/cli/src/plugins/runtime/lifecycle/activation/policy.ts');
    assert.equal(row.availabilityDisposition, 'deferred');
    assert.equal(row.provingConsumer, 'no current positive consumer');
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

test('rejects an available capability whose only proof is the host binder', () => {
  assert.throws(
    () => project({
      hostAccess: Object.freeze({
        'network.client': Object.freeze({
          ...metadata().hostAccess['network.client'],
          provingConsumer: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'hostAccess.network.client provingConsumer must name a maintained public plugin/example consumer, not a host binder',
      ),
  );
});

test('rejects an available manifest family whose proof is only its catalog owner label', () => {
  assert.throws(
    () => project({
      manifestFamilies: Object.freeze({
        actions: Object.freeze({
          ...metadata().manifestFamilies.actions,
          availabilityDisposition: 'available',
          provingConsumer: 'packages/protocol/src/plugins/contributions/catalog.ts#actions',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'manifestFamilies.actions provingConsumer must name a maintained public plugin/example consumer, not a host binder',
      ),
  );
});

test('rejects an available service whose proof self-references PluginServices', () => {
  assert.throws(
    () => project({
      services: Object.freeze({
        http: Object.freeze({
          ...metadata().services.http,
          availabilityDisposition: 'available',
          provingConsumer: 'packages/plugin-sdk/src/services/index.ts#PluginServices.http',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'services.http provingConsumer must name a maintained public plugin/example consumer, not a host binder',
      ),
  );
});

test('rejects an available capability whose proving leaf is also its source owner', () => {
  assert.throws(
    () => project({
      manifestFamilies: Object.freeze({
        actions: Object.freeze({
          ...metadata().manifestFamilies.actions,
          producer: 'packages/plugins/channels/src/manifest.ts#actions',
          provingConsumer: 'packages/plugins/channels/src/manifest.ts',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'manifestFamilies.actions provingConsumer must name a distinct maintained public plugin/example leaf, not its producer or specialist owner',
      ),
  );
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

test('requires manifest-family and service deferred rows to name no current consumer and an unblock', () => {
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
        'manifestFamilies.actions deferred provingConsumer must be "no current positive consumer"',
      )
      && error.diagnostics.includes(
        'services.http.unblockCondition must be a non-empty string',
      )
      && error.diagnostics.includes(
        'services.http deferred provingConsumer must be "no current positive consumer"',
      ),
  );
});

test('rejects an available public subpath whose proof is outside the public plugin/example corridor', () => {
  assert.throws(
    () => project({
      subpaths: Object.freeze({
        ...metadata().subpaths,
        './http': Object.freeze({
          ...metadata().subpaths['./http'],
          provingConsumer: 'packages/plugin-sdk/fixtures/authoring-inference/run.ts',
        }),
      }),
    }),
    (error) => error instanceof CapabilityMatrixValidationError
      && error.diagnostics.includes(
        'subpaths../http provingConsumer must name a maintained public plugin/example consumer, not a host binder',
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
  assert.equal(matrix.services.length, services.length);
  assert.equal(matrix.hostAccess.length, PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.length);
  assert.equal(matrix.subpaths.length, apiInventory.entrypoints.filter((entry) => entry.visibility === 'author').length);
  assert.deepEqual(matrix.hostAccess.find((row) => row.capability === 'terminal'), {
    capability: 'terminal',
    authorizationClass: 'presentIntentOrOs',
    producer: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
    lifecycle: 'session-runtime',
    provingConsumer: 'packages/plugins/claude/src/manifest.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
    sourceApiAvailability: 'present',
    sourceConsumer: 'packages/plugins/claude/src/manifest.ts',
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
      specialistOwner: 'packages/protocol/src/plugins/contributions/catalog.ts#composerReferences',
      predecessorRemoval: 'catalog-disposition:reshaped',
      availabilityDisposition: 'available',
      sourceApiAvailability: 'present',
      sourceConsumer: 'packages/plugin-ui/fixtures/external-authoring/src/index.ts',
      loadedPlatformProof: 'not-recorded',
      releaseAvailability: 'not-published',
    },
  );
  assert.equal(matrix.hostAccess.some((entry) => entry.capability === 'network.intercept'), false);
  for (const capability of ['browser', 'clipboard', 'externalLinks']) {
    const row = matrix.hostAccess.find((entry) => entry.capability === capability);
    assert.equal(row?.producer, 'packages/protocol/src/plugins/manifest/v2.ts');
    assert.equal(row?.lifecycle, 'declaration-only');
    assert.equal(row?.specialistOwner, 'apps/cli/src/plugins/runtime/lifecycle/activation/policy.ts');
    assert.equal(row?.availabilityDisposition, 'deferred');
    assert.equal(row?.provingConsumer, 'no current positive consumer');
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

test('rejects an available capability whose declared public consumer path is absent', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const apiInventory = await readCurrentApiInventory(packageRoot);
  await assert.rejects(
    createCapabilityMatrixOutput({
      packageRoot,
      apiInventory,
      declarations: Object.freeze({
        ...CAPABILITY_MATRIX_DECLARATIONS_V1,
        hostAccess: Object.freeze({
          ...CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess,
          network: Object.freeze({
            availabilityDisposition: 'available',
            provingConsumer: 'packages/plugins/not-a-real-plugin/src/consumer.ts',
          }),
        }),
      }),
    }),
    /hostAccess\.network provingConsumer path does not name a regular file/u,
  );
});

test('rejects an available capability whose declared consumer never exercises the family', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const apiInventory = await readCurrentApiInventory(packageRoot);
  await assert.rejects(
    createCapabilityMatrixOutput({
      packageRoot,
      apiInventory,
      declarations: Object.freeze({
        ...CAPABILITY_MATRIX_DECLARATIONS_V1,
        subpaths: Object.freeze({
          ...CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths,
          './mcp': Object.freeze({
            availabilityDisposition: 'available',
            // A real, maintained, regular file that never imports the subpath:
            // the path check alone reports this row as proven.
            provingConsumer: 'packages/plugins/opencode/src/activate.ts',
          }),
        }),
      }),
    }),
    /subpaths\.\.\/mcp provingConsumer packages\/plugins\/opencode\/src\/activate\.ts does not import @happier-dev\/plugin-sdk\/mcp/u,
  );
});

test('rejects an available manifest family whose declared consumer has no matching definePlugin author key', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const apiInventory = await readCurrentApiInventory(packageRoot);
  await assert.rejects(
    createCapabilityMatrixOutput({
      packageRoot,
      apiInventory,
      declarations: Object.freeze({
        ...CAPABILITY_MATRIX_DECLARATIONS_V1,
        manifestFamilies: Object.freeze({
          ...CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies,
          'mcp.discoverySources': Object.freeze({
            availabilityDisposition: 'available',
            provingConsumer: 'packages/plugins/claude/src/agent/mcp/configServers.ts',
          }),
        }),
      }),
    }),
    /manifestFamilies\.mcp\.discoverySources provingConsumer .* does not declare the 'mcp' definePlugin contribution key/u,
  );
});

test('selects each distinct available proving-consumer source path for package staging', () => {
  const paths = selectAvailableCapabilityMatrixProvingConsumerSourcePaths({
    manifestFamilies: Object.freeze([
      Object.freeze({ availabilityDisposition: 'available', provingConsumer: 'packages/plugins/channels/src/manifest.ts' }),
      Object.freeze({ availabilityDisposition: 'deferred', provingConsumer: 'no current positive consumer' }),
    ]),
    services: Object.freeze([
      Object.freeze({ availabilityDisposition: 'available', provingConsumer: 'packages/plugins/review-deepsec/src/agent/reviews/execution.ts' }),
    ]),
    hostAccess: Object.freeze([
      Object.freeze({ availabilityDisposition: 'available', provingConsumer: 'packages/plugins/gemini/src/connectedAccounts/runtime.ts' }),
      Object.freeze({ availabilityDisposition: 'deferred', provingConsumer: 'no current positive consumer' }),
    ]),
    subpaths: Object.freeze([
      Object.freeze({ availabilityDisposition: 'available', provingConsumer: 'packages/plugins/gemini/src/connectedAccounts/runtime.ts' }),
      Object.freeze({ availabilityDisposition: 'available', provingConsumer: 'packages/plugins/channels/src/activate.ts' }),
    ]),
  });

  assert.deepEqual(paths, [
    'packages/plugins/channels/src/activate.ts',
    'packages/plugins/channels/src/manifest.ts',
    'packages/plugins/gemini/src/connectedAccounts/runtime.ts',
    'packages/plugins/review-deepsec/src/agent/reviews/execution.ts',
  ]);
  assert.equal(Object.isFrozen(paths), true);
});

test('stages the maintained external author proof for available browser and request-policy capability rows', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const paths = await resolveAvailableCapabilityMatrixProvingConsumerSourcePaths({ packageRoot });

  assert.equal(paths.includes('packages/plugins/gemini/src/connectedAccounts/runtime.ts'), true);
  assert.equal(paths.includes('packages/plugins/channels/src/manifest.ts'), true);
  assert.equal(paths.includes('packages/plugins/channels/src/ingress.ts'), true);
  assert.equal(paths.includes('packages/plugins/channels/src/bindingTransition.ts'), true);
  assert.equal(paths.includes('packages/plugins/posthog/src/manifest.ts'), true);
  assert.equal(paths.includes('packages/tests/fixtures/plugin-platform/out-of-tree-channel-socket-provider/src/index.mjs'), true);
  assert.equal(paths.includes('packages/tests/fixtures/plugin-platform/packed-targeted-contribution-projection/public-protocol.ts'), true);
  assert.equal(paths.includes('packages/plugin-sdk/examples/action-contract-producer/src/index.ts'), true);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, [...paths].sort());
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
    realms: ['any'],
    producer: 'src/services/targetedContributions.ts',
    lifecycle: 'invocation-scoped',
    provingConsumer: 'packages/plugins/channels/src/ingress.ts',
    specialistOwner: 'packages/plugin-sdk/src/services/index.ts#PluginServices.targetedContributions',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
    sourceApiAvailability: 'present',
    sourceConsumer: 'packages/plugins/channels/src/ingress.ts',
    loadedPlatformProof: 'not-recorded',
    releaseAvailability: 'not-published',
  });
});
