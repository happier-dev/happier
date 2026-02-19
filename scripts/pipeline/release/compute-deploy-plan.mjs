// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
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

/**
 * @param {string} summaryPath
 * @param {string[]} lines
 */
function writeStepSummary(summaryPath, lines) {
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string; stdio?: 'pipe' | 'inherit'; allowFailure?: boolean }} opts
 * @returns {string}
 */
function run(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', opts.stdio ?? 'pipe', opts.stdio ?? 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (err) {
    if (opts.allowFailure) return '';
    throw err;
  }
}

/**
 * Minimal glob-to-regex for the patterns used in release.yml.
 * - `*` matches any non-slash chars
 * - `**` matches any chars including slashes
 * - `?` matches a single non-slash char
 * @param {string} glob
 */
function globToRegex(glob) {
  const raw = String(glob ?? '').trim();
  const escaped = raw.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // For bash `case`-style patterns used in workflows, `*` effectively matches any characters,
  // including slashes (paths are matched as strings, not path segments).
  const withStar = escaped.replace(/\*/g, '.*');
  const withQ = withStar.replace(/\?/g, '.');
  return new RegExp(`^${withQ}$`);
}

/**
 * @param {string[]} patterns
 * @param {string[]} paths
 */
function anyMatch(patterns, paths) {
  const regexes = patterns.map(globToRegex);
  for (const p of paths) {
    for (const re of regexes) {
      if (re.test(p)) return true;
    }
  }
  return false;
}

/**
 * @param {string} cwd
 * @param {string} remote
 * @param {string[]} refs
 */
function fetchRefs(cwd, remote, refs, required) {
  if (refs.length === 0) return;
  for (const ref of refs) {
    run('git', ['fetch', remote, ref, '--prune', '--tags'], { cwd, stdio: 'pipe', allowFailure: !required });
  }
}

/**
 * @param {string} cwd
 * @param {string} ref
 */
function revParseOrEmpty(cwd, ref) {
  return run('git', ['rev-parse', ref], { cwd, stdio: 'pipe', allowFailure: true });
}

/**
 * @param {string} cwd
 * @param {string} fromSha
 * @param {string} toSha
 */
function commitCount(cwd, fromSha, toSha) {
  const raw = run('git', ['rev-list', '--count', `${fromSha}..${toSha}`], { cwd, stdio: 'pipe', allowFailure: true });
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * @param {string} cwd
 * @param {string} a
 * @param {string} b
 * @param {string} fallback
 */
function mergeBaseOr(cwd, a, b, fallback) {
  const base = run('git', ['merge-base', a, b], { cwd, stdio: 'pipe', allowFailure: true });
  return base || fallback;
}

/**
 * @param {string} cwd
 * @param {string} from
 * @param {string} to
 */
function diffPaths(cwd, from, to) {
  const raw = run('git', ['diff', '--name-only', `${from}..${to}`], { cwd, stdio: 'pipe', allowFailure: true });
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      'deploy-environment': { type: 'string' },
      'source-ref': { type: 'string' },
      'force-deploy': { type: 'string' },
      'deploy-ui': { type: 'string' },
      'deploy-server': { type: 'string' },
      'deploy-website': { type: 'string' },
      'deploy-docs': { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
  const sourceRef = String(values['source-ref'] ?? '').trim();
  if (!deployEnvironment) fail('--deploy-environment is required');
  if (!sourceRef) fail('--source-ref is required');

  const forceDeploy = parseBoolString(values['force-deploy'], '--force-deploy');
  const deployUi = parseBoolString(values['deploy-ui'], '--deploy-ui');
  const deployServer = parseBoolString(values['deploy-server'], '--deploy-server');
  const deployWebsite = parseBoolString(values['deploy-website'], '--deploy-website');
  const deployDocs = parseBoolString(values['deploy-docs'], '--deploy-docs');

  const remote = String(values.remote ?? '').trim() || 'origin';

  fetchRefs(repoRoot, remote, [sourceRef], true);
  fetchRefs(
    repoRoot,
    remote,
    [
      `deploy/${deployEnvironment}/ui`,
      `deploy/${deployEnvironment}/server`,
      `deploy/${deployEnvironment}/website`,
      `deploy/${deployEnvironment}/docs`,
    ],
    false,
  );

  const sourceSha = revParseOrEmpty(repoRoot, `${remote}/${sourceRef}`);
  if (!sourceSha) fail(`Unable to resolve ${remote}/${sourceRef}`);

  /**
   * @param {string} key
   * @param {string} deployRef
   * @param {boolean} enabled
   * @param {string[]} patterns
   */
  function planOne(key, deployRef, enabled, patterns) {
    const deploySha = revParseOrEmpty(repoRoot, `${remote}/${deployRef}`);
    if (!deploySha) {
      return { needed: Boolean(enabled && forceDeploy), commits_behind: 0, relevant_changes: false };
    }

    const commits = commitCount(repoRoot, deploySha, sourceSha);
    const base = mergeBaseOr(repoRoot, deploySha, sourceSha, deploySha);
    const changed = commits !== 0 ? anyMatch(patterns, diffPaths(repoRoot, base, sourceSha)) : false;
    const needed = Boolean((enabled && forceDeploy) || (enabled && commits !== 0 && changed));
    return { needed, commits_behind: commits, relevant_changes: changed };
  }

  const ui = planOne('deploy_ui', `deploy/${deployEnvironment}/ui`, deployUi, [
    'apps/ui/*',
    'packages/agents/*',
    'packages/protocol/*',
  ]);
  const server = planOne('deploy_server', `deploy/${deployEnvironment}/server`, deployServer, [
    'apps/server/*',
    'packages/relay-server/*',
    'packages/agents/*',
    'packages/protocol/*',
  ]);
  const website = planOne('deploy_website', `deploy/${deployEnvironment}/website`, deployWebsite, [
    'apps/website/*',
    'scripts/release/installers/*',
    'scripts/pipeline/release/sync-installers.mjs',
  ]);
  const docs = planOne('deploy_docs', `deploy/${deployEnvironment}/docs`, deployDocs, ['apps/docs/*']);

  const githubOutput = String(values['github-output'] ?? '').trim();
  writeGithubOutput(githubOutput, {
    deploy_ui_needed: ui.needed ? 'true' : 'false',
    deploy_ui_commits: String(ui.commits_behind),
    deploy_ui_relevant_changes: ui.relevant_changes ? 'true' : 'false',
    deploy_server_needed: server.needed ? 'true' : 'false',
    deploy_server_commits: String(server.commits_behind),
    deploy_server_relevant_changes: server.relevant_changes ? 'true' : 'false',
    deploy_website_needed: website.needed ? 'true' : 'false',
    deploy_website_commits: String(website.commits_behind),
    deploy_website_relevant_changes: website.relevant_changes ? 'true' : 'false',
    deploy_docs_needed: docs.needed ? 'true' : 'false',
    deploy_docs_commits: String(docs.commits_behind),
    deploy_docs_relevant_changes: docs.relevant_changes ? 'true' : 'false',
  });

  const stepSummaryPath = String(process.env.GITHUB_STEP_SUMMARY ?? '').trim();
  writeStepSummary(stepSummaryPath, [
    '## Deploy plan (source → deploy branches)',
    '',
    `- environment: \`${deployEnvironment}\``,
    `- source ref: \`${sourceRef}\``,
    `- ${remote}/${sourceRef}: \`${sourceSha}\``,
    '',
    '| component | enabled | deploy ref | commits behind | relevant changes | will run |',
    '|---|---:|---|---:|---:|---:|',
    `| ui | ${deployUi} | deploy/${deployEnvironment}/ui | ${ui.commits_behind} | ${ui.relevant_changes} | ${ui.needed} |`,
    `| server | ${deployServer} | deploy/${deployEnvironment}/server | ${server.commits_behind} | ${server.relevant_changes} | ${server.needed} |`,
    `| website | ${deployWebsite} | deploy/${deployEnvironment}/website | ${website.commits_behind} | ${website.relevant_changes} | ${website.needed} |`,
    `| docs | ${deployDocs} | deploy/${deployEnvironment}/docs | ${docs.commits_behind} | ${docs.relevant_changes} | ${docs.needed} |`,
  ]);

  const result = {
    deploy_environment: deployEnvironment,
    source_ref: sourceRef,
    source_sha: sourceSha,
    deploy_ui: ui,
    deploy_server: server,
    deploy_website: website,
    deploy_docs: docs,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
