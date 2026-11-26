import { expect, it } from 'vitest';
import { projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { needsDaemonDeploymentActionDeps } from './deploymentActionDeps';

const target = {
  kind: 'managed_deployment',
  environment: {
    serverId: 'srv_home',
    environmentId: 'environment',
    projectSourceId: 'source',
  },
  targetLinkId: 'postgres-link',
  contribution: {
    pluginId: 'happier.deploy.railway-data',
    contributionId: 'postgresql',
  },
  platformProjectId: 'project',
  branchId: 'branch',
  database: 'railway',
};
const readAdmission = (localId: string, input: Record<string, unknown>) =>
  projectDeploymentReadAdmissionV1('action.invoke', {
    action: { pluginId: 'happier.database', localId },
    input,
  });

// #217: a browser-signed read setup root is `action.invoke`; its reviewed bindings child must reach the
// daemon deployment owner instead of the generic original-root dispatch (`deployment_executor_unavailable`).
it.each([
  [
    'Create Apply',
    readAdmission('read-access/create', {
      target,
      mode: 'apply',
      role: 'happier_ro_a',
      statements: ['CREATE ROLE "happier_ro_a"'],
    }),
    true,
  ],
  [
    'Attach',
    readAdmission('read-access/attach', {
      target,
      savedSecretRef:
        'happier:shared-secret:v1:00000000-0000-4000-8000-000000000001',
      resourceRevision: 1,
    }),
    true,
  ],
  [
    'Create Preview',
    readAdmission('read-access/create', { target, mode: 'preview' }),
    false,
  ],
  [
    'an ordinary database read',
    readAdmission('statement/run', { target, statement: 'select 1' }),
    false,
  ],
  ['an unadmitted plugin Action', undefined, false],
] as const)(
  'gives an action.invoke root the daemon deployment owner only for %s that may bind its login',
  (_name, admission, expected) => {
    expect(needsDaemonDeploymentActionDeps('action.invoke', admission)).toBe(
      expected,
    );
  },
);

it('keeps the deployment roots that already run on the daemon deployment owner', () => {
  expect(
    needsDaemonDeploymentActionDeps('deployments.bindings.set', undefined),
  ).toBe(true);
  expect(
    needsDaemonDeploymentActionDeps('machines.setup.apply', undefined),
  ).toBe(true);
  expect(needsDaemonDeploymentActionDeps('session.spawn_new', undefined)).toBe(
    false,
  );
});
