#!/usr/bin/env bun

import { resolve } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { readBundledAgentNativeHomeEnvironmentKeys } from './utils/env/scrub_env.mjs';

const { kv } = parseArgs(process.argv.slice(2));
const entrypoint = kv.get('--entrypoint');
const outfile = kv.get('--outfile');
const target = kv.get('--target');
if (!entrypoint || !outfile || !target) {
  throw new Error('Expected --entrypoint, --outfile, and --target');
}
const external = process.argv.slice(2)
  .filter((value) => value.startsWith('--external='))
  .map((value) => value.slice('--external='.length))
  .filter(Boolean);

// Read the canonical generated Agent facts while the build has a checkout.
// Missing or malformed publication fails here rather than dropping scrub keys.
const nativeHomeEnvironmentKeys = readBundledAgentNativeHomeEnvironmentKeys();
const result = await Bun.build({
  entrypoints: [resolve(entrypoint)],
  external,
  compile: { target, outfile: resolve(outfile) },
  define: {
    HAPPIER_STACK_BUNDLED_AGENT_NATIVE_HOME_ENVIRONMENT_KEYS: JSON.stringify(nativeHomeEnvironmentKeys),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
