// @ts-check

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promoteDeployRef } from './deploy-ref-cas.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>; dryRun?: boolean }} [opts]
 */
function run(cmd, args, opts) {
  const dryRun = opts?.dryRun === true;
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    env: { ...process.env, ...(opts?.env ?? {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/**
 * @param {string} remoteUrl
 * @returns {string}
 */
function inferRepoFromRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl ?? '').trim();
  if (!raw) return '';

  if (raw.startsWith('https://github.com/')) {
    const suffix = raw.slice('https://github.com/'.length).replace(/\.git$/, '');
    const [owner, repo] = suffix.split('/').filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : '';
  }

  if (raw.startsWith('git@github.com:')) {
    const suffix = raw.slice('git@github.com:'.length).replace(/\.git$/, '');
    const [owner, repo] = suffix.split('/').filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : '';
  }

  return '';
}

/**
 * @returns {string}
 */
function inferRepoFromGitOrigin() {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    return inferRepoFromRemoteUrl(remoteUrl);
  } catch {
    return '';
  }
}

/**
 * @param {string} filePath
 * @param {string} markdown
 */
function appendSummary(filePath, markdown) {
  if (!filePath) return;
  fs.appendFileSync(filePath, markdown, 'utf8');
}

/**
 * @param {string} deployEnvironment
 * @returns {deployEnvironment is 'production' | 'preview'}
 */
function isDeployEnvironment(deployEnvironment) {
  return deployEnvironment === 'production' || deployEnvironment === 'preview';
}

/**
 * @param {string} component
 * @returns {component is 'ui' | 'server' | 'website' | 'docs'}
 */
function isComponent(component) {
  return component === 'ui' || component === 'server' || component === 'website' || component === 'docs';
}

function main() {
  const { values } = parseArgs({
    options: {
      'deploy-environment': { type: 'string' },
      component: { type: 'string' },
      'source-ref': { type: 'string', default: '' },
      sha: { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
      'summary-file': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
      remote: { type: 'string', default: 'origin' },
    },
    allowPositionals: false,
  });

  const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
  const component = String(values.component ?? '').trim();
  const sourceRef = String(values['source-ref'] ?? '').trim();
  const shaOverride = String(values.sha ?? '').trim();
  const dryRun = values['dry-run'] === true;
  const summaryFile = String(values['summary-file'] ?? '').trim();
  const githubOutput = String(values['github-output'] ?? '').trim();
  const remote = String(values.remote ?? '').trim();

  if (!isDeployEnvironment(deployEnvironment)) {
    fail(`--deploy-environment must be 'production' or 'preview' (got: ${deployEnvironment || '<empty>'})`);
  }
  if (!isComponent(component)) {
    fail(`--component must be 'ui', 'server', 'website', or 'docs' (got: ${component || '<empty>'})`);
  }
  if (!shaOverride && !sourceRef) {
    fail('One of --sha or --source-ref is required');
  }

  const targetBranch = `deploy/${deployEnvironment}/${component}`;

  const repo =
    String(process.env.GH_REPO ?? '').trim() ||
    String(process.env.GITHUB_REPOSITORY ?? '').trim() ||
    inferRepoFromGitOrigin();
  if (!repo && !dryRun) {
    fail('Missing GH_REPO/GITHUB_REPOSITORY and could not infer from git remote.');
  }

  /** @type {Record<string, string>} */
  const ghEnv = {};
  if (repo) ghEnv.GH_REPO = repo;
  const token = String(process.env.GH_TOKEN ?? '').trim();
  if (token) ghEnv.GH_TOKEN = token;

  let sourceSha = shaOverride;
  if (!sourceSha) {
    const branchName = sourceRef.replace(/^refs\/heads\//, '');
    const branchRef = encodeURIComponent(branchName);
    const sourceApi = repo ? `repos/${repo}/git/ref/heads/${branchRef}` : `repos/OWNER/REPO/git/ref/heads/${branchRef}`;
    sourceSha = run('gh', ['api', sourceApi, '--jq', '.object.sha'], { env: ghEnv, dryRun }).trim();
  }
  if (dryRun && !sourceSha) {
    sourceSha = '0123456789abcdef0123456789abcdef01234567';
  }

  const targetRef = `refs/heads/${targetBranch}`;
  const authorizationHeader =
    String(process.env.HAPPIER_GIT_AUTHORIZATION_HEADER ?? '').trim() || (token ? `AUTHORIZATION: bearer ${token}` : '');
  let result;
  try {
    result = promoteDeployRef({ candidateSha: sourceSha, targetRef, remote, authorizationHeader, dryRun });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  appendSummary(
    summaryFile,
    `## Promote deploy branch\n\n- target: \`${targetBranch}\`\n- source_ref: \`${sourceRef || '(sha override)'}\`\n- old_sha: \`${result.oldSha || '(missing)'}\`\n- new_sha: \`${result.newSha}\`\n- changed: \`${result.changed}\`\n\n`,
  );
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `old_sha=${result.oldSha ?? ''}\nnew_sha=${result.newSha}\nchanged=${result.changed}\n`, 'utf8');
  }
}

main();
