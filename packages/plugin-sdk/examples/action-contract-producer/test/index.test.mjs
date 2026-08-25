import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

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
            generation: 'target-generation-1',
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
    contributors: result.contributors.map((contributor) => ({ ...contributor })),
  }, {
    generation: 'target-generation-1',
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
    module.manifest.contributes.commands
      .filter((command) => command.action === 'inspect-document-review-services'
        || command.action === 'rotate-document-review-webhook-token')
      .map((command) => ({ id: command.id, action: command.action })),
    [
      { id: 'inspect-document-review-services-command', action: 'inspect-document-review-services' },
      { id: 'rotate-document-review-webhook-token-command', action: 'rotate-document-review-webhook-token' },
    ],
  );
  assert.deepEqual(
    module.manifest.contributes.tools
      .filter((tool) => tool.action === 'inspect-document-review-services'
        || tool.action === 'rotate-document-review-webhook-token')
      .map((tool) => ({ id: tool.id, action: tool.action })),
    [
      { id: 'inspect-document-review-services-tool', action: 'inspect-document-review-services' },
      { id: 'rotate-document-review-webhook-token-tool', action: 'rotate-document-review-webhook-token' },
    ],
  );
});
