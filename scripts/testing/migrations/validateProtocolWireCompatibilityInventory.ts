import { pathToFileURL } from 'node:url';

import { PROTOCOL_WIRE_COMPATIBILITY_INVENTORY, validateProtocolWireCompatibilityInventory } from './lib/protocolWireCompatibilityInventory.ts';
import { validateRpcActionCoverage } from './lib/rpcActionCoverage.ts';

export async function main(): Promise<void> {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: process.cwd(),
  });

  console.log(`Protocol wire inventory entries: ${PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.length}`);
  const rpcActionCoverage = validateRpcActionCoverage();
  console.log(`RPC ActionSpec coverage advisory unclassified methods: ${rpcActionCoverage.unclassifiedRpcMethods.length}`);

  const errors = [
    ...result.errors,
    ...rpcActionCoverage.errors.map((error) => error.message),
  ];
  if (errors.length > 0) {
    for (const error of errors) {
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
