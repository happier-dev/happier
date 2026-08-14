#!/usr/bin/env node

// @ts-check

import { appendFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { summarizeReleaseStatus } from './summarize-release-status.mjs';

/** @param {Record<string, string | undefined>} env @param {string} name */
const value = (env, name) => env[name] === 'true';
/** @param {Record<string, string | undefined>} env @param {string} name */
const result = (env, name) => ['success', 'skipped'].includes(env[name] ?? '') ? env[name] : 'failed';

/** @param {Record<string, string | undefined>} env */
function baseRun(env) {
  return { id: Number(env.RELEASE_RUN), url: env.RELEASE_RUN_URL, name: env.RELEASE_RUN_NAME };
}

/** @param {'nightly'|'standard'} mode @param {Record<string, string | undefined>} env */
export function projectReleaseStatus(mode, env) {
  const sourceSha = env.SOURCE_SHA;
  const exact = (name) => result(env, name) === 'success';
  const requested = (id, requestedValue, required, evidence) => ({ id, requested: requestedValue, required, evidence });
  const observed = (id, name, verified, recoveryHint) => ({
    id,
    result: result(env, name),
    identity: { sourceSha, verified },
    recoveryHint,
  });
  const candidate = (id, product, requestedValue, resultName, versionName, resumeVerifiedName, recoveryHint) => {
    const version = env[versionName] || '';
    const verified = requestedValue
      && exact(resultName)
      && (exact('IMMUTABLE_VERIFICATION_RESULT') || value(env, resumeVerifiedName))
      && version !== '';
    return {
      id,
      result: requestedValue ? (verified ? 'success' : result(env, resultName)) : 'skipped',
      identity: { sourceSha, verified, ...(verified ? { product, version } : {}) },
      recoveryHint,
    };
  };
  const accepted = (id, name, recoveryHint) => ({
    id,
    result: exact(name) ? 'accepted' : result(env, name),
    identity: { sourceSha, verified: false },
    recoveryHint,
  });

  if (mode === 'nightly') {
    const item = (id, required, evidence, name, verified, recoveryHint) => ({
      id,
      requested: true,
      required,
      evidence,
      result: evidence === 'accepted' && exact(name) ? 'accepted' : result(env, name),
      identity: { sourceSha, verified },
      recoveryHint,
    });
    const candidateItem = (id, product, name, versionName, resumeVerifiedName, recoveryHint) => ({
      ...candidate(id, product, true, name, versionName, resumeVerifiedName, recoveryHint),
      requested: true,
      required: true,
      evidence: 'verified',
    });
    const promotedVerified = (name) => exact(name) && exact('POST_PROMOTION_RESULT');
    const items = [
      item('candidate', true, 'verified', 'CANDIDATE_RESULT', exact('CANDIDATE_RESULT'), { job: 'prepare_release_candidate' }),
      item('immutable_candidate_verification', true, 'verified', 'IMMUTABLE_VERIFICATION_RESULT', exact('IMMUTABLE_VERIFICATION_RESULT'), { job: 'release_verify' }),
      candidateItem('cli-immutable-candidate', 'cli', 'CLI_CANDIDATE_RESULT', 'CLI_CANDIDATE_VERSION', 'CLI_RESUME_VERIFIED', { job: 'cli' }),
      candidateItem('hstack-immutable-candidate', 'stack', 'STACK_CANDIDATE_RESULT', 'STACK_CANDIDATE_VERSION', 'HSTACK_RESUME_VERIFIED', { job: 'hstack' }),
      candidateItem('server-immutable-candidate', 'server', 'SERVER_CANDIDATE_RESULT', 'SERVER_CANDIDATE_VERSION', 'SERVER_RESUME_VERIFIED', { job: 'server_runtime' }),
      candidateItem('ui-web-immutable-candidate', 'ui-web', 'UI_WEB_CANDIDATE_RESULT', 'UI_WEB_CANDIDATE_VERSION', 'UI_WEB_RESUME_VERIFIED', { job: 'ui_web' }),
      item('cli_rolling_release', false, 'verified', 'CLI_RESULT', promotedVerified('CLI_RESULT'), { job: 'promote_cli' }),
      item('hstack_rolling_release', false, 'verified', 'STACK_RESULT', promotedVerified('STACK_RESULT'), { job: 'promote_hstack' }),
      item('server_rolling_release', false, 'verified', 'SERVER_RESULT', promotedVerified('SERVER_RESULT'), { job: 'promote_server' }),
      item('ui_web_rolling_release', false, 'verified', 'UI_WEB_RESULT', promotedVerified('UI_WEB_RESULT'), { job: 'promote_ui_web' }),
      item('ui_mobile', false, 'accepted', 'MOBILE_RESULT', false, { job: 'ui_mobile' }),
      item('ui_desktop', false, 'accepted', 'DESKTOP_RESULT', false, { job: 'ui_desktop' }),
      item('docker', false, 'accepted', 'DOCKER_RESULT', false, { job: 'docker' }),
      item('post_promotion_identity', false, 'verified', 'POST_PROMOTION_RESULT', exact('POST_PROMOTION_RESULT'), { job: 'verify_promoted' }),
    ];
    return summarizeReleaseStatus({
      run: baseRun(env),
      channel: 'dev',
      sourceSha,
      requestedSurfaces: items.map(({ id, requested: isRequested, required, evidence }) => ({ id, requested: isRequested, required, evidence })),
      surfaces: items.map(({ id, result: surfaceResult, identity, recoveryHint }) => ({ id, result: surfaceResult, identity, recoveryHint })),
    });
  }

  const request = {
    cli: value(env, 'REQUEST_CLI'), stack: value(env, 'REQUEST_STACK'), server: value(env, 'REQUEST_SERVER'), uiWeb: value(env, 'REQUEST_UI_WEB'),
    deployUi: value(env, 'REQUEST_DEPLOY_UI'), deployServer: value(env, 'REQUEST_DEPLOY_SERVER'), deployWebsite: value(env, 'REQUEST_DEPLOY_WEBSITE'), deployDocs: value(env, 'REQUEST_DEPLOY_DOCS'),
    docker: value(env, 'REQUEST_DOCKER'), npm: value(env, 'REQUEST_NPM'),
  };
  const releaseVerified = (name) => exact(name) && exact('RELEASE_VERIFY_RESULT');
  return summarizeReleaseStatus({
    operationId: env.HMAINT_OPERATION_ID || undefined,
    run: baseRun(env),
    channel: env.RELEASE_CHANNEL,
    sourceSha,
    requestedSurfaces: [
      requested('candidate', true, true, 'verified'), requested('immutable_candidate_verification', true, true, 'verified'),
      requested('cli-immutable-candidate', request.cli, false, 'verified'), requested('hstack-immutable-candidate', request.stack, false, 'verified'), requested('server-immutable-candidate', request.server, false, 'verified'), requested('ui-web-immutable-candidate', request.uiWeb, false, 'verified'),
      requested('cli_rolling_release', request.cli, false, 'verified'), requested('hstack_rolling_release', request.stack, false, 'verified'), requested('server_rolling_release', request.server, false, 'verified'), requested('ui_web_rolling_release', request.uiWeb, false, 'verified'),
      requested('deploy_ui', request.deployUi, false, 'accepted'), requested('deploy_server', request.deployServer, false, 'accepted'), requested('deploy_website', request.deployWebsite, false, 'accepted'), requested('deploy_docs', request.deployDocs, false, 'accepted'),
      requested('docker', request.docker, false, 'accepted'), requested('npm', request.npm, false, 'accepted'), requested('post_promotion_identity', true, false, 'verified'),
    ],
    surfaces: [
      observed('candidate', 'CANDIDATE_RESULT', exact('CANDIDATE_RESULT'), { job: 'prepare_release_candidate' }),
      observed('immutable_candidate_verification', 'IMMUTABLE_VERIFICATION_RESULT', exact('IMMUTABLE_VERIFICATION_RESULT'), { job: 'verify_release_candidates' }),
      candidate('cli-immutable-candidate', 'cli', request.cli, 'CLI_CANDIDATE_RESULT', 'CLI_VERSION', 'CLI_RESUME_VERIFIED', { job: 'publish_cli_binaries' }),
      candidate('hstack-immutable-candidate', 'stack', request.stack, 'STACK_CANDIDATE_RESULT', 'STACK_VERSION', 'HSTACK_RESUME_VERIFIED', { job: 'publish_hstack_binaries' }),
      candidate('server-immutable-candidate', 'server', request.server, 'SERVER_CANDIDATE_RESULT', 'SERVER_VERSION', 'SERVER_RESUME_VERIFIED', { job: 'publish_server_runtime' }),
      candidate('ui-web-immutable-candidate', 'ui-web', request.uiWeb, 'UI_WEB_CANDIDATE_RESULT', 'UI_WEB_VERSION', 'UI_WEB_RESUME_VERIFIED', { job: 'publish_ui_web' }),
      observed('cli_rolling_release', 'CLI_RESULT', releaseVerified('CLI_RESULT'), { job: 'promote_cli_binaries' }),
      observed('hstack_rolling_release', 'STACK_RESULT', releaseVerified('STACK_RESULT'), { job: 'promote_hstack_binaries' }),
      observed('server_rolling_release', 'SERVER_RESULT', releaseVerified('SERVER_RESULT'), { job: 'promote_server_runtime' }),
      observed('ui_web_rolling_release', 'UI_WEB_RESULT', releaseVerified('UI_WEB_RESULT'), { job: 'promote_ui_web' }),
      accepted('deploy_ui', 'DEPLOY_UI_RESULT', { job: 'deploy_ui' }), accepted('deploy_server', 'DEPLOY_SERVER_RESULT', { job: 'deploy_server' }), accepted('deploy_website', 'DEPLOY_WEBSITE_RESULT', { job: 'deploy_website' }), accepted('deploy_docs', 'DEPLOY_DOCS_RESULT', { job: 'deploy_docs' }), accepted('docker', 'DOCKER_RESULT', { job: 'publish_docker' }), accepted('npm', 'NPM_RESULT', { job: 'publish_npm' }),
      observed('post_promotion_identity', 'RELEASE_VERIFY_RESULT', exact('RELEASE_VERIFY_RESULT'), { job: 'release_verify' }),
    ],
  });
}

/** @param {ReturnType<typeof projectReleaseStatus>} status @param {'nightly'|'standard'} mode */
export function renderReleaseStatusMarkdown(status, mode) {
  const requestedColumn = mode === 'standard' ? ' | Requested' : '';
  const separatorColumn = mode === 'standard' ? ' | ---' : '';
  const lines = [
    `## ${mode === 'nightly' ? 'Nightly release' : 'Release'} status`,
    `Channel: \`${status.channel}\`  `,
    `Source: \`${status.sourceSha}\`  `,
    `Terminal: **${status.terminal}**`,
    '',
    `| Surface${requestedColumn} | State | Result | Exact identity |`,
    `| ---${separatorColumn} | --- | --- | --- |`,
  ];
  for (const surface of status.surfaces) {
    lines.push(`| ${surface.id}${mode === 'standard' ? ` | ${surface.requested}` : ''} | ${surface.state} | ${surface.result ?? '-'} | ${surface.identity?.verified === true ? 'yes' : 'no'} |`);
  }
  lines.push('', '<details><summary>Exact status JSON</summary>', '', '```json', JSON.stringify(status, null, 2), '```', '</details>', '');
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { mode: { type: 'string' }, out: { type: 'string' }, summary: { type: 'string', default: '' } }, allowPositionals: false });
  const mode = String(values.mode ?? '');
  if (mode !== 'nightly' && mode !== 'standard') throw new Error('--mode must be nightly or standard');
  const out = String(values.out ?? '');
  if (!out) throw new Error('--out is required');
  const status = projectReleaseStatus(mode, process.env);
  await writeFile(out, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  const summary = String(values.summary ?? '');
  if (summary) await appendFile(summary, renderReleaseStatusMarkdown(status, mode), 'utf8');
  return status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
