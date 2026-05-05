import { pathToFileURL } from 'node:url';

import { validateRpcActionCoverage } from './lib/rpcActionCoverage.ts';

export async function main(): Promise<void> {
  const result = validateRpcActionCoverage();

  console.log(`RPC ActionSpec coverage registered methods: ${result.registeredRpcMethods.length}`);
  console.log(`RPC ActionSpec coverage action-bound methods: ${result.actionBoundRpcMethods.length}`);
  console.log(`RPC ActionSpec coverage internal-only methods: ${result.internalOnlyRpcMethods.length}`);
  console.log(`RPC ActionSpec coverage advisory unclassified methods: ${result.unclassifiedRpcMethods.length}`);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`- ${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (process.env.HAPPIER_RPC_ACTION_COVERAGE_VERBOSE === '1') {
    for (const warning of result.warnings) {
      console.warn(`- advisory: ${warning.message}`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
