import { pathToFileURL } from 'node:url';

import { PROTOCOL_WIRE_COMPATIBILITY_INVENTORY, validateProtocolWireCompatibilityInventory } from './lib/protocolWireCompatibilityInventory.ts';

export async function main(): Promise<void> {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: process.cwd(),
  });

  console.log(`Protocol wire inventory entries: ${PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.length}`);
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  for (const entry of PROTOCOL_WIRE_COMPATIBILITY_INVENTORY) {
    console.log(`- ${entry.id}: ${entry.proofTests.length} proof test(s)`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
