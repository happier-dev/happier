import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';

const EXTERNAL_AUTHOR_PROOF = 'packages/plugin-sdk/examples/action-contract-producer/src/index.ts';
const EXTERNAL_COMPOSER_AUTHOR_PROOF = 'packages/plugin-ui/fixtures/external-authoring/src/index.ts';
const TRIAGE_COMPOSER_PROOF = 'packages/plugins/triage/src/manifest.ts';
const CHANNELS_COMPOSER_PROOF = 'packages/plugins/channels/src/manifest.ts';

function assertDeferredExternalDevelopmentProof(declaration) {
  assert.equal(declaration.availabilityDisposition, 'deferred');
  assert.equal(declaration.provingConsumer, 'no current positive consumer');
  assert.match(declaration.unblockCondition, /maintained external development-source plugin/u);
  assert.match(declaration.unblockCondition, /current loaded development stack/u);
  assert.match(declaration.unblockCondition, /real invocation/u);
  assert.match(declaration.unblockCondition, /currentness/u);
}

test('keeps unsupported capability families deferred without treating the external author fixture as proof', () => {
  const declarations = [
    ...['notifications', 'notificationChannels']
      .map((family) => CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family]),
    CAPABILITY_MATRIX_DECLARATIONS_V1.services.secrets,
    CAPABILITY_MATRIX_DECLARATIONS_V1.services.notifications,
    CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./notifications'],
  ];

  for (const declaration of declarations) {
    assertDeferredExternalDevelopmentProof(declaration);
    assert.notEqual(declaration.provingConsumer, EXTERNAL_AUTHOR_PROOF);
  }
});

test('HostAccess declarations name the terminal session path and deferred declaration sources', () => {
  const terminal = CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal;
  assert.equal(
    terminal.producer,
    'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
  );
  assert.equal(terminal.lifecycle, 'session-runtime');
  assert.equal(terminal.specialistOwner, 'apps/cli/src/plugins/runtime/context/terminalHost.ts');
  assert.equal(terminal.availabilityDisposition, 'available');
  assert.equal(terminal.provingConsumer, 'packages/plugins/claude/src/manifest.ts');
  assert.notEqual(
    terminal.producer,
    terminal.provingConsumer,
  );
  assert.notEqual(
    terminal.specialistOwner,
    terminal.provingConsumer,
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

test('publishes r0.47 browser and request-policy authoring without promoting HostAccess browser', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const availableExternalAuthorProof = {
    availabilityDisposition: 'available',
    provingConsumer: EXTERNAL_AUTHOR_PROOF,
  };

  for (const family of ['browserTargets', 'browserActions', 'requestInterceptors']) {
    assert.deepEqual(
      CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family],
      availableExternalAuthorProof,
    );
  }
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./browser'], availableExternalAuthorProof);
  assert.equal(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./http'].availabilityDisposition, 'available');
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess, 'network.intercept'),
    false,
  );
  assert.equal(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.browser.availabilityDisposition, 'deferred');
  assert.equal(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.browser.provingConsumer, 'no current positive consumer');
  assert.equal(typeof CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.browser.unblockCondition, 'string');

  const [browserEntrypoint, consumer] = await Promise.all([
    readFile(resolve(repoRoot, 'packages/plugin-sdk/src/browser/index.ts'), 'utf8'),
    readFile(resolve(repoRoot, EXTERNAL_AUTHOR_PROOF), 'utf8'),
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
});

test('keeps external Commands and Tools deferred until loaded development-source proof', async () => {
  const consumerPath = EXTERNAL_AUTHOR_PROOF;
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.commands);
  assert.match(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.commands.unblockCondition, /canonical plugin command catalog/u);
  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.tools);
  assert.match(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.tools.unblockCondition, /real daemon MCP catalog/u);

  const consumer = await readFile(resolve(repoRoot, consumerPath), 'utf8');
  assert.match(consumer, /commands:\s*\{/u);
  assert.match(consumer, /tools:\s*\{/u);
});

test('keeps unproven invocation services deferred until loaded development-source proof', () => {
  for (const service of ['events', 'fs', 'providers', 'resources']) {
    assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.services[service]);
  }
});

test('retains notification source coverage without claiming external lifecycle proof', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  for (const family of ['notifications', 'notificationChannels']) {
    assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family]);
  }
  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.services.notifications);
  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./notifications']);

  const consumer = await readFile(resolve(repoRoot, EXTERNAL_AUTHOR_PROOF), 'utf8');
  assert.match(consumer, /from '@happier-dev\/plugin-sdk\/notifications'/u);
  assert.match(consumer, /notifications:\s*\{/u);
  assert.match(consumer, /notificationChannels:\s*\{/u);
  assert.match(consumer, /sender:\s*documentReviewNotificationSender,/u);
  assert.match(consumer, /context\.services\.notifications\.send\(/u);
});

test('retains SecretsService source coverage without claiming external lifecycle proof', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  assertDeferredExternalDevelopmentProof(CAPABILITY_MATRIX_DECLARATIONS_V1.services.secrets);

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

test('records current Composer and Session-header source consumers without promoting unrecorded loaded or release proof', async () => {
  const expectedConsumers = {
    composerReferences: EXTERNAL_COMPOSER_AUTHOR_PROOF,
    composerAttachments: TRIAGE_COMPOSER_PROOF,
    composerControls: TRIAGE_COMPOSER_PROOF,
    composerRegions: EXTERNAL_COMPOSER_AUTHOR_PROOF,
    sessionHeaderActions: CHANNELS_COMPOSER_PROOF,
  };

  for (const [family, sourceConsumer] of Object.entries(expectedConsumers)) {
    const declaration = CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family];
    assert.equal(declaration.availabilityDisposition, 'available');
    assert.equal(declaration.provingConsumer, sourceConsumer);
    assert.equal(Object.hasOwn(declaration, 'unblockCondition'), false);
  }

  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const [externalAuthor, triage, channels] = await Promise.all([
    readFile(resolve(repoRoot, EXTERNAL_COMPOSER_AUTHOR_PROOF), 'utf8'),
    readFile(resolve(repoRoot, TRIAGE_COMPOSER_PROOF), 'utf8'),
    readFile(resolve(repoRoot, CHANNELS_COMPOSER_PROOF), 'utf8'),
  ]);
  assert.match(externalAuthor, /composer:\s*\{/u);
  assert.match(externalAuthor, /references:\s*\{/u);
  assert.match(externalAuthor, /regions:\s*\{/u);
  assert.match(triage, /attachments:\s*\{/u);
  assert.match(triage, /controls:\s*\{/u);
  assert.match(channels, /sessionHeaderActions:\s*\{/u);
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies, 'composerReferenceProviders'),
    false,
  );
});
