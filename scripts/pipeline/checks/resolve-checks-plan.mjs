// @ts-check

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { resolveChecksProfilePlan } from './lib/checks-profile.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      'custom-checks': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const profile = String(values.profile ?? '').trim();
  if (!profile) fail('--profile is required (full|fast|none|custom)');

  const customChecks = String(values['custom-checks'] ?? '').trim();

  const plan = resolveChecksProfilePlan({
    // @ts-expect-error runtime validation happens in resolveChecksProfilePlan
    profile,
    customChecks,
  });

  writeGithubOutput(String(values['github-output'] ?? '').trim(), {
    run_ci: plan.runCi ? 'true' : 'false',
    run_ui_e2e: plan.runUiE2e ? 'true' : 'false',
    run_e2e_core: plan.runE2eCore ? 'true' : 'false',
    run_e2e_core_slow: plan.runE2eCoreSlow ? 'true' : 'false',
    run_server_db_contract: plan.runServerDbContract ? 'true' : 'false',
    run_stress: plan.runStress ? 'true' : 'false',
    run_build_website: plan.runBuildWebsite ? 'true' : 'false',
    run_build_docs: plan.runBuildDocs ? 'true' : 'false',
    run_cli_smoke_linux: plan.runCliSmokeLinux ? 'true' : 'false',
  });

  process.stdout.write(`${JSON.stringify({ profile, custom_checks: customChecks, ...plan })}\n`);
}

main();
