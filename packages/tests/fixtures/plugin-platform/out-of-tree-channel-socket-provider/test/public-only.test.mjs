import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(fixtureRoot, relativePath), 'utf8'));
}

test('committed manifest is the current public source projection', async () => {
  const { manifest: sourceManifest } = await import('../src/index.mjs');
  const committedManifest = await readJson('.happier-plugin/plugin.json');
  const sourceProjection = JSON.parse(JSON.stringify(sourceManifest));

  assert.deepEqual(committedManifest, sourceProjection);
  // definePlugin projects only the families this author actually declared, so
  // an external provider ships no empty placeholder families at all.
  assert.deepEqual(
    Object.keys(committedManifest.contributes).sort(),
    ['actions', 'backgroundServices', 'resources', 'targetedPluginContributions'],
  );
});

test('public Channels protocol package exposes its explicit root and versioned entrypoints', async () => {
  const root = await import('@happier-dev/channels-protocol');
  const v1 = await import('@happier-dev/channels-protocol/v1');
  const testingV1 = await import('@happier-dev/channels-protocol/testing/v1');

  assert.equal(typeof root, 'object');
  assert.equal(typeof v1, 'object');
  assert.equal(typeof testingV1, 'object');
});

test('source fixture conforms through the public Channels V1 provider testkit', async () => {
  const testingV1 = await import('@happier-dev/channels-protocol/testing/v1');
  assert.equal(
    typeof testingV1.assertConversationProviderContributionV1,
    'function',
    'public /testing/v1 must export the provider-contribution assertion',
  );

  const { manifest } = await import('../src/index.mjs');
  const conformance = testingV1.assertConversationProviderContributionV1(manifest);

  assert.deepEqual(conformance.contribution.operations, {
    setup: 'fixture/setup',
    connectionTest: 'fixture/test',
    endpointResolve: 'fixture/endpoint',
    principalResolve: 'fixture/principal',
    messageDeliver: 'fixture/deliver',
    deliveryReconcile: 'fixture/reconcile',
    connectionStop: 'fixture/stop',
  });
});

test('fixture is a public-only packed provider shape', async () => {
  const packageJson = await readJson('package.json');
  const manifest = await readJson('.happier-plugin/plugin.json');

  assert.equal(packageJson.dependencies['@happier-dev/plugin-sdk'], '>=0.0.0 <1.0.0');
  assert.equal(packageJson.dependencies['@happier-dev/channels-protocol'], '>=0.0.0 <1.0.0');
  assert.equal(packageJson.dependencies['@happier-dev/protocol'], undefined);
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.main, './src/index.mjs');
  assert.deepEqual(packageJson.exports, { '.': './src/index.mjs' });
  assert.equal(typeof packageJson.scripts['typecheck:public'], 'string');
  assert.equal(typeof packageJson.scripts.build, 'string');
  assert.equal(packageJson.files.includes('assets'), true);
  assert.equal(packageJson.dependencies['@happier-dev/plugin-sdk'].startsWith('workspace:'), false);
  assert.equal(packageJson.dependencies['@happier-dev/channels-protocol'].startsWith('workspace:'), false);
  for (const retiredFamily of [
    'conversationChannels',
    'channelBridges',
    'extensions',
    'featureStores',
    'durableSources',
    'eventAutomations',
  ]) {
    assert.equal(Object.hasOwn(manifest.contributes, retiredFamily), false, retiredFamily);
  }
  assert.deepEqual(manifest.hostAccess.required[0], {
    id: 'fixture-network-client',
    capability: 'network.client',
    reason: 'Receive deterministic socket frames through the host-vended WebSocket client.',
    scope: {
      targets: [{ kind: 'fixedOrigin', origin: 'https://channels-fixture.invalid' }],
      transports: ['websocket'],
      privateNetwork: false,
    },
  });
  assert.deepEqual(
    manifest.contributes.actions.map(({ id }) => id),
    [
      'fixture/setup',
      'fixture/test',
      'fixture/endpoint',
      'fixture/principal',
      'fixture/stop',
      'fixture/deliver',
      'fixture/reconcile',
    ],
  );
  for (const action of manifest.contributes.actions) {
    assert.deepEqual(action.surfaces, ['plugin']);
    assert.equal(action.placement, undefined);
  }
  const actionsById = new Map(manifest.contributes.actions.map((action) => [action.id, action]));
  assert.equal(actionsById.get('fixture/deliver')?.dangerLevel, 'writesRemote');
  assert.equal(actionsById.get('fixture/stop')?.dangerLevel, 'writesRemote');
  assert.deepEqual(manifest.contributes.actions[0].surfaces, ['plugin']);
  assert.equal(manifest.contributes.actions[0].placement, undefined);
  assert.equal(
    manifest.contributes.actions.some(({ id }) => id === 'fixture/observations-poll'),
    false,
  );
  // The external provider only contributes; it declares no point of its own,
  // and an undeclared family is omitted rather than emitted empty.
  assert.equal(Object.hasOwn(manifest.contributes, 'pluginContributionPoints'), false);
  assert.deepEqual(manifest.contributes.targetedPluginContributions, [{
    id: 'fixture-socket',
    target: { pluginId: 'happier.channels', pointId: 'providers' },
    protocol: { id: 'happier.channels/providers', version: 1 },
    operations: {
      setup: 'fixture/setup',
      connectionTest: 'fixture/test',
      endpointResolve: 'fixture/endpoint',
      principalResolve: 'fixture/principal',
      messageDeliver: 'fixture/deliver',
      deliveryReconcile: 'fixture/reconcile',
      connectionStop: 'fixture/stop',
    },
  }]);
  assert.equal(manifest.contributes.targetedPluginContributions[0].operations.observationsPoll, undefined);
  assert.deepEqual(manifest.contributes.actions[0].inputHints.fields.map(({ path, widget, required }) => ({
    path,
    widget,
    required,
  })), [
    { path: 'socketUrl', widget: 'url', required: true },
    { path: 'pairingCode', widget: 'secret', required: true },
  ]);
  assert.deepEqual(manifest.brand, { iconResourceId: 'brand-icon' });
  assert.deepEqual(manifest.contributes.resources, [
    {
      id: 'brand-icon',
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
    {
      id: 'status-v1',
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/json',
      scope: 'global',
      maxBytes: 16384,
    },
  ]);
  const brandBytes = await readFile(join(fixtureRoot, 'assets', 'brand.png'));
  assert.deepEqual([...brandBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(manifest.contributes.backgroundServices.map(({ id }) => id), ['socket-observer']);
});

test('fixture has a real daemon entrypoint and no private implementation imports', async () => {
  const manifest = await readJson('.happier-plugin/plugin.json');
  const entrypoint = manifest.entrypoints?.daemon;
  assert.equal(typeof entrypoint, 'string');
  const source = await readFile(join(fixtureRoot, entrypoint), 'utf8');
  assert.match(source, /@happier-dev\/plugin-sdk/u);
  assert.match(source, /@happier-dev\/channels-protocol\/v1/u);
  assert.doesNotMatch(source, /@happier-dev\/protocol(?:\/|['"])/u);
  assert.doesNotMatch(source, /@happier-dev\/channels-protocol\/(?:src|dist)(?:\/|['"])/u);
  assert.doesNotMatch(source, /(?:apps\/(?:cli|server|ui)|packages\/(?:protocol|plugins\/channels)|channels-core)/u);
  assert.doesNotMatch(source, /from ['"]node:/u);
  assert.doesNotMatch(
    source,
    /registerProviderRuntime|registerDurableSource|conversationChannels(?:\.|\b)|extensionRegistry|channelBridges/u,
  );
  assert.doesNotMatch(source, /pairingCodes|credentialStore|localCredential/u);
  assert.doesNotMatch(source, /Telegram|telegram/u);
});

test('fixture Action contract helper derives every protocol-owned field from an operation declaration', async () => {
  const source = await readFile(join(fixtureRoot, 'src', 'index.mjs'), 'utf8');
  const helperStart = source.indexOf('function actionContract(operation)');
  const helperEnd = source.indexOf('\nconst setupInputSchema', helperStart);

  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /const declaration = operation\.declaration;/u);
  assert.match(helper, /declaration\.input\.kind === 'protocolDefined'/u);
  assert.match(helper, /inputSchema: declaration\.input\.schema\.jsonSchema/u);
  assert.match(helper, /resultSchema: declaration\.resultSchema\.jsonSchema/u);
  assert.match(helper, /surfaces: declaration\.surfaces/u);
  assert.match(helper, /dangerLevel: declaration\.dangerLevel/u);
  assert.doesNotMatch(helper, /\boperation\.(?:input|resultSchema)\b/u);

  const actionsStart = source.indexOf('const actions = {');
  const actionsEnd = source.indexOf('\nconst plugin = definePlugin', actionsStart);
  assert.notEqual(actionsStart, -1);
  assert.notEqual(actionsEnd, -1);
  const actions = source.slice(actionsStart, actionsEnd);
  assert.doesNotMatch(actions, /\n\s+surfaces: \['plugin'\],/u);
  assert.doesNotMatch(actions, /\n\s+dangerLevel: '(?:safe|writesRemote)',/u);
});

test('fixture source binds one Channels provider through arbitrary local Action ids', async () => {
  const source = await readFile(join(fixtureRoot, 'src', 'index.mjs'), 'utf8');
  const contributionStart = source.indexOf('contributesTo: {');
  const resourcesStart = source.indexOf('\n  resources:', contributionStart);
  const setupActionStart = source.indexOf('[PROVIDER_ACTION_IDS.setup]: {');
  const setupActionEnd = source.indexOf('\n  [PROVIDER_ACTION_IDS.connectionTest]: {', setupActionStart);

  assert.notEqual(contributionStart, -1);
  assert.notEqual(resourcesStart, -1);
  assert.notEqual(setupActionStart, -1);
  assert.notEqual(setupActionEnd, -1);

  const contribution = source.slice(contributionStart, resourcesStart);
  const setupAction = source.slice(setupActionStart, setupActionEnd);

  assert.match(source, /setup: 'fixture\/setup'/u);
  assert.match(source, /connectionTest: 'fixture\/test'/u);
  assert.match(source, /messageDeliver: 'fixture\/deliver'/u);
  assert.doesNotMatch(source, /channels\/(?:setup|connection-test|message-deliver)-v1/u);
  assert.match(contribution, /\[CHANNELS_CORE_PLUGIN_ID\]: \{\s+providers: \{\s+'fixture-socket': channelsProvidersV1\.contribute\(/u);
  assert.equal((contribution.match(/channelsProvidersV1\.contribute\(/gu) ?? []).length, 1);
  assert.match(contribution, /setup: channelsProvidersV1\.operations\.setup\.bind\(PROVIDER_ACTION_IDS\.setup\)/u);
  assert.match(contribution, /connectionTest: channelsProvidersV1\.operations\.connectionTest\.bind\(PROVIDER_ACTION_IDS\.connectionTest\)/u);
  assert.match(contribution, /messageDeliver: channelsProvidersV1\.operations\.messageDeliver\.bind\(PROVIDER_ACTION_IDS\.messageDeliver\)/u);
  assert.doesNotMatch(contribution, /observationsPoll:/u);
  assert.match(setupAction, /inputSchema: setupInputSchema,/u);
  assert.match(setupAction, /\.\.\.actionContract\(channelsProvidersV1\.operations\.setup\),/u);
});

test('out-of-tree provider derives its bound Action declaration from the Channels operation role', async () => {
  const source = await readFile(join(fixtureRoot, 'test', 'public-authoring.ts'), 'utf8');
  const contributorStart = source.indexOf('const publicTargetedContributionContributor');
  const invocationStart = source.indexOf('/**\n * Compile-only target-side proof');

  assert.notEqual(contributorStart, -1);
  assert.notEqual(invocationStart, -1);
  const contributor = source.slice(contributorStart, invocationStart);

  assert.match(source, /const connectionTestDeclaration = connectionTestOperation\.declaration;/u);
  assert.match(source, /if \(connectionTestDeclaration\.input\.kind !== 'protocolDefined'\)/u);
  assert.match(contributor, /surfaces: connectionTestDeclaration\.surfaces,/u);
  assert.match(contributor, /dangerLevel: connectionTestDeclaration\.dangerLevel,/u);
  assert.match(contributor, /inputSchema: connectionTestDeclaration\.input\.schema\.jsonSchema,/u);
  assert.match(contributor, /resultSchema: connectionTestDeclaration\.resultSchema\.jsonSchema,/u);
  assert.match(
    contributor,
    /connectionTest: publicTargetedProtocol\.operations\.connectionTest\.bind\(\s*'fixture\/test',?\s*\)/u,
  );
  assert.doesNotMatch(contributor, /surfaces: \['plugin'\],/u);
  assert.doesNotMatch(contributor, /dangerLevel: 'safe',/u);
  assert.doesNotMatch(contributor, /connectionTestOperation\.(?:input|resultSchema)/u);
});

test('out-of-tree target executes a bound role only through the admitted-operation executor', async () => {
  const source = await readFile(join(fixtureRoot, 'test', 'public-authoring.ts'), 'utf8');
  const invocationStart = source.indexOf('/**\n * Compile-only target-side proof');
  const invocationEnd = source.indexOf('\nconst coreObservationIngest', invocationStart);

  assert.notEqual(invocationStart, -1);
  assert.notEqual(invocationEnd, -1);
  const invocation = source.slice(invocationStart, invocationEnd);

  assert.match(
    invocation,
    /context\.services\.actions\.executeAdmittedTargetedOperation\(\s*contributor\.operations\.connectionTest,\s*publicConnectionTestInput,\s*\{ signal: context\.signal \},?\s*\)/u,
  );
  assert.doesNotMatch(invocation, /context\.services\.actions\.execute\(/u);
  assert.doesNotMatch(invocation, /executeAdmittedTargetedOperationWithExecutionOrigin/u);
});

test('public authoring keeps setup input local and every required Channels role declaration-owned', async () => {
  const source = await readFile(join(fixtureRoot, 'test', 'public-authoring.ts'), 'utf8');
  const contributorStart = source.indexOf('const publicTargetedContributionContributor');
  const invocationStart = source.indexOf('/**\n * Compile-only target-side proof');

  assert.notEqual(contributorStart, -1);
  assert.notEqual(invocationStart, -1);
  const contributor = source.slice(contributorStart, invocationStart);

  assert.match(source, /from '@happier-dev\/channels-protocol';/u);
  assert.match(source, /from '@happier-dev\/channels-protocol\/v1';/u);
  assert.match(source, /from '@happier-dev\/channels-protocol\/testing\/v1';/u);
  assert.doesNotMatch(source, /@happier-dev\/protocol(?:\/|['"])/u);
  assert.doesNotMatch(source, /@happier-dev\/channels-protocol\/(?:src|dist)(?:\/|['"])/u);
  assert.doesNotMatch(source, /channels\/(?:setup|connection-test|message-deliver)-v1/u);

  assert.match(source, /const setupDeclaration = setupOperation\.declaration;/u);
  assert.match(source, /const messageDeliverDeclaration = messageDeliverOperation\.declaration;/u);
  assert.match(source, /if \(messageDeliverDeclaration\.input\.kind !== 'protocolDefined'\)/u);
  assert.match(contributor, /'fixture\/setup': \{[\s\S]*?surfaces: setupDeclaration\.surfaces,[\s\S]*?dangerLevel: setupDeclaration\.dangerLevel,[\s\S]*?inputSchema: emptyObjectSchema,[\s\S]*?resultSchema: setupDeclaration\.resultSchema\.jsonSchema,/u);
  assert.match(contributor, /'fixture\/deliver': \{[\s\S]*?surfaces: messageDeliverDeclaration\.surfaces,[\s\S]*?dangerLevel: messageDeliverDeclaration\.dangerLevel,[\s\S]*?inputSchema: messageDeliverDeclaration\.input\.schema\.jsonSchema,[\s\S]*?resultSchema: messageDeliverDeclaration\.resultSchema\.jsonSchema,/u);
  assert.match(contributor, /setup: publicTargetedProtocol\.operations\.setup\.bind\('fixture\/setup'\)/u);
  assert.match(contributor, /messageDeliver: publicTargetedProtocol\.operations\.messageDeliver\.bind\([\s\S]*?'fixture\/deliver',?[\s\S]*?\)/u);
  assert.doesNotMatch(contributor, /surfaces: \['plugin'\],/u);
  assert.doesNotMatch(contributor, /dangerLevel: '(?:safe|writesRemote)',/u);
});

test('external authors serialize a target point and arbitrary same-plugin Action binding through definePlugin', async () => {
  const { definePlugin } = await import('@happier-dev/plugin-sdk');
  const {
    defineContributionPoint,
    defineContributionProtocol,
  } = await import('@happier-dev/plugin-sdk/contributions');
  assert.equal(typeof defineContributionPoint, 'function');
  assert.equal(typeof defineContributionProtocol, 'function');

  // An external author composes protocol schemas through the SDK's published
  // validator-neutral algebra. The manifest must then carry only their JSON
  // projection, never the executable schema object.
  const {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
  } = await import('@happier-dev/plugin-sdk/protocol');
  const connectionInputSchema = defineProtocolObject(
    { connectionId: defineProtocolString({ minLength: 1 }) },
    { policy: 'closed' },
  );
  const connectionResultSchema = defineProtocolObject(
    { kind: defineProtocolLiteral('ready') },
    { policy: 'closed' },
  );
  const inputSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { connectionId: { type: 'string', minLength: 1 } },
    required: ['connectionId'],
    additionalProperties: false,
  };
  const resultSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { kind: { const: 'ready' } },
    required: ['kind'],
    additionalProperties: false,
  };
  // The manifest is written to `.happier-plugin/plugin.json`, so every
  // assertion below reads the serialized projection rather than the in-memory
  // frozen null-prototype records the algebra returns.
  const serialized = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(serialized(connectionInputSchema.jsonSchema), inputSchema);
  assert.deepEqual(serialized(connectionResultSchema.jsonSchema), resultSchema);
  const protocol = defineContributionProtocol({
    id: 'public-socket-provider',
    version: 1,
    operations: {
      'connection-test': {
        required: true,
        input: { kind: 'protocolDefined', schema: connectionInputSchema },
        resultSchema: connectionResultSchema,
        action: { surface: 'plugin', dangerLevel: 'safe' },
      },
    },
  });
  const connectionTest = protocol.operations['connection-test'];
  if (connectionTest.declaration.input.kind !== 'protocolDefined') {
    throw new Error('test protocol input must be protocol-defined');
  }
  const target = definePlugin({
    id: 'acme.channels.public-target',
    version: '1.0.0',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    contributionPoints: {
      'socket-providers': defineContributionPoint([protocol]),
    },
  });
  const contributor = definePlugin({
    id: 'acme.channels.public-contributor',
    version: '1.0.0',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    actions: {
      'diagnose-remote-socket': {
        title: 'Diagnose remote socket',
        scopes: ['global'],
        surfaces: connectionTest.declaration.surfaces,
        dangerLevel: connectionTest.declaration.dangerLevel,
        inputSchema: connectionTest.declaration.input.schema.jsonSchema,
        resultSchema: connectionTest.declaration.resultSchema.jsonSchema,
        execution: { target: 'daemon' },
        run: async () => ({ kind: 'ready' }),
      },
    },
    contributesTo: {
      'acme.channels.public-target': {
        'socket-providers': {
          'external-socket': protocol.contribute({
            operations: {
              'connection-test': connectionTest.bind('diagnose-remote-socket'),
            },
          }),
        },
      },
    },
  });

  assert.deepEqual(serialized(target.manifest.contributes.pluginContributionPoints), [{
    id: 'socket-providers',
    protocols: [{
      id: 'public-socket-provider',
      version: 1,
      operations: {
        'connection-test': {
          required: true,
          input: { kind: 'protocolDefined', schema: inputSchema },
          resultSchema,
          action: { surface: 'plugin', dangerLevel: 'safe' },
        },
      },
    }],
  }]);
  assert.deepEqual(serialized(contributor.manifest.contributes.targetedPluginContributions), [{
    id: 'external-socket',
    target: { pluginId: 'acme.channels.public-target', pointId: 'socket-providers' },
    protocol: { id: 'public-socket-provider', version: 1 },
    operations: { 'connection-test': 'diagnose-remote-socket' },
  }]);
});
