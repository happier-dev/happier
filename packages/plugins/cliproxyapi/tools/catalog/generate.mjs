import { readFileSync } from 'node:fs';
import { resolveMuseModelCapabilities, resolveMuseModelUpstreamRef } from '../../../muse/src/modelFacts.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES } from '../../src/provider/managedContract.ts';

if (process.argv.includes('--project-model-facts')) {
  const rows = JSON.parse(readFileSync(0, 'utf8'));
  if (rows.meta) rows.meta = rows.meta.map(model => ({
    ...model,
    capabilities: resolveMuseModelCapabilities(model.id, model.modelOptions),
    upstreamRef: resolveMuseModelUpstreamRef(model.id),
  }));
  process.stdout.write(JSON.stringify(rows));
} else {

const input = JSON.stringify(CLIPROXYAPI_MANAGED_PURPOSE_FAMILIES);
if (process.argv.includes('--print-families')) {
  process.stdout.write(input);
} else {
  const result = spawnSync('go', ['-C', './managed-runtime', 'run', './tools/catalog'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    input,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

}
