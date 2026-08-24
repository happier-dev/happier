import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';

const EXTERNAL_AUTHOR_PROOF = 'packages/plugin-sdk/examples/action-contract-producer/src/index.ts';

function assertDeferredExternalProof(declaration) {
  assert.equal(declaration.availabilityDisposition, 'deferred');
  assert.equal(declaration.provingConsumer, 'no current positive consumer');
  assert.match(declaration.unblockCondition, /maintained operation-only external plugin/u);
}

test('does not advertise the first-party Triage preview pair as external capability proof', () => {
  const declarations = [
    ...['browserTargets', 'browserActions', 'notifications', 'notificationChannels', 'requestInterceptors']
      .map((family) => CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family]),
    CAPABILITY_MATRIX_DECLARATIONS_V1.services.secrets,
    CAPABILITY_MATRIX_DECLARATIONS_V1.services.notifications,
    CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./browser'],
    CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./notifications'],
  ];

  for (const declaration of declarations) {
    assertDeferredExternalProof(declaration);
    assert.notEqual(declaration.provingConsumer, EXTERNAL_AUTHOR_PROOF);
  }
});

test('HostAccess declarations name the terminal session path and deferred declaration sources', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal, {
    producer: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
    lifecycle: 'session-runtime',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/claude/src/manifest.ts',
  });
  assert.notEqual(
    CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal.producer,
    CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal.provingConsumer,
  );
  assert.notEqual(
    CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal.specialistOwner,
    CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal.provingConsumer,
  );
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess, 'network.intercept'),
    false,
  );
  for (const capability of ['browser', 'clipboard', 'externalLinks']) {
    assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess[capability], {
      producer: 'packages/protocol/src/plugins/manifest/v2.ts',
      lifecycle: 'declaration-only',
      specialistOwner: 'apps/cli/src/plugins/runtime/lifecycle/activation/policy.ts',
      availabilityDisposition: 'deferred',
      provingConsumer: 'no current positive consumer',
      unblockCondition: CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess[capability].unblockCondition,
    });
  }
});

test('records the public request-interception pair without promoting unrelated HostAccess capabilities', () => {
  for (const family of ['browserTargets', 'browserActions', 'requestInterceptors']) {
    assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family]);
  }
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess, 'network.intercept'),
    false,
  );

  for (const capability of ['browser', 'clipboard', 'externalLinks']) {
    const declaration = CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess[capability];
    assert.equal(declaration.availabilityDisposition, 'deferred');
    assert.equal(declaration.provingConsumer, 'no current positive consumer');
    assert.equal(typeof declaration.unblockCondition, 'string');
    assert.notEqual(declaration.unblockCondition.length, 0);
  }
});

test('retains public browser descriptor source coverage without claiming external lifecycle proof', async () => {
  const consumerPath = EXTERNAL_AUTHOR_PROOF;
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

  assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./browser']);
  assert.equal(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.browser.availabilityDisposition, 'deferred');
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess, 'network.intercept'),
    false,
  );
  for (const family of ['browserTargets', 'browserActions', 'requestInterceptors']) {
    assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family]);
  }

  const [browserEntrypoint, consumer] = await Promise.all([
    readFile(resolve(repoRoot, 'packages/plugin-sdk/src/browser/index.ts'), 'utf8'),
    readFile(resolve(repoRoot, consumerPath), 'utf8'),
  ]);
  assert.match(browserEntrypoint, /export \{ PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 \} from '\.\.\/ui\/build\/publicToolchainCompatibility\.generated\.js';/u);
  assert.match(browserEntrypoint, /export \{ defineBrowserAction \} from '\.\/actions\.js';/u);
  assert.match(browserEntrypoint, /export \{ defineBrowserTarget \} from '\.\/targets\.js';/u);
  assert.match(consumer, /BrowserActionContributionInput/u);
  assert.match(consumer, /BrowserTargetContributionInput/u);
  assert.match(consumer, /PluginRequestInterceptor/u);
  assert.match(consumer, /browserTargets:\s*\{/u);
  assert.match(consumer, /browserActions:\s*\{/u);
  assert.match(consumer, /requestInterceptors:\s*\{/u);
  assert.doesNotMatch(consumer, /capability:\s*'network\.intercept'/u);
  assert.doesNotMatch(consumer, /hostAccess:\s*\{/u);
});

test('keeps external Commands and Tools deferred until packed lifecycle proof', async () => {
  const consumerPath = EXTERNAL_AUTHOR_PROOF;
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.commands, {
    availabilityDisposition: 'deferred',
    provingConsumer: 'no current positive consumer',
    unblockCondition: 'An exact packed external Command invokes its Action through the canonical plugin command catalog and proves replacement, disable, and uninstall currentness.',
  });
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.tools, {
    availabilityDisposition: 'deferred',
    provingConsumer: 'no current positive consumer',
    unblockCondition: 'An exact packed external Tool invokes its Action through the real daemon MCP catalog and proves replacement, disable, and uninstall currentness.',
  });

  const consumer = await readFile(resolve(repoRoot, consumerPath), 'utf8');
  assert.match(consumer, /commands:\s*\{/u);
  assert.match(consumer, /tools:\s*\{/u);
});

test('retains notification source coverage without claiming external lifecycle proof', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  for (const family of ['notifications', 'notificationChannels']) {
    assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family]);
  }
  assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.services.notifications);
  assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./notifications']);

  const consumer = await readFile(resolve(repoRoot, EXTERNAL_AUTHOR_PROOF), 'utf8');
  assert.match(consumer, /from '@happier-dev\/plugin-sdk\/notifications'/u);
  assert.match(consumer, /notifications:\s*\{/u);
  assert.match(consumer, /notificationChannels:\s*\{/u);
  assert.match(consumer, /sender:\s*documentReviewNotificationSender,/u);
  assert.match(consumer, /context\.services\.notifications\.send\(/u);
});

test('retains SecretsService source coverage without claiming external lifecycle proof', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  assertDeferredExternalProof(CAPABILITY_MATRIX_DECLARATIONS_V1.services.secrets);

  const consumer = await readFile(resolve(repoRoot, EXTERNAL_AUTHOR_PROOF), 'utf8');
  assert.match(consumer, /secrets:\s*\[\{\s*id:\s*DOCUMENT_REVIEW_WEBHOOK_TOKEN\s*\}\]/u);
  for (const operation of ['status', 'set', 'get', 'delete']) {
    assert.match(
      consumer,
      new RegExp(`secrets\\.${operation}\\(`, 'u'),
      `external author example must invoke SecretsService.${operation}`,
    );
  }
  assert.match(consumer, /expectedRevision:\s*current\.revision/u);
});

test('records the r1.0 Composer families as deferred until a maintained public plugin proves each live lifecycle', () => {
  for (const family of [
    'composerReferences',
    'composerAttachments',
    'composerControls',
    'composerRegions',
  ]) {
    const declaration = CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family];
    assert.deepEqual(declaration.availabilityDisposition, 'deferred');
    assert.equal(declaration.provingConsumer, 'no current positive consumer');
    assert.equal(typeof declaration.unblockCondition, 'string');
    assert.notEqual(declaration.unblockCondition.length, 0);
  }
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies, 'composerReferenceProviders'),
    false,
  );
});
