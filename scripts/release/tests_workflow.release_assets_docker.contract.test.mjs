import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tests workflow exposes a thin docker release-assets job through release-validate', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const job = workflow.jobs['release-assets-docker'];
  assert.deepEqual(job.permissions ?? workflow.permissions, { contents: 'read' });
  const validation = job.steps.find((step) => step.name === 'Run unified Docker release-assets validation');
  assert.equal(validation.env.GITHUB_TOKEN, '${{ github.token }}');

  assert.match(
    raw,
    /run_release_assets_docker:\n\s+required: false\n\s+default: false\n\s+type: boolean/,
    'tests workflow should expose a dedicated workflow_call input for the Docker release-assets lane',
  );

  const checkout = job.steps.find((step) => step.name === 'Checkout');
  const verification = job.steps.find((step) => step.name === 'Verify exact requested checkout');
  assert.equal(checkout.with.ref, '${{ job.workflow_sha }}', 'release-assets-docker must execute current validation control');
  assert.equal(verification.env.WORKFLOW_SHA, '${{ job.workflow_sha }}');
  assert.match(verification.run, /test "\$\(git rev-parse HEAD\)" = "\$WORKFLOW_SHA"/);
  assert.match(
    raw,
    /release-assets-docker:[\s\S]*?RELAY_UPGRADE_TO_SOURCE:[\s\S]*?inputs\.relay_upgrade_to_source[\s\S]*?RELAY_UPGRADE_TO_REF:[\s\S]*?inputs\.relay_upgrade_to_ref[\s\S]*?--to-source "\$\{RELAY_UPGRADE_TO_SOURCE\}" \\\n[\s\S]*?--to-ref "\$\{RELAY_UPGRADE_TO_REF\}"/,
    'release-assets-docker should upgrade the selected published predecessor to the exact requested candidate artifact',
  );
});
