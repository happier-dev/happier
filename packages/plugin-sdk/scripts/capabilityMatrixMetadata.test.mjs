import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';

const EXTERNAL_AUTHOR_PROOF = 'packages/plugin-sdk/examples/action-contract-producer/src/index.ts';

function availableProvingConsumerPaths() {
  return Object.freeze([
    ...new Set(
      Object.values(CAPABILITY_MATRIX_DECLARATIONS_V1)
        .flatMap((declarations) => Object.values(declarations))
        .filter((declaration) => declaration.availabilityDisposition === 'available')
        .map((declaration) => declaration.provingConsumer),
    ),
  ].sort());
}

test('available capability declarations name maintained regular proving-consumer leaves', async () => {
  const sourcePaths = availableProvingConsumerPaths();
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

  assert.equal(
    sourcePaths.includes('packages/plugins/gemini/src/connectedAccounts/runtime.ts'),
    true,
  );
  assert.equal(
    CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess['network.client'].provingConsumer,
    'packages/plugins/channel-discord/src/discordGatewayWorker.ts',
  );
  assert.equal(
    CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.transcriptActivities.provingConsumer,
    'packages/plugins/channels/src/manifest.ts',
  );
  assert.equal(
    CAPABILITY_MATRIX_DECLARATIONS_V1.services.targetedContributions.provingConsumer,
    'packages/plugins/channels/src/ingress.ts',
  );
  for (const sourcePath of sourcePaths) {
    assert.equal(
      (await lstat(resolve(repoRoot, sourcePath))).isFile(),
      true,
      `available capability proving consumer must be a regular file: ${sourcePath}`,
    );
  }
});

test('declares operation-only targeted contributions with the maintained Discord provider contributor', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies.targetedPluginContributions, {
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/channel-discord/src/manifest.ts',
  });
});

test('HostAccess declarations name the terminal session path and deferred declaration sources', () => {
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal, {
    producer: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
    lifecycle: 'session-runtime',
    specialistOwner: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
    availabilityDisposition: 'available',
    provingConsumer: 'packages/plugins/claude/src/agent/runtime/terminal/unified/nativeSession.ts',
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
    assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family], {
      availabilityDisposition: 'available',
      provingConsumer: EXTERNAL_AUTHOR_PROOF,
    });
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

test('proves public browser descriptors and request policy through the external author example', async () => {
  const consumerPath = EXTERNAL_AUTHOR_PROOF;
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.subpaths['./browser'], {
    availabilityDisposition: 'available',
    provingConsumer: consumerPath,
  });
  assert.equal(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.browser.availabilityDisposition, 'deferred');
  assert.equal(
    Object.hasOwn(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess, 'network.intercept'),
    false,
  );
  for (const family of ['browserTargets', 'browserActions', 'requestInterceptors']) {
    assert.equal(CAPABILITY_MATRIX_DECLARATIONS_V1.manifestFamilies[family].provingConsumer, consumerPath);
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
