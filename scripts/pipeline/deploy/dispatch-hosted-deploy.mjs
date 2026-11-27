import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// Keep credentials in deploy.yml's protected environment, admitted on its deploy ref.
// GitHub REST 2022-11-28 supports return_run_details (2026-11-17):
// https://docs.github.com/en/rest/actions/workflows?apiVersion=2022-11-28#create-a-workflow-dispatch-event
const { values } = parseArgs({ options: { images: { type: 'string' } } });
try {
  const environment = process.env.DEPLOY_ENVIRONMENT;
  const component = process.env.DEPLOY_COMPONENT;
  const repository = process.env.GH_REPO;
  if (!['production', 'preview'].includes(environment) || !['server', 'ui'].includes(component)) {
    throw new Error('Hosted deploy requires a production/preview environment and server/ui component');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('GH_REPO must name the deployment repository');
  // Treat the publisher output as data. deploy-hosted-images.mjs owns image validation.
  const input = JSON.stringify({
    ref: `deploy/${environment}/${component}`,
    return_run_details: true,
    inputs: { environment, component, confirm: `deploy ${environment} ${component}`, hosted_images: values.images ?? '{}' },
  });
  const response = JSON.parse(execFileSync('gh', [
    'api', '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2022-11-28',
    `repos/${repository}/actions/workflows/deploy.yml/dispatches`, '--input', '-',
  ], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }));
  if (!Number.isSafeInteger(response.workflow_run_id) || response.workflow_run_id <= 0) {
    throw new Error('Deploy dispatch did not return a workflow run ID');
  }
  console.log(`Waiting for hosted deployment: https://github.com/${repository}/actions/runs/${response.workflow_run_id}`);
  const runPath = `repos/${repository}/actions/runs/${response.workflow_run_id}`;
  // The run record decides the outcome. GitHub can answer 404 right after dispatch (release run 45662976860)
  // and 5xx mid-deploy (release run 45915649737: gh run watch exited on HTTP 500 while the deploy succeeded),
  // so those answers are waited out; any other lookup error fails, and the calling job's timeout bounds the wait.
  const readRun = () => {
    for (;;) {
      try {
        return JSON.parse(execFileSync('gh', ['api', runPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (error) {
        if (!/HTTP (404|5\d\d)|Not Found/.test(String(error.stderr ?? ''))) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
      }
    }
  };
  for (let run = readRun(); ; run = readRun()) {
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`Hosted deployment ended ${run.conclusion}`);
      break;
    }
    // gh run watch only blocks until the run settles; its exit code is not the verdict.
    spawnSync('gh', ['run', 'watch', String(response.workflow_run_id), '--repo', repository], { stdio: 'inherit' });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
