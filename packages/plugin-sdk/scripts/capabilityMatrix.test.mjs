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
      stability: 'preview',
    }),
    Object.freeze({
      specifier: './http',
      exportName: 'HttpService',
      kind: 'type',
      sourceModule: 'src/services/io.ts',
      sourceExport: 'HttpService',
      realm: 'any',
      stability: 'preview',
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

test('declares protocol and contribution authoring with their maintained Channels manifest consumer', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./protocol'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channels/src/manifest.ts',
  });
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./contributions'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channels/src/manifest.ts',
  });
});

test('source publication spec closes the public testkit mount contract family', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const publicSpec = ts.createSourceFile(
    'src/testing/index.public.ts',
    await readFile(resolve(packageRoot, 'src/testing/index.public.ts'), 'utf8'),
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
    .flatMap((statement) => {
      const experimental = ts.getJSDocCommentsAndTags(statement)
        .some((comment) => /@experimental\b/u.test(comment.getText()));
      return statement.exportClause.elements.map((element) => ({
        name: element.name.text,
        experimental,
      }));
    })
    .filter((symbol) => symbol.name.startsWith('PluginUiTestkitMount'))
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.deepEqual(mountContractSymbols, [
    { name: 'PluginUiTestkitMountAvailability', experimental: true },
    { name: 'PluginUiTestkitMountInput', experimental: true },
    { name: 'PluginUiTestkitMountOptions', experimental: true },
    { name: 'PluginUiTestkitMountResult', experimental: true },
  ]);
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

test('derives operation-only targeted contribution availability through the current catalog', () => {
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
    provingConsumer: 'packages/plugins/channel-discord/src/manifest.ts',
  });
});

test('keeps MCP servers deferred until a maintained plugin author declares and registers one', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies['mcp.servers'], {
    availabilityDisposition: 'deferred',
    provingConsumer: 'no current positive consumer',
    unblockCondition: 'A maintained plugin author declares and registers an MCP server through the canonical MCP lifecycle.',
  });
});

test('keeps tools deferred until a maintained plugin author declares one', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.tools, {
    availabilityDisposition: 'deferred',
    provingConsumer: 'no current positive consumer',
    unblockCondition: 'A maintained plugin author declares a tool and proves its canonical registration and invocation lifecycle.',
  });
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

test('declares network clients with their maintained Discord WebSocket runtime consumer', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess['network.client'], {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channel-discord/src/discordGatewayWorker.ts',
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
    provingConsumer: 'packages/plugins/claude/src/agent/runtime/terminal/unified/nativeSession.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
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
    provingConsumer: 'packages/plugins/claude/src/agent/runtime/terminal/unified/nativeSession.ts',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    predecessorRemoval: 'none',
    availabilityDisposition: 'available',
  });
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

test('resolves current available proving-consumer source leaves for package staging', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const paths = await resolveAvailableCapabilityMatrixProvingConsumerSourcePaths({ packageRoot });

  assert.equal(paths.includes('packages/plugins/gemini/src/connectedAccounts/runtime.ts'), true);
  assert.equal(paths.includes('packages/plugins/channels/src/manifest.ts'), true);
  assert.equal(paths.includes('packages/plugins/channels/src/ingress.ts'), true);
  assert.equal(paths.includes('packages/plugins/channel-discord/src/manifest.ts'), true);
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
  });
});
