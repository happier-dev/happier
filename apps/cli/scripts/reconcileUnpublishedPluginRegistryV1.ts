import { randomUUID } from 'node:crypto';

import { reconcileUnpublishedPluginRegistryV1 } from '../src/plugins/store/registry/unpublishedV1Reconciliation';

function parseArguments(argv: readonly string[]): Readonly<{
  happyHomeDir: string;
  expectedProducerCommit: string;
  ownerStopped: true;
}> {
  let happyHomeDir: string | undefined;
  let expectedProducerCommit: string | undefined;
  let ownerStopped = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--happy-home') happyHomeDir = argv[++index];
    else if (argument === '--expected-producer-commit') {
      expectedProducerCommit = argv[++index];
    } else if (argument === '--owner-stopped') {
      ownerStopped = true;
    } else {
      throw new Error(`Unknown unpublished registry reconciliation argument '${argument}'`);
    }
  }
  if (!happyHomeDir || !expectedProducerCommit || !ownerStopped) {
    throw new Error(
      'Usage: --happy-home <absolute .happier/stacks/<stack>/cli path> '
      + '--expected-producer-commit <40-character commit> --owner-stopped',
    );
  }
  return { happyHomeDir, expectedProducerCommit, ownerStopped: true };
}

try {
  const arguments_ = parseArguments(process.argv.slice(2));
  const result = await reconcileUnpublishedPluginRegistryV1({
    ...arguments_,
    owner: { pid: process.pid, instanceId: `operator-reconcile-${randomUUID()}` },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
