// @ts-check

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { promoteDeployRef, readCommitSha } from './deploy-ref-cas.mjs';

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** @param {unknown} raw */
function readCurrentSha(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'missing') return null;
  return readCommitSha(value, '--expected-current-sha');
}

const { values } = parseArgs({
  options: {
    'deploy-environment': { type: 'string' },
    'candidate-sha': { type: 'string' },
    'expected-current-sha': { type: 'string' },
    remote: { type: 'string', default: 'origin' },
    'summary-file': { type: 'string', default: '' },
    'github-output': { type: 'string', default: '' },
  },
  allowPositionals: false,
});

const deployEnvironment = String(values['deploy-environment'] ?? '').trim();
if (deployEnvironment !== 'preview' && deployEnvironment !== 'production') {
  fail('--deploy-environment must be preview or production.');
}

let result;
try {
  result = promoteDeployRef({
    candidateSha: readCommitSha(values['candidate-sha'], '--candidate-sha'),
    targetRef: `refs/heads/deploy/${deployEnvironment}/server`,
    remote: String(values.remote ?? '').trim(),
    authorizationHeader: String(process.env.HAPPIER_GIT_AUTHORIZATION_HEADER ?? ''),
    expectedCurrentSha: readCurrentSha(values['expected-current-sha']),
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const summaryFile = String(values['summary-file'] ?? '').trim();
if (summaryFile) {
  fs.appendFileSync(summaryFile, [
    '## Promote server deploy branch',
    '',
    `- target: \`deploy/${deployEnvironment}/server\``,
    `- old_sha: \`${result.oldSha ?? '(missing)'}\``,
    `- new_sha: \`${result.newSha}\``,
    `- changed: \`${result.changed}\``,
    '',
  ].join('\n'), 'utf8');
}
const githubOutput = String(values['github-output'] ?? '').trim();
if (githubOutput) {
  fs.appendFileSync(githubOutput, `old_sha=${result.oldSha ?? ''}\nnew_sha=${result.newSha}\nchanged=${result.changed}\n`, 'utf8');
}
console.log(`Promoted deploy/${deployEnvironment}/server atomically to ${result.newSha}.`);
