import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IrohTestController } from '../testkit/irohTestController';

/** Source-level I6 deployment assertion; network forcing stays test-only. */
export function assertIrohRelayPolicyFixture(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../deploy/iroh-relay');
  const config = readFileSync(resolve(root, 'relay.toml'), 'utf8');
  if (!/^enable_relay\s*=\s*false\b/m.test(config) || !/^enable_quic_addr_discovery\s*=\s*true\b/m.test(config)) {
    throw new Error('Iroh relay fixture must be holepunch-only by default');
  }
  const controller = new IrohTestController();
  controller.forceRelayOnly();
  controller.assertForcedPath('relay');
}
