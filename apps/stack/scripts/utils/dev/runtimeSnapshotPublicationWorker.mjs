import '../env/env.mjs';

import { publishRepositoryRuntimeSnapshot } from '../../build/build_stack_artifacts.mjs';
import { RUNTIME_PUBLICATION_RESULT_PREFIX } from './runtimeSnapshotPublisher.mjs';

const encodedRequest = String(process.argv[2] ?? '').trim();
if (!encodedRequest) throw new Error('runtime publisher worker requires an encoded request');

const request = JSON.parse(Buffer.from(encodedRequest, 'base64url').toString('utf8'));
const result = await publishRepositoryRuntimeSnapshot({
  rootDir: request.rootDir,
  authority: request.authority,
  requestedComponents: request.requestedComponents,
  env: process.env,
});

// The parent filters this machine result from the human-facing build log.
process.stdout.write(`${RUNTIME_PUBLICATION_RESULT_PREFIX}${JSON.stringify({
  snapshotId: result.snapshotId ?? null,
  changed: result.changed === true,
  reused: result.reused === true,
})}\n`);
