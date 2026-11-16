// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { digestBuildInputRecordManifest } from '../../../packages/cli-common/packageBuildOutputTargets.mjs';
import { attestBuildInputRecordManifest } from './prepareSourcePluginUiArtifacts.mjs';

const manifest = { schemaVersion: 2, id: 'acme.account-relay', version: '1.0.0', displayName: 'Relay', runtime: { apiVersion: 1 },
  contributes: { resources: [{ id: 'target-options', source: 'dynamic', kind: 'config', scope: 'global',
    execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
    contentType: 'application/json' }] } };

test('a build record manifest gets its runtime digest only after canonical validation passes', async () => {
  assert.equal(await attestBuildInputRecordManifest(manifest), digestBuildInputRecordManifest(manifest));
  // The runtime compares the digest of the JSON it reads back, so the written text must round-trip to it.
  assert.equal(digestBuildInputRecordManifest(JSON.parse(JSON.stringify(manifest))), digestBuildInputRecordManifest(manifest));
  const invalid = { ...manifest, contributes: { resources: [{ ...manifest.contributes.resources[0], kind: 'not-a-kind' }] } };
  assert.equal(await attestBuildInputRecordManifest(invalid), undefined);
});
