import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';
import { collectPublisherExternalActionUses } from './workflowSecurityTestkit.mjs';

const workflowDirectory = new URL('../../.github/workflows/', import.meta.url);
const rules = ['candidate-isolation', 'trusted-control', 'action-pins', 'shell-inputs', 'app-token-scope', 'actor-admission'];
const secretReference = /\bsecrets\s*(?:\.|\[)/;
const expressions = /\$\{\{([\s\S]*?)\}\}/g;
const guardAction = YAML.parse(await readFile(new URL('../../.github/actions/release-actor-guard/action.yml', import.meta.url), 'utf8'));

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

function events(workflow) {
  const on = workflow.on;
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [name, {}]));
  return on ?? {};
}

function readOnly(permissions) {
  return permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)
    && Object.values(permissions).every((value) => value === 'read' || value === 'none');
}

function writes(permissions) {
  return permissions === 'write-all' || (permissions && typeof permissions === 'object'
    && Object.values(permissions).includes('write'));
}

function tokenExposure(value) {
  return /\bgithub\s*(?:\.\s*token\b|\[\s*['"]token['"]\s*\])|\b(?:GH_TOKEN|GITHUB_TOKEN)\b/.test(JSON.stringify(value));
}

function onlyBuiltinToken(workflow, job) {
  return !hasSecrets({ env: workflow.env, job }) && job.secrets !== 'inherit' && job.environment === undefined
    && [workflow.env, job.env, ...(job.steps ?? []).map((step) => step.env)].every((env) => (
      Object.entries(env ?? {}).every(([key, value]) => !['GH_TOKEN', 'GITHUB_TOKEN'].includes(key)
        || /^\$\{\{\s*github\.token\s*\}\}$/.test(String(value)))
    ));
}

function isCandidateJob(file, workflow, id, job) {
  if (candidateBuilders[file]?.includes(id)) return true;
  const checkouts = (job.steps ?? []).filter((step) => actionName(step.uses) === 'actions/checkout');
  if (Object.hasOwn(events(workflow), 'pull_request') && checkouts.some((step) => (
    step.with?.ref !== '${{ job.workflow_sha }}'
    && step.with?.ref !== '${{ github.event.repository.default_branch }}'
  ))) return true;
  return false;
}

function privileged(workflow, job) {
  const permissions = job.permissions ?? workflow.permissions;
  return hasSecrets({ env: workflow.env, job }) || tokenExposure({ env: workflow.env, job })
    || job.secrets === 'inherit' || job.environment !== undefined || writes(permissions);
}

function hasActorGuard(job) {
  const steps = job?.steps ?? [];
  const index = steps.findIndex((step) => (
    step.uses === './.github/actions/release-actor-guard' && step.if === undefined
    && step['continue-on-error'] !== true
    && (step.with?.team_slug ?? guardAction.inputs.team_slug.default) === 'release-admins'
  ));
  const checkoutIndex = steps.findIndex((step) => actionName(step.uses) === 'actions/checkout'
    && step.with?.repository === '${{ job.workflow_repository }}'
    && step.with?.ref === '${{ job.workflow_sha }}' && step.with?.['persist-credentials'] === false);
  return index >= 0 && checkoutIndex >= 0 && checkoutIndex < index
    && job['continue-on-error'] !== true && !steps.slice(0, index).some(hasSecrets);
}

// Prove a required fact through conjunctions/disjunctions. Unknown atoms never
// prove admission. This is deliberately not a general GitHub expression evaluator.
function everyTruthyPathRequires(expression, requiredAtom) {
  let text = String(expression).replace(/^\s*\$\{\{|\}\}\s*$/g, '').trim();
  const split = (operator) => {
    let depth = 0;
    let quote = null;
    const parts = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quote) {
        if (character === quote && text[index + 1] === quote) { index += 1; continue; }
        if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"') { quote = character; continue; }
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0 && text.slice(index, index + operator.length) === operator) {
        parts.push(text.slice(start, index));
        start = index + operator.length;
        index += operator.length - 1;
      }
    }
    parts.push(text.slice(start));
    return parts;
  };
  for (const [operator, combine] of [['||', 'every'], ['&&', 'some']]) {
    const parts = split(operator);
    if (parts.length > 1) return parts[combine]((part) => everyTruthyPathRequires(part, requiredAtom));
  }
  if (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1);
    return everyTruthyPathRequires(text, requiredAtom);
  }
  return requiredAtom(text);
}

function guardedByActor(jobs, id, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const job = jobs[id];
  if (!job) return false;
  if (hasActorGuard(job)) return true;
  if (job.steps?.some((step) => step.uses === './.github/actions/release-actor-guard')) return false;
  const guarded = (dependency) => guardedByActor(jobs, dependency, new Set(seen));
  // GitHub adds implicit success() unless a status function occurs in `if`.
  if (!/\b(?:always|cancelled|failure|success)\s*\(/.test(String(job.if ?? ''))) return needs(job).some(guarded);
  return everyTruthyPathRequires(job.if, (atom) => {
    if (/^success\(\)$/.test(atom)) return needs(job).some(guarded);
    const dependency = atom.match(/^needs\.([\w-]+)\.result\s*==\s*['"]success['"]$/)?.[1];
    return dependency !== undefined && needs(job).includes(dependency) && guarded(dependency);
  });
}

function trustedCheckouts(job) {
  return (job.steps ?? []).filter((step) => actionName(step.uses) === 'actions/checkout').every((step) => (
    step.with?.ref === '${{ job.workflow_sha }}' && step.with?.repository === '${{ job.workflow_repository }}'
    && step.with?.['persist-credentials'] === false
  ));
}

function publicReadJob(workflow, job) {
  return readOnly(job.permissions ?? workflow.permissions) && onlyBuiltinToken(workflow, job)
    && (job.steps ?? []).filter((step) => actionName(step.uses) === 'actions/checkout')
      .every((step) => step.with?.['persist-credentials'] === false);
}

function triageAdmission(workflow, job) {
  const first = job.steps?.[0];
  const script = first?.with?.script ?? '';
  const checkout = job.steps?.find((step) => step.with?.repository === 'happier-dev/maintainers-tools');
  const token = job.steps?.find((step) => actionName(step.uses) === 'actions/create-github-app-token');
  return job.environment === 'issue-triage' && workflow.env === undefined
    && !hasSecrets(job.env) && actionName(first?.uses) === 'actions/github-script'
    && first.if === undefined && first['continue-on-error'] !== true
    && script.includes('getCollaboratorPermissionLevel') && script.includes('result.data.role_name')
    && script.includes('core.setFailed') && checkout?.with?.['persist-credentials'] === false
    && token?.with?.['permission-contents'] === 'read';
}

// Exceptions carry an asserted shape. They do not suppress unknown violations.
const exceptions = {
  'tests.yml/providers': {
    rules: ['candidate-isolation'], reason: 'Explicit, actor-admitted provider calls intentionally consume API keys in providers-ci.',
    matches: (workflow, job) => events(workflow).workflow_call !== undefined
      && events(workflow).workflow_call.inputs.select_jobs_explicitly.default === false
      && events(workflow).workflow_call.inputs.run_providers.default === false
      && job.environment === 'providers-ci' && guardedByActor(workflow.jobs, 'providers')
      && everyTruthyPathRequires(job.if, (atom) => atom === 'inputs.select_jobs_explicitly')
      && everyTruthyPathRequires(job.if, (atom) => atom === 'inputs.run_providers'),
  },
  'issue-triage.yml/triage': { rules: ['actor-admission'], reason: 'Inline collaborator admission intentionally accepts triage/write/maintain/admin.', matches: triageAdmission },
  'issue-triage-manual.yml/triage-manual': { rules: ['actor-admission'], reason: 'Manual triage shares the inline collaborator policy.', matches: triageAdmission },
  'roadmap-add-to-project.yml/add-to-project': {
    rules: ['actor-admission'], reason: 'Event automation uses issue data only. CI lead owns the outstanding roadmap environment branch-policy setting.',
    matches: (workflow, job) => job.environment === 'roadmap'
      && Object.keys(events(workflow)).every((event) => ['issues', 'workflow_dispatch'].includes(event))
      && job.steps.every((step) => ['actions/create-github-app-token', 'actions/github-script'].includes(actionName(step.uses)))
      && job.steps.find((step) => actionName(step.uses) === 'actions/create-github-app-token')?.with?.owner === 'happier-dev'
      && job.steps.find((step) => actionName(step.uses) === 'actions/create-github-app-token')?.with?.['permission-organization-projects'] === 'write',
  },
  'issue-needs-handoff.yml/reconcile': {
    rules: ['actor-admission'], reason: 'Trusted default-branch issue/PR event reconciler uses the built-in issue writer, never an App secret.',
    matches: (workflow, job) => !hasSecrets({ env: workflow.env, job }) && job.environment === undefined
      && (job.permissions ?? workflow.permissions)?.issues === 'write' && job.steps.filter((step) => actionName(step.uses) === 'actions/checkout')
        .every((step) => step.with?.ref === '${{ github.event.repository.default_branch }}' && step.with?.['persist-credentials'] === false),
  },
  'nightly-dev.yml/snapshot_source_issues': { rules: ['actor-admission'], reason: 'Public issue snapshot with read-only built-in token.', matches: publicReadJob },
  'nightly-dev.yml/prepare_release_candidate': { rules: ['actor-admission'], reason: 'Public source preparation with an explicit read-only built-in token.', matches: publicReadJob },
  'nightly-dev.yml/verify_source_ci': { rules: ['actor-admission'], reason: 'Public exact-source CI evidence read.', matches: publicReadJob },
  'nightly-dev.yml/advance_source_issues_to_dev': {
    rules: ['actor-admission'], reason: 'Nightly trusted-control bookkeeping writes only issue stage facts.',
    matches: (workflow, job) => !hasSecrets({ env: workflow.env, job }) && job.environment === undefined
      && job.permissions?.issues === 'write' && trustedCheckouts(job),
  },
  'release.yml/advance_release_issues': {
    rules: ['actor-admission'], reason: 'Trusted combined-release issue bookkeeping runs only after an eligible snapshot and a completed admitted release.',
    matches: (workflow, job) => !hasSecrets({ env: workflow.env, job }) && job.environment === undefined
      && job.permissions?.contents === 'read' && job.permissions?.issues === 'write'
      && Object.values(job.permissions).filter((value) => value === 'write').length === 1
      && ['snapshot_release_issues', 'release_preview', 'release_production'].every((id) => needs(job).includes(id))
      && everyTruthyPathRequires(job.if, (atom) => atom === "needs.snapshot_release_issues.outputs.eligible == 'true'")
      && everyTruthyPathRequires(job.if, (atom) => /^needs\.release_(?:preview|production)\.outputs\.release_complete == 'true'$/.test(atom))
      && job.steps.filter((step) => actionName(step.uses) === 'actions/checkout')
        .every((step) => step.with?.ref === undefined && step.with?.['persist-credentials'] === false)
      && job.steps.filter((step) => step.run).every((step) => String(step.run).includes('scripts/pipeline/github/reconcile-issue-stage.mjs advance')),
  },
  'release-source-validation.yml/ci': { rules: ['actor-admission'], reason: 'Public exact-source CI verification with a read-only token.', matches: publicReadJob },
  'release-verify.yml/verify_candidate_identity': { rules: ['actor-admission'], reason: 'Public signed candidate verification with a read-only token.', matches: publicReadJob },
  'resolve-release-resume.yml/resolve': { rules: ['actor-admission'], reason: 'Public prior-run and digest verification with a read-only token.', matches: publicReadJob },
};

async function securityViolations(workflows, rule, options = {}) {
  const violations = [];
  for (const [file, workflow] of workflows) {
    const jobs = workflow.jobs ?? {};
    if (rule === 'candidate-isolation') {
      if (events(workflow).pull_request !== undefined && !readOnly(workflow.permissions)) {
        violations.push(`${file}: PR workflow needs explicit read-only default permissions`);
      }
      for (const id of candidateBuilders[file] ?? []) {
        if (!jobs[id]) violations.push(`${file}/${id}: candidate builder missing; review its replacement`);
      }
    }
    for (const [id, job] of Object.entries(jobs)) {
      const label = `${file}/${id}`;
      const exception = exceptions[label];
      const allowed = exception?.rules.includes(rule) && exception.matches(workflow, job);
      if (exception?.rules.includes(rule) && !allowed) violations.push(`${label}: changed exception structure (${exception.reason})`);
      const permissions = job.permissions ?? workflow.permissions;
      if (rule === 'candidate-isolation' && isCandidateJob(file, workflow, id, job)) {
        if (!allowed && (hasSecrets({ env: workflow.env, job }) || job.secrets === 'inherit')) {
          violations.push(`${label}: candidate code receives secrets`);
        }
        if (!allowed && job.environment !== undefined) violations.push(`${label}: candidate code enters a credential environment`);
        // Callers can only narrow these grants; they cannot elevate a reusable
        // workflow. Explicit local read-only grants therefore bound every caller.
        if (!readOnly(permissions)) {
          violations.push(`${label}: candidate token permissions are missing or writable`);
        }
        const workspaceUpload = job.steps?.some((step) => actionName(step.uses) === 'actions/upload-artifact'
          && String(step.with?.path ?? '').split('\n').some((path) => path.trim() !== ''
            && /^(?:\.?\/?\*\*?(?:\/\*)?|\.?\/?|\$\{\{\s*github\.workspace\s*\}\}(?:\/\*\*)?)$/.test(path.trim())));
        for (const step of job.steps ?? []) {
          if (actionName(step.uses) === 'actions/checkout' && (writes(permissions) || workspaceUpload)
            && step.with?.['persist-credentials'] !== false) {
            violations.push(`${label}: candidate checkout persists credentials`);
          }
        }
      }
      if (rule === 'trusted-control' && Object.keys(events(workflow))
        .some((event) => ['pull_request_target', 'workflow_run', 'issue_comment', 'issues'].includes(event))) {
        if (/github\.event\.(?:pull_request\.(?:head|merge)|workflow_run\.head_)/.test(JSON.stringify(job))) {
          violations.push(`${label}: untrusted event head reaches trusted control`);
        }
        for (const step of job.steps ?? []) {
          if (actionName(step.uses) !== 'actions/checkout') continue;
          // These events default to trusted base/default-branch control; an
          // explicitly selected ref must preserve that boundary.
          if (step.with?.ref !== undefined && !['${{ job.workflow_sha }}', '${{ github.event.repository.default_branch }}'].includes(step.with.ref)) {
            violations.push(`${label}: trusted-control event checks out candidate source`);
          }
        }
      }
      if ((rule === 'action-pins' && privileged(workflow, job)) || rule === 'shell-inputs' || rule === 'app-token-scope') {
        const steps = [...(job.steps ?? [])];
        const uses = await collectPublisherExternalActionUses({ jobs: { [id]: job } }, {
          ...options, onLocalAction: (action) => { steps.push(...(action.runs?.steps ?? [])); },
        });
        if (rule === 'action-pins') {
          for (const use of uses) {
            if (!/^[^@]+@[a-f\d]{40}$/i.test(use)) violations.push(`${label}: privileged action is not SHA-pinned: ${use}`);
          }
        }
        if (rule === 'shell-inputs') {
          for (const step of steps) {
            const source = step.run ?? (actionName(step.uses) === 'actions/github-script' ? step.with?.script : '');
            for (const [, expression] of String(source ?? '').matchAll(expressions)) {
              const normalized = expression.replace(/\[\s*['"](\w+)['"]\s*\]/g, '.$1');
              if (/\b(?:inputs|secrets)\b|\bgithub\s*\.\s*(?:event|head_ref)\b/.test(normalized)) {
                violations.push(`${label}: untrusted/secret expression enters executable source: ${expression.trim()}`);
              }
            }
          }
        }
        if (rule === 'app-token-scope') {
          for (const step of steps) {
            if (actionName(step.uses) !== 'actions/create-github-app-token') continue;
            const scope = step.with ?? {};
            if (!String(scope.owner ?? '').trim() || !String(scope.repositories ?? '').trim()
              || !Object.entries(scope).some(([key, value]) => key.startsWith('permission-') && ['read', 'write'].includes(value))) {
              violations.push(`${label}: App token lacks explicit owner, repositories or permissions`);
            }
          }
        }
      }
      const exposed = hasSecrets({ env: workflow.env, job }) || tokenExposure({ env: workflow.env, job }) || job.secrets === 'inherit';
      const candidateReadToken = isCandidateJob(file, workflow, id, job) && readOnly(permissions) && onlyBuiltinToken(workflow, job);
      if (rule === 'actor-admission' && exposed && !allowed && !candidateReadToken
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

test('publisher action recursion rejects local action paths outside the repository', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'publisher-action-escape-'));
  const repositoryRoot = join(workspace, 'repo');
  const outsideActionDir = join(workspace, 'outside');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(outsideActionDir, { recursive: true });
  await writeFile(join(outsideActionDir, 'action.yml'), YAML.stringify({
    runs: { using: 'composite', steps: [] },
  }));
  await symlink(
    outsideActionDir,
    join(repositoryRoot, 'linked-action'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  try {
    await assert.rejects(
      collectPublisherExternalActionUses({
        jobs: { publish: { steps: [{ uses: './../outside' }] } },
      }, { repositoryRoot }),
      /outside the repository/,
    );
    await assert.rejects(
      collectPublisherExternalActionUses({
        jobs: { publish: { steps: [{ uses: './linked-action' }] } },
      }, { repositoryRoot }),
      /outside the repository/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('publisher action recursion visits aliased local-action cycles once', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'publisher-action-cycle-'));
  await mkdir(join(repositoryRoot, 'actions', 'a'), { recursive: true });
  await mkdir(join(repositoryRoot, 'actions', 'b'), { recursive: true });
  await writeFile(join(repositoryRoot, 'actions', 'a', 'action.yml'), YAML.stringify({
    runs: {
      using: 'composite',
      steps: [
        { uses: 'example/a@1111111111111111111111111111111111111111' },
        { uses: './actions/b' },
      ],
    },
  }));
  await writeFile(join(repositoryRoot, 'actions', 'b', 'action.yml'), YAML.stringify({
    runs: {
      using: 'composite',
      steps: [
        { uses: 'example/b@2222222222222222222222222222222222222222' },
        { uses: './actions/../actions/a' },
      ],
    },
  }));

  try {
    const externalUses = await collectPublisherExternalActionUses({
      jobs: { publish: { steps: [{ uses: './actions/a' }] } },
    }, { repositoryRoot });
    assert.deepEqual(externalUses.sort(), [
      'example/a@1111111111111111111111111111111111111111',
      'example/b@2222222222222222222222222222222222222222',
    ]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

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

test('workflow security W3: mobile release messages enter shells as data', async () => {
  assert.deepEqual(await securityViolations(new Map([
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

test('workflow security W4: mobile and provider inputs enter shells as data', async () => {
  for (const file of ['build-ui-mobile-local.yml', 'tests.yml']) {
    assert.deepEqual(await securityViolations(new Map([[file, workflows.get(file)]]), 'shell-inputs'), []);
  }
});

test('workflow security W4: install action inputs enter shells as data', async () => {
  const action = YAML.parse(await readFile(new URL('../../.github/actions/install-pnpm-dependencies/action.yml', import.meta.url), 'utf8'));
  assert.deepEqual(await securityViolations(new Map([['install-action', { jobs: { install: { steps: action.runs.steps } } }]]), 'shell-inputs'), []);
});

test('workflow security W4: label bootstrap boolean enters JavaScript as data', async () => {
  const job = workflows.get('roadmap-bootstrap-labels.yml').jobs.bootstrap;
  const scriptSteps = job.steps.filter((step) => actionName(step.uses) === 'actions/github-script')
    .map((step) => ({ run: step.with.script }));
  assert.deepEqual(await securityViolations(new Map([['label-bootstrap', { jobs: { bootstrap: { steps: scriptSteps } } }]]), 'shell-inputs'), []);
});

test('workflow security W4: the real install shell forwards flags without executing input commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-install-args-'));
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/pnpm'), '#!/bin/sh\nprintf "%s\\0" "$@" > "$ARGV_PATH"\n', { mode: 0o755 });
    const action = YAML.parse(await readFile(new URL('../../.github/actions/install-pnpm-dependencies/action.yml', import.meta.url), 'utf8'));
    const step = action.runs.steps.find((entry) => entry.env?.PNPM_INSTALL_ARGS);
    const sentinel = join(root, 'executed');
    for (const args of ['--frozen-lockfile --ignore-scripts', '--frozen-lockfile $(touch "$SIDE_EFFECT")']) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: root, encoding: 'utf8', env: {
          ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          PNPM_INSTALL_ARGS: args, HAPPIER_INSTALL_CROSS_TARGET_OPTIONALS: 'false',
          ARGV_PATH: join(root, 'argv'), SIDE_EFFECT: sentinel,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const actual = (await readFile(join(root, 'argv'), 'utf8')).split('\0').slice(0, -1);
      assert.deepEqual(actual, ['install', ...args.split(' '), '--prod=false', '--prefer-offline']);
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test('workflow security W5: maintainer installs cannot inherit an App token', async () => {
  for (const file of ['issue-triage.yml', 'issue-triage-manual.yml']) {
    const workflow = workflows.get(file);
    assert.deepEqual(await securityViolations(new Map([[file, workflow]]), 'app-token-scope'), []);
    const token = Object.values(workflow.jobs)[0].steps.find((step) => actionName(step.uses) === 'actions/create-github-app-token');
    assert.equal(token.with['permission-contents'], 'read');
    for (const job of Object.values(workflow.jobs)) {
      const checkout = job.steps.find((step) => actionName(step.uses) === 'actions/checkout'
        && step.with?.repository === 'happier-dev/maintainers-tools');
      assert.equal(checkout?.with?.['persist-credentials'], false);
    }
  }
});

test('workflow security W6: roadmap App token has exact organization and project permissions', () => {
  const job = workflows.get('roadmap-add-to-project.yml').jobs['add-to-project'];
  const scope = job.steps.find((step) => actionName(step.uses) === 'actions/create-github-app-token').with;
  assert.equal(scope.owner, 'happier-dev');
  assert.equal(scope.repositories, '${{ github.event.repository.name }}');
  assert.deepEqual(Object.fromEntries(Object.entries(scope).filter(([key]) => key.startsWith('permission-'))), {
    'permission-issues': 'read', 'permission-organization-projects': 'write',
  });
});

test('workflow security W7: mobile credential validation requires actor admission and inert secret data', () => {
  const jobs = workflows.get('build-ui-mobile-local.yml').jobs;
  for (const id of ['validate_expo_token', 'validate_apple_api_private_key']) {
    assert.ok(guardedByActor(jobs, id), id);
    for (const step of jobs[id].steps) assert.doesNotMatch(String(step.run ?? ''), secretReference);
  }
});

test('workflow security W7: the real validation shells accept quoted credentials and refuse missing credentials', () => {
  const jobs = workflows.get('build-ui-mobile-local.yml').jobs;
  for (const [id, key] of [['validate_expo_token', 'EXPO_TOKEN'], ['validate_apple_api_private_key', 'APPLE_API_PRIVATE_KEY']]) {
    const step = jobs[id].steps[0];
    assert.ok(step.env?.[key]);
    for (const value of ['', 'test-value"; $(exit 17)\nsecond-line']) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        env: { ...process.env, [key]: value }, encoding: 'utf8',
      });
      assert.equal(result.status === 0, value.length > 0, id);
    }
  }
});

test('workflow security W9: real triage admission accepts triage and maintain roles and refuses read', async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  for (const file of ['issue-triage.yml', 'issue-triage-manual.yml']) {
    const job = Object.values(workflows.get(file).jobs)[0];
    const script = job.steps[0].with.script;
    for (const [role, permission, admitted] of [
      ['maintain', 'write', true], ['triage', 'read', true], ['read', 'read', false],
    ]) {
      const failures = [];
      await new AsyncFunction('github', 'context', 'core', script)({
        rest: { repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission, role_name: role } }) } },
      }, { actor: 'collaborator', repo: { owner: 'happier-dev', repo: 'happier' } }, {
        setFailed: (message) => failures.push(message),
      });
      assert.equal(failures.length === 0, admitted, `${file}: ${role}`);
    }
  }
});

for (const rule of rules) {
  test(`workflow security: ${rule}`, async () => {
    assert.deepEqual(await securityViolations(workflows, rule), [], rule);
  });
}

function compliantFixture() {
  return new Map([['publish-cli-binaries.yml', {
    on: { workflow_call: {} },
    permissions: { contents: 'read' },
    jobs: {
      release_actor_guard: {
        permissions: { contents: 'read' },
        steps: [{
          uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
          with: { repository: '${{ job.workflow_repository }}', ref: '${{ job.workflow_sha }}', 'persist-credentials': false },
        }, { uses: './.github/actions/release-actor-guard' }],
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

test('security mutation fixtures reject each broken trust boundary and accept the legitimate publisher', async () => {
  const fixture = compliantFixture();
  for (const rule of rules) assert.deepEqual(await securityViolations(fixture, rule), [], rule);
  for (const [rule, mutate] of [
    ['candidate-isolation', (jobs) => { jobs.build_native.env = { TOKEN: '${{ secrets.X }}' }; }],
    ['candidate-isolation', (jobs) => {
      delete jobs.build_native.steps[0].with['persist-credentials'];
      jobs.build_native.steps.push({ uses: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', with: { path: '.' } });
    }],
    ['action-pins', (jobs) => { jobs.publish.steps[0].uses = 'actions/create-github-app-token@v2'; }],
    ['shell-inputs', (jobs) => { jobs.publish.steps[1].run = 'publish "${{ inputs.release_message }}"'; }],
    ['app-token-scope', (jobs) => { delete jobs.publish.steps[0].with.repositories; }],
    ['app-token-scope', (jobs) => { delete jobs.publish.steps[0].with['permission-contents']; }],
    ['actor-admission', (jobs) => { delete jobs.release_actor_guard; }],
    ['actor-admission', (jobs) => { jobs.publish.if = '${{ always() }}'; }],
    ['actor-admission', (jobs) => { jobs.release_actor_guard.steps.at(-1)['continue-on-error'] = true; }],
    ['actor-admission', (jobs) => {
      jobs.release_actor_guard.steps.unshift({ env: { TOKEN: '${{ secrets.X }}' }, run: 'publish' });
    }],
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed.get('publish-cli-binaries.yml').jobs);
    assert.ok((await securityViolations(changed, rule)).length > 0, `undetected ${rule} mutation`);
  }
});

test('reviewed security mutations distinguish the added trust boundaries', async (t) => {
  const cases = [
    ['PR token defaults', 'candidate-isolation', (workflow) => { workflow.on = 'pull_request'; delete workflow.permissions; }],
    ['pwn-request head checkout', 'trusted-control', (workflow) => {
      workflow.on = ['pull_request_target'];
      workflow.jobs.publish.steps.push({ uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', with: { ref: '${{ github.event.pull_request.head.sha }}' } });
    }],
    ['secret in shell source', 'shell-inputs', (workflow) => { workflow.jobs.publish.steps[1].run = 'publish "${{ secrets.X }}"'; }],
    ['head_ref in shell source', 'shell-inputs', (workflow) => { workflow.jobs.publish.steps[1].run = 'publish "${{ github.head_ref }}"'; }],
    ['event in github-script source', 'shell-inputs', (workflow) => {
      workflow.jobs.publish.steps.push({ uses: 'actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b', with: { script: 'core.info("${{ github.event.issue.title }}")' } });
    }],
    ['built-in write token without admission', 'actor-admission', (workflow) => {
      delete workflow.jobs.release_actor_guard;
      workflow.jobs.publish.steps.shift();
      workflow.jobs.publish.env = { GITHUB_TOKEN: '${{ github.token }}' };
    }],
    ['wrong guard team', 'actor-admission', (workflow) => { workflow.jobs.release_actor_guard.steps.at(-1).with = { team_slug: 'everyone' }; }],
    ['wrong guard checkout', 'actor-admission', (workflow) => { workflow.jobs.release_actor_guard.steps[0].with.ref = '${{ github.sha }}'; }],
    ['failure bypass', 'actor-admission', (workflow) => { workflow.jobs.publish.if = '${{ failure() }}'; }],
    ['success disjunction bypass', 'actor-admission', (workflow) => { workflow.jobs.publish.if = '${{ success() || true }}'; }],
    ['success-result disjunction bypass', 'actor-admission', (workflow) => { workflow.jobs.publish.if = "${{ always() && (needs.build_native.result == 'success' || true) }}"; }],
  ];
  for (const [name, rule, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = compliantFixture();
      mutate(fixture.get('publish-cli-binaries.yml'));
      assert.ok((await securityViolations(fixture, rule)).length > 0, `undetected ${name}`);
    });
  }
  await t.test('best-effort dependent retains a valid actor boundary', async () => {
    const fixture = compliantFixture();
    fixture.get('publish-cli-binaries.yml').jobs.publish['continue-on-error'] = true;
    assert.deepEqual(await securityViolations(fixture, 'actor-admission'), []);
  });
  await t.test('mutable composite action is rejected recursively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-composite-pin-'));
    try {
      await mkdir(join(root, 'actions'), { recursive: true });
      await writeFile(join(root, 'actions/action.yml'), YAML.stringify({ runs: {
        using: 'composite', steps: [{ uses: 'maxim-lobanov/setup-xcode@v1' }],
      } }));
      const fixture = new Map([['composite.yml', { permissions: { contents: 'write' }, jobs: {
        publish: { steps: [{ uses: './actions' }] },
      } }]]);
      assert.ok((await securityViolations(fixture, 'action-pins', { repositoryRoot: root })).length > 0);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

test('security presentation fixtures survive step renames and YAML format round trips', async () => {
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
      const expected = await securityViolations(source, rule);
      assert.deepEqual(await securityViolations(renamed, rule), expected, `${rule}: P1 step renames`);
      assert.deepEqual(await securityViolations(roundTripped, rule), expected, `${rule}: P2 format round trip`);
    }
  }
});
