import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

import { withoutV03GateSkip } from './testsWorkflowTestkit.mjs';

const root = new URL('../../', import.meta.url);
const load = (path) => YAML.parse(readFileSync(new URL(path, root), 'utf8'));
const tests = load('.github/workflows/tests.yml');
const contracts = load('.github/workflows/providers-contracts.yml');
const dispatch = load('.github/workflows/tests-dispatch.yml');
const actorAction = './.github/actions/release-actor-guard';
const dependencies = (job) => job.needs === undefined ? [] : [job.needs].flat();

function ancestors(workflow, jobId, seen = new Set()) {
  for (const dependency of dependencies(workflow.jobs[jobId])) {
    assert.ok(workflow.jobs[dependency], `missing dependency ${dependency}`);
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    ancestors(workflow, dependency, seen);
  }
  return [...seen].map((id) => workflow.jobs[id]);
}

function actorCount(jobs) {
  return jobs.flatMap((job) => job.steps ?? []).filter((step) => step.uses === actorAction).length;
}

test('provider wrapper, manual Tests dispatch, and direct reusable calls each admit the actor once', () => {
  const innerCount = actorCount(ancestors(tests, 'providers'));
  for (const [workflow, callId] of [[contracts, 'providers'], [dispatch, 'tests']]) {
    assert.equal(workflow.jobs[callId].uses, './.github/workflows/tests.yml');
    assert.equal(workflow.jobs[callId].with.select_jobs_explicitly, true);
    assert.equal(actorCount(ancestors(workflow, callId)) + innerCount, 1, `${callId} actor admissions`);
  }
  assert.ok(dependencies(contracts.jobs.providers).includes('trusted_ref_guard'));
  assert.equal(contracts.jobs.providers.with.run_providers, true);
  assert.equal(dispatch.jobs.tests.with.run_providers, "${{ needs.resolve.outputs.run_providers == 'true' }}");
  assert.equal(innerCount, 1, 'direct reusable actor admissions');
});

test('provider environment waits for successful canonical actor admission with matching selection', () => {
  const guard = tests.jobs.release_actor_guard;
  const providers = tests.jobs.providers;
  assert.equal(providers.environment, 'providers-ci');
  assert.ok(ancestors(tests, 'providers').includes(guard));
  assert.equal(providers.if, guard.if);
  assert.equal(withoutV03GateSkip(guard.if), '${{ inputs.select_jobs_explicitly && inputs.run_providers }}');
  assert.equal(guard.environment, undefined);
  assert.doesNotMatch(JSON.stringify(guard), /secrets\.(?:OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY)/);
  const checkout = guard.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.repository, '${{ job.workflow_repository }}');
  assert.equal(checkout.with.ref, '${{ job.workflow_sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(guard.steps.indexOf(checkout) < guard.steps.findIndex((step) => step.uses === actorAction));
});

test('canonical actor guard cannot be neutralized by conditions, error handling, or identity overrides', () => {
  const guard = tests.jobs.release_actor_guard;
  assert.equal(withoutV03GateSkip(guard.if), '${{ inputs.select_jobs_explicitly && inputs.run_providers }}');
  assert.equal(guard['continue-on-error'], undefined);
  assert.equal(tests.jobs.providers['continue-on-error'], undefined);
  const authorize = guard.steps.find((step) => step.uses === actorAction);
  assert.ok(authorize, 'canonical actor action must exist');
  assert.equal(authorize.if, undefined);
  assert.equal(authorize['continue-on-error'], undefined);
  assert.deepEqual(authorize.with, {
    team_slug: 'release-admins',
    app_id: '${{ secrets.RELEASE_BOT_APP_ID }}',
    private_key: '${{ secrets.RELEASE_BOT_PRIVATE_KEY }}',
  });
});

test('every provider secret consumer requires successful canonical actor admission', () => {
  const guard = tests.jobs.release_actor_guard;
  assert.ok(guard, 'canonical guard must exist');
  for (const [id, job] of Object.entries(tests.jobs)) {
    const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name;
    if (environment !== 'providers-ci' && !/secrets\.(?:OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY)/u.test(JSON.stringify(job))) continue;
    assert.ok(ancestors(tests, id).includes(guard), `${id} must require actor admission`);
    assert.equal(job.if, guard.if, `${id} must share the actor selection and implicit success condition`);
    assert.equal(job['continue-on-error'], undefined, `${id} must propagate failure`);
  }
});

test('pool-mapped jobs consume neither environments nor secrets', () => {
  const mappedJobs = Object.entries(tests.jobs).filter(([, job]) =>
    /needs\.trusted_ref_guard\.outputs\./u.test(JSON.stringify([job['runs-on'], job.strategy?.matrix])),
  );
  assert.ok(mappedJobs.length > 0, 'pool resolver must have consumers');
  for (const [id, job] of mappedJobs) {
    assert.equal(job.environment, undefined, `${id} cannot request environment credentials`);
    assert.equal(job.secrets, undefined, `${id} cannot inherit or map secrets`);
    assert.doesNotMatch(JSON.stringify(job), /secrets\./u, `${id} cannot reference secrets`);
  }
});

test('canonical actor shell rejects a nonmember without admin rights and admits team members and repository admins', () => {
  const action = load('.github/actions/release-actor-guard/action.yml');
  const verify = action.runs.steps.find((step) => step.env?.ACTOR && step.run);
  assert.ok(verify, 'real actor-verification shell must exist');
  // Only the GitHub HTTP boundary is replaced; the production shell and jq stay real.
  const httpBoundary = `
    curl() {
      local output='' endpoint=''
      while [ "$#" -gt 0 ]; do
        case "$1" in
          -o) output="$2"; shift 2 ;;
          https://*) endpoint="$1"; shift ;;
          *) shift ;;
        esac
      done
      case "$endpoint" in
        */memberships/*)
          if [ "$CASE" = team ]; then printf '{"state":"active"}' > "$output"; printf 200;
          else printf '{}' > "$output"; printf 404; fi ;;
        */permission)
          if [ "$CASE" = admin ]; then printf '{"permission":"admin"}' > "$output";
          else printf '{"permission":"write"}' > "$output"; fi
          printf 200 ;;
        *) return 1 ;;
      esac
    }
  `;
  for (const [scenario, expected] of [['outsider', 1], ['team', 0], ['admin', 0]]) {
    const result = spawnSync('bash', ['-c', httpBoundary + verify.run], {
      encoding: 'utf8',
      env: {
        ...process.env, CASE: scenario, ACTOR: 'provider-test-actor', ORG: 'happier-dev',
        TEAM_SLUG: 'release-admins', INPUT_TRUSTED_ACTORS: '', APP_TOKEN: 'test-app-token',
        REPO: 'happier-dev/happier', REPO_TOKEN: 'test-repo-token',
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${scenario}: ${result.stderr}`);
    if (scenario === 'outsider') assert.match(result.stderr, /not authorized/);
  }
});
