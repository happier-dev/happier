// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { classifyChangedPaths, deriveVersionedComponentChanges } from './component-registry.mjs';
import { classifyReleaseValidationRisks } from '../release-validation/release-risk.mjs';

function fail(msg) {
  process.stderr.write(`[compute-changed-components] ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) {
      out.set(a, v);
      i++;
    } else {
      out.set(a, 'true');
    }
  }
  return out;
}

function runGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${err}`);
  }
  return String(r.stdout ?? '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = String(args.get('--base') ?? '').trim();
  const head = String(args.get('--head') ?? '').trim();
  const outPath = String(args.get('--out') ?? '').trim();

  if (!base) fail('--base is required');
  if (!head) fail('--head is required');

  const commitCountRaw = runGit(['rev-list', '--count', `${base}..${head}`]).trim();
  const commitCount = Number(commitCountRaw);
  if (!Number.isFinite(commitCount) || commitCount < 0) fail(`Invalid commit count: ${commitCountRaw}`);

  const diffRaw = runGit(['diff', '--name-only', `${base}..${head}`]);
  const paths = diffRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const classified = classifyChangedPaths(paths);
  const versioned = deriveVersionedComponentChanges(classified);
  const risks = classifyReleaseValidationRisks(paths);

  // Preserve the workflow's existing outputs naming.
  const outputs = {
    changed_ui: String(Boolean(versioned.app)),
    changed_cli: String(Boolean(classified.cli)),
    changed_server: String(Boolean(classified.server)),
    changed_website: String(Boolean(classified.website)),
    changed_docs: String(Boolean(classified.docs)),
    changed_cli_stack_shared: String(Boolean(classified.cli_stack_shared)),
    changed_shared: String(Boolean(classified.shared)),
    changed_stack: String(Boolean(classified.stack)),
    compatibility_analysis_required: String(risks.compatibilityAnalysisRequired),
    risk_cli_upgrade: String(risks.cliUpgrade),
    risk_session_continuity: String(risks.sessionContinuity),
    risk_relay_upgrade: String(risks.relayUpgrade),
    risk_mysql_contract: String(risks.mysqlContract),
    risk_platform_services: String(risks.platformServices),
    risk_trust_roots: String(risks.trustRoots),
    commit_count: String(commitCount),
  };

  if (outPath) {
    // GitHub Actions: append KEY=VALUE lines.
    const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
    fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(outputs)}\n`);
  }
}

// Support both sync and async main() implementations.
Promise.resolve()
  .then(() => main())
  .catch((err) => fail(err?.stack || String(err)));
