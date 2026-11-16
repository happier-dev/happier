import { expect, it } from 'vitest';
import { DOCKER_SANDBOXES_PLUGIN } from '../manifest.js';

it('offers Docker cloud with remote billing and no local executable requirement', () => {
  expect(DOCKER_SANDBOXES_PLUGIN.manifest.contributes.machineProvisioners).toContainEqual(
    expect.objectContaining({ id: 'docker-cloud', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'unknown' },
      sessionPlacement: { kind: 'remote', supportsAgentNativeSandbox: false },
      bootstrapTransport: { kind: 'native', exec: 'cloud-exec', putFile: 'cloud-put-file' } }));
});
