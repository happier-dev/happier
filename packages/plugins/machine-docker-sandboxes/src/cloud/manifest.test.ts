import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { DOCKER_SANDBOXES_PLUGIN } from '../manifest.js';

it('offers Docker cloud with remote billing and no local executable requirement', () => {
  expect(DOCKER_SANDBOXES_PLUGIN.manifest.contributes.machineProvisioners).toContainEqual(
    expect.objectContaining({ id: 'docker-cloud', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'unknown' },
      sessionPlacement: { kind: 'remote', supportsAgentNativeSandbox: false },
      bootstrapTransport: { kind: 'native', exec: 'cloud-exec', putFile: 'cloud-put-file' } }));
});

it('publishes the portable Docker account artifact required by its authentication descriptor', async () => {
  const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const descriptor = DOCKER_SANDBOXES_PLUGIN.manifest.contributes.connectedAccountDescriptors
    ?.find(account => account.id === 'docker');
  const artifactId = descriptor?.authentication?.account?.artifactId;
  expect(artifactId).toBeTruthy();
  expect(metadata.exports['./happier-plugin-ui/' + artifactId]).toEqual({
    'happier-source': './src/accountRuntime.ts', default: './dist/accountRuntime.js',
  });
});
