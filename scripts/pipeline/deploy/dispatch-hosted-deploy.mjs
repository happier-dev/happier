import { execFileSync } from 'node:child_process';
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
  execFileSync('gh', ['run', 'watch', String(response.workflow_run_id), '--repo', repository, '--exit-status'], { stdio: 'inherit' });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
