import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';
import { collectPublisherExternalActionUses } from './workflowSecurityTestkit.mjs';

const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);
const rules = ['candidate-isolation', 'action-pins', 'shell-inputs', 'app-token-scope', 'actor-admission'];
const secretReference = /\bsecrets\s*(?:\.|\[)/;
const expressions = /\$\{\{([\s\S]*?)\}\}/g;

// These artifact builders execute candidate source even when they download it
// rather than check it out. Keep this independent of their credential settings.
const candidateBuilders = {
  'publish-cli-binaries.yml': ['build_native'],
  'publish-hstack-binaries.yml': ['build_candidate', 'build_windows_service_launcher'],
  'publish-runner-binaries.yml': ['build_candidate'],
  'publish-server-runtime.yml': ['build_native'],
  'publish-ui-web.yml': ['build_candidate'],
  'release-npm.yml': ['release', 'build_windows_service_launcher'],
  'build-tauri.yml': ['build'],
};

function actionName(uses) {
  return String(uses ?? '').split('@')[0];
}

function needs(job) {
  return Array.isArray(job?.needs) ? job.needs : job?.needs ? [job.needs] : [];
}

function hasSecrets(value) {
  return secretReference.test(JSON.stringify(value ?? {}));
}

function isCandidateJob(file, workflow, id, job) {
  if (candidateBuilders[file]?.includes(id)) return true;
  const checkouts = (job.steps ?? []).filter((step) => actionName(step.uses) === 'actions/checkout');
  // pull_request_target is deliberately excluded: it runs trusted base control.
  // This conservative classification does not evaluate job `if` expressions.
  // Explicit-only jobs in a PR-capable workflow need review before this draft
  // can replace their existing admission contracts.
  if (Object.hasOwn(workflow.on ?? {}, 'pull_request') && checkouts.some((step) => (
    step.with?.ref !== '${{ job.workflow_sha }}'
    && step.with?.ref !== '${{ github.event.repository.default_branch }}'
  ))) return true;
  return false;
}

function privileged(workflow, job) {
  const permissions = job.permissions ?? workflow.permissions;
  return hasSecrets({ env: workflow.env, job }) || job.secrets === 'inherit'
    || permissions === 'write-all'
    || (permissions && typeof permissions === 'object' && Object.values(permissions).includes('write'));
}

function hasActorGuard(job) {
  const steps = job?.steps ?? [];
  const index = steps.findIndex((step) => (
    step.uses === './.github/actions/release-actor-guard' && step.if === undefined
    && step['continue-on-error'] !== true
  ));
  return index >= 0 && !steps.slice(0, index).some(hasSecrets);
}

function guardedByActor(jobs, id, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const job = jobs[id];
  if (!job || job['continue-on-error'] === true) return false;
  if (hasActorGuard(job)) return true;
  // An always()/!cancelled() dependent can run after a failed guard. Require
  // its explicit successful dependency result rather than just graph reachability.
  return needs(job).some((dependency) => (
    guardedByActor(jobs, dependency, new Set(seen))
    && (!job.if || !/\b(?:always|cancelled)\s*\(/.test(job.if)
      || String(job.if).includes(`needs.${dependency}.result == 'success'`))
  ));
}

function securityViolations(workflows, rule) {
  const violations = [];
  for (const [file, workflow] of workflows) {
    const jobs = workflow.jobs ?? {};
    if (rule === 'candidate-isolation') {
      for (const id of candidateBuilders[file] ?? []) {
        if (!jobs[id]) violations.push(`${file}/${id}: candidate builder missing; review its replacement`);
      }
    }
    for (const [id, job] of Object.entries(jobs)) {
      const label = `${file}/${id}`;
      if (rule === 'candidate-isolation' && isCandidateJob(file, workflow, id, job)) {
        if (hasSecrets({ env: workflow.env, job }) || job.secrets === 'inherit') {
          violations.push(`${label}: candidate code receives secrets`);
        }
        if (job.environment !== undefined) violations.push(`${label}: candidate code enters a credential environment`);
        const permissions = job.permissions ?? workflow.permissions;
        if (permissions === 'write-all' || (permissions && typeof permissions === 'object'
          && Object.values(permissions).includes('write'))) {
          violations.push(`${label}: candidate code receives write authority`);
        }
        for (const step of job.steps ?? []) {
          if (actionName(step.uses) === 'actions/checkout' && step.with?.['persist-credentials'] !== false) {
            violations.push(`${label}: candidate checkout persists credentials`);
          }
        }
      }
      if (rule === 'action-pins' && privileged(workflow, job)) {
        for (const step of [job, ...(job.steps ?? [])]) {
          if (step.uses && !step.uses.startsWith('./') && !/^[^@]+@[a-f\d]{40}$/i.test(step.uses)) {
            violations.push(`${label}: privileged action is not SHA-pinned: ${step.uses}`);
          }
        }
      }
      if (rule === 'shell-inputs') {
        for (const step of job.steps ?? []) {
          for (const [, expression] of String(step.run ?? '').matchAll(expressions)) {
            if (/\binputs\b|\bgithub\s*(?:\.\s*event\b|\[\s*['"]event['"]\s*\])/.test(expression)) {
              violations.push(`${label}: event/input expression enters shell source: ${expression.trim()}`);
            }
          }
        }
      }
      if (rule === 'app-token-scope') {
        for (const step of job.steps ?? []) {
          if (actionName(step.uses) !== 'actions/create-github-app-token') continue;
          const scope = step.with ?? {};
          if (!String(scope.owner ?? '').trim() || !String(scope.repositories ?? '').trim()
            || !Object.entries(scope).some(([key, value]) => key.startsWith('permission-') && ['read', 'write'].includes(value))) {
            violations.push(`${label}: App token lacks explicit owner, repositories or permissions`);
          }
        }
      }
      if (rule === 'actor-admission' && (hasSecrets({ env: workflow.env, job }) || job.secrets === 'inherit')
        && !job.uses && !guardedByActor(jobs, id)) {
        violations.push(`${label}: credential-bearing job has no required actor guard`);
      }
    }
  }
  return violations.sort();
}

const workflows = new Map(await Promise.all((await readdir(workflowDirectory))
  .filter((file) => /\.ya?ml$/.test(file))
  .map(async (file) => [file, YAML.parse(await readFile(new URL(file, workflowDirectory), 'utf8'))])));

test('workflow security W8: privileged composite actions pin every nested remote action', async () => {
  const violations = [];
  for (const [file, workflow] of workflows) {
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      if (!privileged(workflow, job)) continue;
      const uses = await collectPublisherExternalActionUses({ jobs: { [id]: job } });
      for (const use of uses) {
        if (!/^[^@]+@[a-f\d]{40}$/i.test(use)) violations.push(`${file}/${id}: ${use}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('workflow security W1: PR workflows cap candidate tokens explicitly at read', () => {
  for (const workflow of workflows.values()) {
    if (!Object.hasOwn(workflow.on ?? {}, 'pull_request')) continue;
    assert.ok(workflow.permissions && typeof workflow.permissions === 'object');
    assert.ok(Object.values(workflow.permissions).every((value) => ['read', 'none'].includes(value)));
  }
});

test('workflow security W2: daemon E2E uses public test credentials without reading secrets', () => {
  const job = workflows.get('tests.yml').jobs['cli-daemon-e2e'];
  assert.equal(hasSecrets(job), false);
  assert.equal(typeof job.env.HANDY_MASTER_SECRET, 'string');
  assert.doesNotMatch(job.env.HANDY_MASTER_SECRET, /\$\{\{/);
});

test('workflow security W3: mobile release messages enter shells as data', () => {
  assert.deepEqual(securityViolations(new Map([
    ['publish-ui-mobile-dev.yml', workflows.get('publish-ui-mobile-dev.yml')],
  ]), 'shell-inputs'), []);
});

test('workflow security W3: the real mobile shell preserves shell-significant release notes as one argument', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-release-message-'));
  try {
    await mkdir(join(root, 'bin'));
    // The child executable is the OS boundary; the workflow shell stays real.
    await writeFile(join(root, 'bin/node'), '#!/bin/sh\nprintf "%s\\0" "$@" > "$ARGV_PATH"\n', { mode: 0o755 });
    const workflow = workflows.get('publish-ui-mobile-dev.yml');
    const step = workflow.jobs.publish.steps.find((entry) => entry.run?.includes('--release-message'));
    const sentinel = join(root, 'executed');
    for (const message of ['', 'notes"; $(touch "$SIDE_EFFECT")\nnext=value']) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: root, encoding: 'utf8', env: {
          ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          EAS_CLI_VERSION: workflow.env.EAS_CLI_VERSION, RELEASE_MESSAGE: message,
          ARGV_PATH: join(root, 'argv'), SIDE_EFFECT: sentinel,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const args = (await readFile(join(root, 'argv'), 'utf8')).split('\0').slice(0, -1);
      assert.equal(args[args.indexOf('--release-message') + 1], message);
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true });
  }
});











function compliantFixture() {
  return new Map([['publish-cli-binaries.yml', {
    on: { workflow_call: {} },
    permissions: { contents: 'read' },
    jobs: {
      release_actor_guard: {
        steps: [{ uses: './.github/actions/release-actor-guard' }],
      },
      build_native: {
        needs: ['release_actor_guard'],
        permissions: {},
        steps: [
          { uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', with: { 'persist-credentials': false } },
          { run: 'build-candidate' },
        ],
      },
      publish: {
        needs: ['build_native'],
        permissions: { contents: 'write' },
        steps: [{
          uses: 'actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547',
          with: {
            'private-key': '${{ secrets.RELEASE_BOT_PRIVATE_KEY }}',
            owner: '${{ github.repository_owner }}',
            repositories: '${{ github.event.repository.name }}',
            'permission-contents': 'write',
          },
        }, {
          env: { RELEASE_MESSAGE: '${{ inputs.release_message }}' },
          run: 'publish --message "$RELEASE_MESSAGE"',
        }],
      },
    },
  }]]);
}

test('security mutation fixtures reject each broken trust boundary and accept the legitimate publisher', () => {
  const fixture = compliantFixture();
  for (const rule of rules) assert.deepEqual(securityViolations(fixture, rule), [], rule);
  for (const [rule, mutate] of [
    ['candidate-isolation', (jobs) => { jobs.build_native.env = { TOKEN: '${{ secrets.X }}' }; }],
    ['candidate-isolation', (jobs) => { delete jobs.build_native.steps[0].with['persist-credentials']; }],
    ['action-pins', (jobs) => { jobs.publish.steps[0].uses = 'actions/create-github-app-token@v2'; }],
    ['shell-inputs', (jobs) => { jobs.publish.steps[1].run = 'publish "${{ inputs.release_message }}"'; }],
    ['app-token-scope', (jobs) => { delete jobs.publish.steps[0].with.repositories; }],
    ['app-token-scope', (jobs) => { delete jobs.publish.steps[0].with['permission-contents']; }],
    ['actor-admission', (jobs) => { delete jobs.release_actor_guard; }],
    ['actor-admission', (jobs) => { jobs.publish.if = '${{ always() }}'; }],
    ['actor-admission', (jobs) => { jobs.release_actor_guard.steps[0]['continue-on-error'] = true; }],
    ['actor-admission', (jobs) => {
      jobs.release_actor_guard.steps.unshift({ env: { TOKEN: '${{ secrets.X }}' }, run: 'publish' });
    }],
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed.get('publish-cli-binaries.yml').jobs);
    assert.ok(securityViolations(changed, rule).length > 0, `undetected ${rule} mutation`);
  }
});

test('security presentation fixtures survive step renames and YAML format round trips', () => {
  // Check both the clean positive fixture and the entire current workflow set.
  // Existing policy failures must be identical, never hidden by presentation.
  for (const source of [compliantFixture(), workflows]) {
    const renamed = structuredClone(source);
    for (const workflow of renamed.values()) {
      for (const job of Object.values(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) step.name = `Renamed step ${index}`;
      }
    }
    const roundTripped = new Map([...source].map(([file, workflow]) => [file, YAML.parse(YAML.stringify(workflow))]));
    for (const rule of rules) {
      const expected = securityViolations(source, rule);
      assert.deepEqual(securityViolations(renamed, rule), expected, `${rule}: P1 step renames`);
      assert.deepEqual(securityViolations(roundTripped, rule), expected, `${rule}: P2 format round trip`);
    }
  }
});
