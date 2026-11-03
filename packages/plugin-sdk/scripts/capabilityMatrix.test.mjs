import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2 } from '@happier-dev/protocol/plugins/manifest/v2';

import {
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

function metadata(overrides = {}) {
  return Object.freeze({
    manifestFamilies: Object.freeze({
      actions: Object.freeze({
        producer: 'packages/protocol/src/plugins/contributions/catalog.ts#actions',
        availabilityDisposition: 'available',
      }),
    }),
    services: Object.freeze({
      http: Object.freeze({
        producer: 'src/services/io.ts',
        lifecycle: 'invocation-scoped',
        availabilityDisposition: 'available',
      }),
    }),
    hostAccess: Object.freeze({
      'network.client': Object.freeze({
        producer: 'packages/protocol/src/plugins/manifest/v2.ts#network.client',
        lifecycle: 'invocation-scoped',
        availabilityDisposition: 'available',
      }),
    }),
    subpaths: Object.freeze({
      '.': Object.freeze({
        producer: 'src/index.ts',
        lifecycle: 'published',
        availabilityDisposition: 'available',
      }),
      './http': Object.freeze({
        producer: 'src/http/index.ts',
        lifecycle: 'published',
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

test('language servers expose descriptor authoring and applicable lifecycle', async () => {
  const contributionCatalog = [{
    manifestKey: 'languageServers',
    allowedRuntimeRegistration: null,
    registrationHost: null,
    consumer: 'language-server-host',
    lifecycleStages: ['declared', 'normalized', 'projected', 'bound', 'active', 'unavailable', 'invalid'],
    disposition: 'retained',
  }];
  const apiInventory = {
    entrypoints: [API_INVENTORY.entrypoints[0]],
    symbols: [API_INVENTORY.symbols[0]],
  };
  const declarations = {
    manifestFamilies: { languageServers: CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.languageServers },
    services: {},
    hostAccess: {},
    subpaths: { '.': CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['.'] },
  };
  const definePluginSource = await readFile(new URL('../src/definePlugin.ts', import.meta.url), 'utf8');
  const policy = readDefinePluginCapabilityPolicy(definePluginSource);
  const matrix = projectCapabilityMatrix({
    contributionCatalog,
    hostAccessCatalog: [],
    apiInventory,
    services: [],
    definePluginPolicy: { languageServers: policy.languageServers },
    metadata: deriveCapabilityMatrixMetadata({
      contributionCatalog, hostAccessCatalog: [], apiInventory, services: [], declarations,
    }),
  });
  assert.deepEqual(matrix.manifestFamilies[0], {
    manifestFamily: 'languageServers',
    pluginApiRegistrationFamily: null,
    registrationHost: null,
    definePluginAuthorKey: 'languageServers',
    definePluginInputShape: 'descriptor',
    definePluginClassification: 'descriptor-only',
    authorEntrypoint: '.',
    realm: 'any',
    lifecycle: contributionCatalog[0].lifecycleStages,
    catalogDisposition: 'retained',
    producer: 'packages/protocol/src/plugins/contributions/catalog.ts#languageServers',
    availabilityDisposition: 'available',
  });
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

test('derives the portable Account service subset from the public invocation context', async () => {
  const packageRoot = resolve(import.meta.dirname, '..');
  const [servicesSource, accountContextSource] = await Promise.all([
    readFile(resolve(packageRoot, 'src/services/index.ts'), 'utf8'),
    readFile(resolve(packageRoot, 'src/actions/contracts.ts'), 'utf8'),
  ]);
  const services = readPluginServicesCapabilityCatalog(servicesSource, accountContextSource);
  assert.deepEqual(services.find(row => row.id === 'actions').accountInvocation, {
    members: ['execute', 'executeAdmittedTargetedOperation', 'observe', 'observeAdmittedTargetedOperation'],
  });
  assert.deepEqual(services.find(row => row.id === 'storage').accountInvocation, { members: ['account'] });
  assert.deepEqual(services.find(row => row.id === 'targetedContributions').accountInvocation, { members: 'all' });
  assert.deepEqual(services.find(row => row.id === 'machineConnectorSecrets'), {
    id: 'machineConnectorSecrets',
    property: 'machineConnectorSecrets',
    publicType: 'MachineConnectorSecretsService',
    accountInvocation: { members: 'all' },
  });
  assert.deepEqual(services.find(row => row.id === 'http').accountInvocation, { members: 'all' });
  assert.deepEqual(services.find(row => row.id === 'connectedAccounts').accountInvocation, {
    members: ['getBinding', 'listAccounts', 'materialize', 'materializeListedAccount'],
  });
  for (const id of ['sessions', 'fs', 'exec']) {
    assert.equal(services.find(row => row.id === id).accountInvocation, undefined);
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
      && error.diagnostics.includes('hostAccess.network.client availabilityDisposition must be available, preview, deferred, or retired'),
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
        'manifestFamilies.actions availabilityDisposition must be available, preview, deferred, or retired',
      )
      && error.diagnostics.includes(
        'services.http availabilityDisposition must be available, preview, deferred, or retired',
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
          unblockCondition: undefined,
        }),
      }),
      services: Object.freeze({
        http: Object.freeze({
          ...metadata().services.http,
          availabilityDisposition: 'deferred',
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

  assert.deepEqual(
    matrix.manifestFamilies.map(row => row.manifestFamily),
    PLUGIN_CONTRIBUTION_CATALOG_V2.map(row => row.manifestKey).sort(),
  );
  for (const row of matrix.manifestFamilies) {
    assert.equal(
      row.availabilityDisposition,
      CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[row.manifestFamily].availabilityDisposition,
      row.manifestFamily,
    );
  }
  assert.equal(matrix.subpaths.some((row) => row.specifier === './automations'), true);
  assert.equal(matrix.subpaths.some((row) => row.specifier === './protocol'), true);
  assert.equal(matrix.subpaths.some((row) => row.specifier === './contributions'), true);

});


test('projects implemented Preview families without demanding consumer or lifecycle proof', () => {
  const matrix = project({
    manifestFamilies: {
      actions: {
        ...metadata().manifestFamilies.actions,
        availabilityDisposition: 'preview',
      },
    },
  });
  assert.equal(matrix.manifestFamilies[0].availabilityDisposition, 'preview');
  assert.deepEqual(
    { ...matrix.manifestFamilies[0], availabilityDisposition: 'available' },
    project().manifestFamilies[0],
  );
});

test('publishes only author availability facts rather than internal proof ledgers', () => {
  const matrix = project();
  assert.deepEqual(matrix.manifestFamilies[0], {
    manifestFamily: 'actions',
    pluginApiRegistrationFamily: 'actions',
    registrationHost: 'daemon',
    definePluginAuthorKey: 'actions',
    definePluginInputShape: 'structured',
    definePluginClassification: 'adapter',
    authorEntrypoint: '.',
    realm: 'any',
    lifecycle: ['declared', 'active'],
    catalogDisposition: 'reshaped',
    producer: 'packages/protocol/src/plugins/contributions/catalog.ts#actions',
    availabilityDisposition: 'available',
  });
  for (const group of Object.values(matrix).filter(Array.isArray)) {
    for (const row of group) {
      for (const field of [
        'provingConsumer', 'specialistOwner', 'lifecycleOwner',
        'predecessorRemoval', 'sourceApiAvailability', 'sourceConsumer',
        'loadedPlatformProof', 'releaseAvailability',
      ]) assert.equal(Object.hasOwn(row, field), false, field);
    }
  }
});
