import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { CAPABILITY_MATRIX_DECLARATIONS_V1 } from './capabilityMatrixMetadata.mjs';

test('records only availability and exceptional lifecycle facts', () => {
  for (const rows of Object.values(CAPABILITY_MATRIX_DECLARATIONS_V1)) {
    for (const declaration of Object.values(rows)) {
      assert.equal(
        Object.keys(declaration).every(key => [
          'availabilityDisposition', 'unblockCondition', 'lifecycle',
        ].includes(key)),
        true,
      );
    }
  }
  assert.deepEqual(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess.terminal, {
    availabilityDisposition: 'available',
    lifecycle: 'session-runtime',
  });
});

test('the invocation-service host binds every published service id', async () => {
  // Service rows cite one host binder for all of `PluginServices`. That claim
  // is only true while the host descriptor map covers exactly the published
  // ids; a published id with no host descriptor has no binder and must be
  // deferred instead.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const [publicServices, hostServices] = await Promise.all([
    readFile(resolve(repoRoot, 'packages/plugin-sdk/src/services/index.ts'), 'utf8'),
    readFile(
      resolve(repoRoot, 'apps/cli/src/plugins/runtime/invocation/services/unavailable.ts'),
      'utf8',
    ),
  ]);
  const publishedIds = [...publicServices
    .slice(publicServices.indexOf('export type PluginServiceId'))
    .split(';')[0]
    .matchAll(/'([a-zA-Z]+)'/gu)]
    .map(([, id]) => id)
    .sort();
  const descriptors = hostServices.slice(hostServices.indexOf('export const PLUGIN_SERVICE_DESCRIPTORS'));
  const boundIds = [...descriptors.matchAll(/^ {4}([a-zA-Z]+): \{$/gmu)]
    .map(([, id]) => id)
    .sort();

  assert.equal(publishedIds.length > 0, true);
  assert.deepEqual(boundIds, publishedIds);
  for (const id of publishedIds) {
    assert.equal(
      CAPABILITY_MATRIX_DECLARATIONS_V1.services[id].availabilityDisposition,
      'available',
      id,
    );
  }
  assert.equal(descriptors.includes('createAvailable('), true);
});

test('defers exactly the HostAccess capabilities the host resolver refuses to serve', async () => {
  // The resolver is the cited HostAccess binder. Its own refusal arms are the
  // evidence for deferral, so a capability it starts serving cannot stay
  // deferred and one it stops serving cannot stay available.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const resolver = await readFile(
    resolve(repoRoot, 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts'),
    'utf8',
  );
  const refusalArm = resolver.match(
    /((?:\s*case '[a-zA-Z.]+':)+)\s*return 'unavailable';\s*\}\s*\}/u,
  );
  assert.notEqual(refusalArm, null);
  const refused = [...refusalArm[1].matchAll(/case '([a-zA-Z.]+)':/gu)].map(([, capability]) => capability).sort();

  assert.deepEqual(refused, ['browser', 'clipboard', 'externalLinks']);
  for (const [capability, declaration] of Object.entries(CAPABILITY_MATRIX_DECLARATIONS_V1.hostAccess)) {
    assert.equal(
      declaration.availabilityDisposition === 'deferred',
      refused.includes(capability),
      capability,
    );
  }
});
