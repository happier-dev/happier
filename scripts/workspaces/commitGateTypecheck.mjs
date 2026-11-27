#!/usr/bin/env node
// The commit gate's typecheck delta (P03-GATE-TC 2026-11-18), owned by commitPackageTypecheck.mjs. This file is only its
// entry: the admission broker ranks a request by its admitted script, and this one takes the top rank, so the gate's
// worker compile is never queued behind lane work or the rolling HEAD typecheck.
//
//   node scripts/workspaces/commitGateTypecheck.mjs --base=<rev> --tree=<tree-ish>
//   node scripts/workspaces/commitGateTypecheck.mjs --report --commit=<landed sha>   (queue one exact report)
//
// Exit status: 0 no new diagnostics (or nothing to check, or the worker could not judge: printed, never refused),
// 1 new diagnostics or a candidate compile that did not complete while its parent's did, 2 usage or runtime failure.
// Worker-side invocations (--worker-rows, --compiler-admitted) run the owner's CLI under this entry's identity.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitGateTypecheck, commitPackageTypecheckMain, commitPackageTypecheckRefuses, formatCommitPackageTypecheck, kickRollingHeadTypecheck, queueCommitGateReport } from './commitPackageTypecheck.mjs';

const entry = fileURLToPath(import.meta.url);

async function main(argv) {
  if (argv.includes('--worker-rows') || argv.includes('--compiler-admitted') || argv.includes('--prepare-dependencies')) return await commitPackageTypecheckMain(argv, entry);
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (argv.includes('--report') && option('commit')) {
    for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete process.env[name];
    const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['rev-parse', '--verify', `${option('commit')}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
    await queueCommitGateReport({ repo, commit });
    console.log(`queued exact commit report ${commit}; ${kickRollingHeadTypecheck({ repo })}`);
    return 0;
  }
  if (!option('base') || !option('tree')) {
    console.error('usage: commitGateTypecheck.mjs --base=<rev> --tree=<tree-ish>');
    return 2;
  }
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete process.env[name];
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const result = await commitGateTypecheck({ repo, base: option('base'), tree: option('tree') });
  for (const line of formatCommitPackageTypecheck(result)) console.log(line);
  if (result.detached.length) console.log(`package typecheck: ${result.detached.join(', ')} checked by the rolling HEAD typecheck right after the commit lands`);
  return commitPackageTypecheckRefuses(result) ? 1 : 0;
}

if (process.argv[1] && entry === resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stderr?.toString?.() || error?.message || error);
    process.exitCode = 2;
  }
}
