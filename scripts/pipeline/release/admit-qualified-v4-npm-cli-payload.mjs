#!/usr/bin/env node

// @ts-check

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  runQualifiedConnectedAccountsV4ActivationAdmission,
} from '../../release/qualified-connected-accounts-v4-activation-admission.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const BASELINE_REF = 'refs/qualified-v4-payload-baseline';
const RETRY_CANDIDATE_REF = 'refs/qualified-v4-payload-candidate';

/**
 * Resolve the npm-publication facts which must be coupled to the exact
 * candidate. The workflow supplies topology; this is the sole owner of the
 * deployed-baseline lookup and candidate identity check.
 *
 * @param {{ channel: unknown; candidateRef: unknown; candidateSha: unknown }} input
 */
export function resolveQualifiedV4NpmCliPayloadAdmission(input) {
  const channel = String(input.channel ?? '').trim();
  if (channel !== 'preview' && channel !== 'production') {
    throw new Error(`--channel must be 'preview' or 'production' (got '${channel || '<empty>'}')`);
  }

  const candidateRef = String(input.candidateRef ?? '').trim();
  if (candidateRef !== 'HEAD' && candidateRef !== RETRY_CANDIDATE_REF) {
    throw new Error(`--candidate-ref must be HEAD or ${RETRY_CANDIDATE_REF}`);
  }

  const candidateSha = String(input.candidateSha ?? '').trim();
  if (!COMMIT_SHA.test(candidateSha)) {
    throw new Error('--candidate-sha must be exactly 40 lowercase hexadecimal characters.');
  }

  return {
    channel,
    deployEnvironment: channel === 'production' ? 'production' : 'preview',
    deployBranch: `deploy/${channel === 'production' ? 'production' : 'preview'}/server`,
    candidateRef,
    candidateSha,
  };
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 */
function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status === 0 || allowFailure) return result;
  const details = String(result.stderr || result.stdout || '').trim();
  throw new Error(
    `[npm-qualified-v4-admission] git ${args.join(' ')} failed with exit ${result.status}` +
    (details ? `: ${details}` : ''),
  );
}

/**
 * @param {{
 *   channel: unknown;
 *   candidateRef: unknown;
 *   candidateSha: unknown;
 *   summaryFile?: unknown;
 * }} input
 * @param {{
 *   repoRoot?: string;
 *   runGit?: (args: string[], options?: { allowFailure?: boolean }) => { status: number | null; stdout?: string | Buffer | null };
 *   runAdmission?: (argv: string[]) => Promise<unknown>;
 * }} [dependencies]
 */
export async function admitQualifiedV4NpmCliPayload(input, dependencies = {}) {
  const resolved = resolveQualifiedV4NpmCliPayloadAdmission(input);
  const repoRoot = resolve(dependencies.repoRoot ?? process.cwd());
  const runGit = dependencies.runGit ?? ((args, options) => git(repoRoot, args, options));
  const runAdmission = dependencies.runAdmission
    ?? runQualifiedConnectedAccountsV4ActivationAdmission;

  if (resolved.candidateRef === RETRY_CANDIDATE_REF) {
    runGit(['fetch', '--no-tags', '--depth=1', 'origin', resolved.candidateSha]);
    runGit(['update-ref', RETRY_CANDIDATE_REF, 'FETCH_HEAD']);
  }

  const candidateAtRef = String(
    runGit(['rev-parse', '--verify', `${resolved.candidateRef}^{commit}`]).stdout ?? '',
  ).trim();
  if (candidateAtRef !== resolved.candidateSha) {
    throw new Error(
      `[npm-qualified-v4-admission] candidate ref ${resolved.candidateRef} resolved to ` +
      `'${candidateAtRef || '<empty>'}', expected admitted SHA '${resolved.candidateSha}'.`,
    );
  }

  const baseline = runGit([
    'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${resolved.deployBranch}`,
  ], { allowFailure: true });
  if (baseline.status === 0) {
    runGit([
      'fetch', '--no-tags', 'origin', `refs/heads/${resolved.deployBranch}:${BASELINE_REF}`,
    ]);
  } else if (baseline.status !== 2) {
    throw new Error(
      `[npm-qualified-v4-admission] unable to resolve deployed server migration baseline ` +
      `${resolved.deployBranch} (git ls-remote exited ${baseline.status}).`,
    );
  }

  const summaryFile = String(input.summaryFile ?? '').trim();
  const admissionArgs = [
    '--repo-root', repoRoot,
    '--admission-kind', 'payload-publication',
    '--baseline-ref', BASELINE_REF,
    '--candidate-ref', resolved.candidateRef,
    ...(summaryFile ? ['--summary-file', summaryFile] : []),
  ];
  const result = await runAdmission(admissionArgs);
  return { ...resolved, baselineRef: BASELINE_REF, result };
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      channel: { type: 'string' },
      'candidate-ref': { type: 'string' },
      'candidate-sha': { type: 'string' },
      'summary-file': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  return admitQualifiedV4NpmCliPayload({
    channel: values.channel,
    candidateRef: values['candidate-ref'],
    candidateSha: values['candidate-sha'],
    summaryFile: values['summary-file'],
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
