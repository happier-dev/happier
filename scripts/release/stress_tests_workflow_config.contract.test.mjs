import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

test('stress tests workflow keeps scheduled config static so nightly runs create jobs', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'stress-tests.yml'), 'utf8');

  assert.match(raw, /\bstress-scheduled:\n[\s\S]*?if:\s*\$\{\{\s*github\.event_name\s*==\s*'schedule'\s*\}\}/);
  assert.match(raw, /\bstress-scheduled:[\s\S]*?stress_config:\s*'\{"repeat":"10","seed":""\}'/);
  assert.match(raw, /\bstress-dispatch:\n[\s\S]*?if:\s*\$\{\{\s*github\.event_name\s*==\s*'workflow_dispatch'\s*\}\}/);
  assert.doesNotMatch(
    raw,
    /stress_config:\s*\$\{\{\s*\(github\.event_name\s*==\s*'workflow_dispatch'[\s\S]*?\|\|[\s\S]*?\}\}/,
    'scheduled stress runs should not depend on a dispatch-input fallback expression in reusable workflow inputs',
  );

  const workflow = YAML.parse(raw, { prettyErrors: true });
  for (const jobName of ['stress-scheduled', 'stress-dispatch']) {
    const inputs = workflow.jobs[jobName].with;
    assert.equal(inputs.select_jobs_explicitly, true);
    assert.equal(inputs.run_stress, true);
    for (const inputName of ['run_server_db_contract', 'run_installers_smoke', 'run_binary_smoke']) {
      assert.equal(inputs[inputName], false, `${jobName} must disable the unrelated true-default ${inputName} lane`);
    }
  }
});
