import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';

import * as module from '../dist/index.js';

test('uses the canonical Triage protocol package for its target point', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(packageJson.dependencies['@happier-dev/triage-protocol'], '0.0.0');
  assert.equal(Object.hasOwn(packageJson.dependencies, '@happier-dev/triage-sources-protocol'), false);
  assert.match(source, /TriageSourcesContributionPointV1/u);
  assert.doesNotMatch(source, /triage-sources-protocol/u);
});

test('consumes the host-admitted target snapshot and disposes its observation', async (t) => {
  let disposed = false;
  const targetedContributions = {
    observeForSelf(point) {
      assert.equal(point.targetPluginId, 'examples.action-contract-producer');
      assert.equal(point.id, 'document-reviewers');
      return {
        async readCurrent() {
          return {
            occurrenceId: 'target-occurrence-1',
            sourceCustody: {
              kind: 'development',
              registeredRootId: 'target-root-1',
            },
            contributions: [{
              contributor: {
                pluginId: 'example.document-reviewer',
                contributionId: 'reviewer',
              },
              descriptor: { displayName: 'Example reviewer' },
            }],
          };
        },
        dispose() {
          disposed = true;
        },
      };
    },
  };
  const plugin = await createPluginTestkit({
    manifest: module.manifest,
    module,
    services: { targetedContributions },
  });
  t.after(async () => plugin.dispose());

  const result = await plugin.invokeAction('list-document-reviewers', {});
  assert.deepEqual({
    ...result,
    sourceCustody: { ...result.sourceCustody },
    contributors: result.contributors.map((contributor) => ({ ...contributor })),
  }, {
    occurrenceId: 'target-occurrence-1',
    sourceCustody: {
      kind: 'development',
      registeredRootId: 'target-root-1',
    },
    contributors: [{
      pluginId: 'example.document-reviewer',
      contributionId: 'reviewer',
      displayName: 'Example reviewer',
    }],
  });
  assert.equal(disposed, true);
});

test('invokes every retained service through declared Actions and keeps the visible journeys reversible', async (t) => {
  const serviceEvent = {
    pluginId: 'examples.action-contract-producer',
    localId: 'document-review-services-inspected',
  };
  const serviceFile = {
    root: 'pluginData',
    relativePath: 'service-check/document-review-services.txt',
  };
  const serviceDirectory = {
    root: 'pluginData',
    relativePath: 'service-check',
  };
  const serviceResource = 'document-review-service-guide';
  const serviceFileContents = 'Document review service inspection.';
  const resourceBytes = new TextEncoder().encode('Document review service guide.');
  const eventListeners = new Set();
  let eventSubscriptionDisposed = false;
  let fileContents = null;
  let resourceWatchDisposed = false;
  let notificationRequest = null;
  let secret = null;
  let secretRevision = 'revision-0';

  const plugin = await createPluginTestkit({
    manifest: module.manifest,
    module,
    services: {
      events: {
        plugin: {
          subscribe(ref, listener) {
            assert.deepEqual(ref, serviceEvent);
            eventListeners.add(listener);
            return {
              dispose() {
                eventSubscriptionDisposed = true;
                eventListeners.delete(listener);
              },
            };
          },
          async emit(localId, payload, options) {
            assert.equal(localId, serviceEvent.localId);
            assert.deepEqual(payload, { source: 'document-review-service-inspection' });
            assert.equal(options.signal instanceof AbortSignal, true);
            for (const listener of eventListeners) {
              await listener({ ref: serviceEvent, payload, sequence: 7 });
            }
            return { status: 'admitted', sequence: 7, subscriberCount: eventListeners.size };
          },
        },
      },
      fs: {
        async writeFile(path, bytes, options) {
          assert.deepEqual(path, serviceFile);
          assert.equal(options.signal instanceof AbortSignal, true);
          fileContents = new TextDecoder().decode(bytes);
        },
        async readFile(path, options) {
          assert.deepEqual(path, serviceFile);
          assert.equal(options.signal instanceof AbortSignal, true);
          assert.equal(fileContents, serviceFileContents);
          return new TextEncoder().encode(fileContents);
        },
        async stat(path, options) {
          assert.deepEqual(path, serviceFile);
          assert.equal(options.signal instanceof AbortSignal, true);
          return { kind: 'file', size: new TextEncoder().encode(fileContents).byteLength, modifiedAtMs: 1 };
        },
        async list(path, options) {
          assert.deepEqual(path, serviceDirectory);
          assert.equal(options.signal instanceof AbortSignal, true);
          return { items: [{ name: 'document-review-services.txt', kind: 'file' }] };
        },
        async remove(path, options) {
          assert.deepEqual(path, serviceFile);
          assert.equal(options.signal instanceof AbortSignal, true);
          fileContents = null;
        },
      },
      providers: {
        connections: {
          async describe(request, options) {
            assert.deepEqual(request, {});
            assert.equal(options.signal instanceof AbortSignal, true);
            return { status: 'success', connections: [], available: [], availableTruncated: false, discoveryCandidates: [], discoveryCandidatesTruncated: false, localInstallations: [], diagnostics: [], diagnosticsTruncated: false };
          },
        },
      },
      resources: {
        describe(id) {
          assert.equal(id, serviceResource);
          return {
            id,
            kind: 'template',
            contentType: 'text/plain',
            digest: 'service-resource-digest',
            size: resourceBytes.byteLength,
          };
        },
        async read(id, options) {
          assert.equal(id, serviceResource);
          assert.equal(options.signal instanceof AbortSignal, true);
          return {
            kind: 'template',
            contentType: 'text/plain',
            digest: 'service-resource-digest',
            bytes: resourceBytes.slice(),
          };
        },
        watch(id, listener) {
          assert.equal(id, serviceResource);
          assert.equal(typeof listener, 'function');
          return {
            dispose() {
              resourceWatchDisposed = true;
            },
          };
        },
      },
      secrets: {
        async saveShared() {
          throw new Error('plugin_secret_save_not_admitted');
        },
        async status(id) {
          assert.equal(id, 'document-review-webhook-token');
          return { state: secret === null ? 'missing' : 'configured', revision: secretRevision };
        },
        async set(id, value, options) {
          assert.equal(id, 'document-review-webhook-token');
          assert.equal(value, 'opaque-rotation-token');
          assert.equal(options.signal instanceof AbortSignal, true);
          secret = value;
          secretRevision = 'revision-1';
          return { revision: secretRevision };
        },
        async get(id, options) {
          assert.equal(id, 'document-review-webhook-token');
          assert.equal(options.reason, 'Confirm the rotated document review webhook credential');
          assert.equal(options.signal instanceof AbortSignal, true);
          return secret;
        },
        async delete(id, options) {
          assert.equal(id, 'document-review-webhook-token');
          assert.equal(options.expectedRevision, 'revision-1');
          assert.equal(options.signal instanceof AbortSignal, true);
          secret = null;
          secretRevision = 'revision-2';
          return { revision: secretRevision };
        },
      },
      notifications: {
        async send(request, options) {
          assert.equal(options.signal instanceof AbortSignal, true);
          notificationRequest = request;
          return {
            deliveries: [{
              deliveryId: 'delivery-1',
              channelId: 'webhook',
              status: 'accepted',
              evidence: 'provider',
            }],
            replayed: false,
          };
        },
      },
    },
  });
  t.after(async () => plugin.dispose());

  const serviceJourney = await plugin.invokeAction('inspect-document-review-services', null);
  assert.deepEqual({
    ...serviceJourney,
    event: { ...serviceJourney.event },
    filesystem: { ...serviceJourney.filesystem },
    providers: { ...serviceJourney.providers },
    resource: { ...serviceJourney.resource },
  }, {
    event: { sequence: 7, subscriberCount: 1 },
    filesystem: {
      kind: 'file',
      size: new TextEncoder().encode(serviceFileContents).byteLength,
      entries: ['document-review-services.txt'],
      removed: true,
    },
    providers: { status: 'success' },
    resource: {
      kind: 'template',
      contentType: 'text/plain',
      digest: 'service-resource-digest',
      size: resourceBytes.byteLength,
      bytes: resourceBytes.byteLength,
    },
  });
  assert.equal(fileContents, null);
  assert.equal(eventSubscriptionDisposed, true);
  assert.equal(resourceWatchDisposed, true);

  const configuredSecret = await plugin.invokeAction('rotate-document-review-webhook-token', {
    token: 'opaque-rotation-token',
  });
  assert.deepEqual({ ...configuredSecret }, { state: 'configured', revision: 'revision-1' });
  assert.equal(JSON.stringify(configuredSecret).includes('opaque-rotation-token'), false);

  const deletedSecret = await plugin.invokeAction('rotate-document-review-webhook-token', {});
  assert.deepEqual({ ...deletedSecret }, { state: 'missing', revision: 'revision-2' });

  await plugin.invokeAction('send-document-review-ready', null);
  assert.deepEqual(notificationRequest, {
    clientRequestId: 'document-review-ready',
    categoryId: 'document-review-ready',
    title: 'Document review ready',
  });

  assert.deepEqual(
    module.manifest.contributes.actions
      .filter((action) => action.id === 'inspect-document-review-services'
        || action.id === 'rotate-document-review-webhook-token')
      .map((action) => ({ id: action.id, path: action.cli.path })),
    [
      { id: 'inspect-document-review-services', path: ['document-review', 'inspect-services'] },
      { id: 'rotate-document-review-webhook-token', path: ['document-review', 'rotate-webhook-token'] },
    ],
  );
  assert.deepEqual(
    module.manifest.contributes.actions
      .filter((action) => action.id === 'inspect-document-review-services'
        || action.id === 'rotate-document-review-webhook-token'
        || action.id === 'forward-to-session-run')
      .map((action) => ({ id: action.id, name: action.tool.name })),
    [
      { id: 'inspect-document-review-services', name: 'document_review_inspect_services' },
      { id: 'rotate-document-review-webhook-token', name: 'document_review_rotate_webhook_token' },
      { id: 'forward-to-session-run', name: 'document_review_forward_to_run' },
    ],
  );
});

test('exercises Lane 10 parity through the same public Actions and contribution identities as built-ins', async (t) => {
  const teamId = 'team_parity_01';
  const credentialResources = [
    {
      id: 'res_connected_01',
      teamId,
      custodianAccountId: 'acc_owner_01',
      sourceOwnerDisplayName: 'Example owner',
      displayName: 'Example OAuth share',
      enabled: true,
      revision: 1,
      disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed',
      source: {
        v: 1,
        kind: 'connected_account',
        target: {
          kind: 'account',
          account: {
            service: { pluginId: 'happier.connected-accounts.example', localId: 'example-oauth' },
            accountId: 'acc_123',
          },
        },
        credentialIncarnation: 'incarnation-1',
      },
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'happier.connected-accounts.example', localId: 'example-oauth' },
      },
      requestPolicy: null,
      brokerPlacement: null,
      allMembersDeliveryMode: null,
      groupGrants: [],
      memberGrants: [],
      readiness: { kind: 'available' },
      recoveryAction: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'res_provider_01',
      teamId,
      custodianAccountId: 'acc_owner_01',
      sourceOwnerDisplayName: 'Example owner',
      displayName: 'Example provider share',
      enabled: true,
      revision: 1,
      disclosureCeiling: 'brokered_only',
      sessionUsePolicy: 'personal_allowed',
      source: {
        v: 1,
        kind: 'provider_connection',
        connectionId: 'conn_01',
        connectionSecurityFingerprint: 'connection-security:v1:test',
        credentialSlotId: 'api-key',
      },
      sourcePresentation: {
        kind: 'provider',
        provider: {
          identity: { pluginId: 'happier.provider.openai', localId: 'openai' },
          definitionRevision: 1,
        },
      },
      requestPolicy: null,
      brokerPlacement: null,
      allMembersDeliveryMode: null,
      groupGrants: [],
      memberGrants: [],
      readiness: { kind: 'available' },
      recoveryAction: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const sharedResources = [{
    ref: 'happier:shared-secret:v1:resource_01',
    source: 'shared_resource',
    relationship: 'recipient',
    name: 'Example API key',
    kind: 'apiKey',
    ownerAccountId: 'acc_owner_01',
    revision: 3,
    materialStatus: 'ready',
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
  }];
  const listedAccounts = [{
    account: {
      service: { pluginId: 'happier.connected-accounts.example', localId: 'example-oauth' },
      accountId: 'acc_123',
    },
    displayName: 'Example OAuth',
    state: 'connected',
    connectedAccountOrigins: [],
    connectedAccountBases: [],
  }];
  const seenActions = [];
  const sourceCandidates = {
    candidates: [{
      candidateId: 'candidate_provider_01',
      label: 'Example provider',
      memberCount: null,
      offeredByResourceId: null,
      source: credentialResources[1].source,
    }],
    supportedKinds: ['connected_account', 'connected_pool', 'provider_connection'],
  };
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  // Public-SDK parity: only documented entrypoints, never host internals or another plugin artifact.
  assert.match(source, /from '@happier-dev\/plugin-sdk\/providers'/u);
  assert.match(source, /from '@happier-dev\/plugin-sdk\/connected-accounts'/u);
  assert.match(source, /areProviderContributionKeysEqualV1/u);
  assert.match(source, /QualifiedConnectedAccountRefSchema/u);
  assert.doesNotMatch(source, /apps\/cli\/src\/plugins\/runtime/u);
  assert.doesNotMatch(source, /apps\/server\/sources\/app\/teams/u);
  assert.doesNotMatch(source, /packages\/protocol\/src\/teams/u);
  const plugin = await createPluginTestkit({
    manifest: module.manifest,
    module,
    services: {
      actions: {
        async execute(actionId, input, options) {
          assert.equal(options?.signal instanceof AbortSignal, true);
          seenActions.push(actionId);
          if (actionId === 'teams.credentials.list') {
            assert.deepEqual(input, { teamId });
            return { resources: credentialResources, viewer: { manageCredentials: false, offerOwnCredential: true } };
          }
          if (actionId === 'teams.credentials.sources.list') {
            assert.deepEqual(input, { teamId });
            return sourceCandidates;
          }
          if (actionId === 'teams.credentials.test') {
            assert.deepEqual(input, { teamId, resourceId: 'res_connected_01' });
            return { result: 'needs_attention', readiness: { kind: 'source_unavailable' }, recovery: 'Repair the source.' };
          }
          if (actionId === 'secrets.shared.list') {
            assert.deepEqual(input, {});
            return { resources: sharedResources };
          }
          throw new Error(`unexpected Lane 10 Action ${String(actionId)}`);
        },
      },
      providers: {
        connections: {
          async describe(request, options) {
            assert.deepEqual(request, {});
            assert.equal(options?.signal instanceof AbortSignal, true);
            return { status: 'success', connections: [], available: [], availableTruncated: false, discoveryCandidates: [], discoveryCandidatesTruncated: false, localInstallations: [], diagnostics: [], diagnosticsTruncated: false };
          },
        },
      },
      connectedAccounts: {
        async listAccounts(request, options) {
          assert.deepEqual(request, { purpose: 'document-review-api', limit: 50 });
          assert.equal(options?.signal instanceof AbortSignal, true);
          return { status: 'complete', accounts: listedAccounts };
        },
      },
    },
  });
  t.after(async () => plugin.dispose());
  const result = JSON.parse(JSON.stringify(
    await plugin.invokeAction('inspect-team-credential-parity', {
      teamId,
      resourceId: 'res_connected_01',
    }),
  ));
  // Same Lane 10 Action IDs as built-in Team Settings/pickers, in canonical order.
  assert.deepEqual(seenActions, [
    'teams.credentials.list',
    'teams.credentials.sources.list',
    'teams.credentials.test',
    'secrets.shared.list',
  ]);
  assert.equal(result.teamId, teamId);
  // Same Provider/Connected Account contribution identity vocabulary as built-ins.
  assert.deepEqual(result.credentialResources, [
    {
      id: 'res_connected_01',
      displayName: 'Example OAuth share',
      sourceKind: 'connected_account',
      serviceIdentity: { pluginId: 'happier.connected-accounts.example', localId: 'example-oauth' },
      providerIdentity: null,
      readinessKind: 'available',
    },
    {
      id: 'res_provider_01',
      displayName: 'Example provider share',
      sourceKind: 'provider_connection',
      serviceIdentity: null,
      providerIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
      readinessKind: 'available',
    },
  ]);
  // Shared list preserves materialStatus for the host-owned materializer; no bytes disclosed.
  // Raw shared materialization remains host-owned (SavedSecretMaterializerV1 plus scoped
  // plugin secret settings/raw credential materializer per Lane 10.08) with no public SDK
  // getter by design, so this is the closest approved public seam.
  assert.deepEqual(result.sharedSecrets, [{
    ref: 'happier:shared-secret:v1:resource_01',
    name: 'Example API key',
    materialStatus: 'ready',
    canUse: true,
  }]);
  assert.equal(result.providerStatus, 'success');
  assert.deepEqual(result.connectedAccounts, {
    status: 'complete',
    accounts: [{ displayName: 'Example OAuth', state: 'connected' }],
  });
  assert.equal(result.providerIdentityMatch, true);
  assert.deepEqual(result.sourceCatalog, {
    supportedKinds: ['connected_account', 'connected_pool', 'provider_connection'],
    candidates: [{ id: 'candidate_provider_01', label: 'Example provider', sourceKind: 'provider_connection' }],
  });
  assert.deepEqual(result.resourceTest, {
    result: 'needs_attention',
    readiness: { kind: 'source_unavailable' },
    recovery: 'Repair the source.',
  });
  const serialized = JSON.stringify(result);
  // Recipient-safe: no custodian, broker, audience, bearer, signed capability, or secret bytes.
  for (const forbidden of ['custodianAccountId', 'brokerMachineId', 'groupGrants', 'memberGrants', 'hostBearer', 'token', 'acc_123']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('preserves pending approval and typed failures for a public Saved Secret mutation', async (t) => {
  const request = {
    resourceId: 'resource_01',
    expectedRevision: 3,
    displayName: 'Rotated API key',
    kind: 'apiKey',
    value: 'replacement-secret-never-returned',
  };
  const cases = [
    { mode: 'result', expected: {
      kind: 'approval_request_created', artifactId: 'approval_lane10_01', actionId: 'secrets.shared.update',
    } },
    { mode: 'error', expected: {
      code: 'resource_changed', message: 'The Saved Secret changed before this update.', details: { expectedRevision: 3 },
    } },
  ];
  for (const { mode, expected } of cases) {
    let seenInput = null;
    const plugin = await createPluginTestkit({
      manifest: module.manifest,
      module,
      services: {
        actions: {
          async execute(actionId, input) {
            assert.equal(actionId, 'secrets.shared.update');
            seenInput = input;
            if (mode === 'error') throw new PluginError(expected);
            return expected;
          },
        },
      },
    });
    t.after(async () => plugin.dispose());

    const invocation = plugin.invokeAction('update-shared-secret', request);
    assert.deepEqual(seenInput, {
      resourceId: request.resourceId,
      expectedRevision: request.expectedRevision,
      displayName: request.displayName,
      kind: request.kind,
      storedContent: {
        t: 'plain',
        v: { v: 1, name: request.displayName, kind: request.kind, value: request.value },
      },
    });
    if (mode === 'error') {
      await assert.rejects(invocation, (error) => {
        assert.equal(error instanceof PluginError, true);
        assert.deepEqual({
          code: error.code,
          message: error.message,
          details: { ...error.details },
        }, expected);
        return true;
      });
    } else {
      const result = await invocation;
      assert.deepEqual({ ...result }, expected);
      assert.equal(JSON.stringify(result).includes(request.value), false);
    }
  }
});

test('forwards to a Session-owned run through the canonical Session handle with built-in parity', async (t) => {
  const sessionId = 'session_parity_01';
  const runId = 'run_parity_01';
  const text = 'Continue this run';
  const idempotencyKey = 'message-targeted-42';
  const attachmentEntryId = '42';
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  // Trusted external-plugin parity: public manifest/activate ABI only, same
  // recipient and attachment capabilities as built-ins, no privileged path.
  assert.match(source, /forward-to-session-run/u);
  assert.match(source, /context\.services\.sessions\.get/u);
  assert.match(source, /kind: 'execution_run'/u);
  assert.match(source, /attachmentLocalId: 'entry'/u);
  assert.doesNotMatch(source, /apps\/cli\/src\/plugins\/runtime/u);
  assert.doesNotMatch(source, /apps\/cli\/src\/session\/services\/sendSessionMessage/u);
  assert.doesNotMatch(source, /packages\/protocol\/src\/sessions\/pending/u);
  assert.doesNotMatch(source, /encrypt(?:ed|ion)?.*field|compatibility.*epoch|version.*probe/u);
  const sessionsAccess = module.manifest.hostAccess.required.find(
    (entry) => entry.capability === 'sessions',
  );
  assert.deepEqual(sessionsAccess, {
    id: 'document-review-session-send',
    capability: 'sessions',
    reason: 'Send trusted document-review messages to selected Sessions and their retained execution runs.',
    scope: { access: ['read', 'write'] },
  });
  const targetedAction = module.manifest.contributes.actions.find(
    (entry) => entry.id === 'forward-to-session-run',
  );
  assert.deepEqual(targetedAction.surfaces, ['cli', 'mcp', 'agent', 'plugin']);
  let seenSessionId = null;
  let seenRequest = null;
  const plugin = await createPluginTestkit({
    manifest: module.manifest,
    module,
    services: {
      sessions: {
        async get(requestedSessionId, options) {
          assert.equal(requestedSessionId, sessionId);
          assert.equal(options?.signal instanceof AbortSignal, true);
          seenSessionId = requestedSessionId;
          return {
            async send(request, sendOptions) {
              assert.equal(sendOptions?.signal instanceof AbortSignal, true);
              seenRequest = request;
              return { status: 'accepted', localId: 'plugin-input-v1:targeted' };
            },
          };
        },
      },
    },
  });
  t.after(async () => plugin.dispose());
  const result = await plugin.invokeAction('forward-to-session-run', {
    sessionId,
    runId,
    text,
    idempotencyKey,
    attachmentEntryId,
  });
  assert.equal(seenSessionId, sessionId);
  assert.deepEqual({ ...seenRequest, recipient: { ...seenRequest.recipient } }, {
    kind: 'userText',
    text,
    idempotencyKey,
    recipient: { kind: 'execution_run', runId },
    attachments: [{
      attachmentLocalId: 'entry',
      value: {
        key: 'github:pull:42',
        value: { sourceId: 'github', entryId: '42' },
        presentation: { label: 'PR #42' },
      },
    }],
  });
  // Observable result through existing host wiring: canonical admission result.
  assert.deepEqual({ ...result }, { status: 'accepted', localId: 'plugin-input-v1:targeted' });
  // One Action owns the public tool name and CLI path for the same handler.
  const action = module.manifest.contributes.actions.find((entry) => entry.id === 'forward-to-session-run');
  assert.deepEqual(
    { id: action.id, path: action.cli.path, name: action.tool.name, exposure: action.toolExposure },
    { id: 'forward-to-session-run', path: ['document-review', 'forward-to-run'], name: 'document_review_forward_to_run', exposure: { agent: 'direct', mcp: 'direct' } },
  );
});
