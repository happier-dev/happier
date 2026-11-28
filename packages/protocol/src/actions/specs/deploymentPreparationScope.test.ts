import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1, DEPLOYMENT_TEARDOWN_PREVIEW_CHILD_ROLE_V1,
  readDeploymentReferenceServiceListEnvironmentIdV1, readDeploymentReviewedChildPlanV1, readDeploymentReviewedChildV1,
  selectDeploymentReviewedChildPlanV1 } from './deploymentPreparationScope.js';
import type { DeploymentPreparationAdmissionV1 } from '../../deployments/deploymentPreparationAdmissionV1.js';
import type { DeploymentReviewedChildPlanEntryV1 } from '../externalActionApi.js';
import type { DeploymentReadAdmissionV1 } from '../../deployments/deploymentReadAdmissionV1.js';
import { DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1, DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1 } from '../actionIdsDatabaseV1.js';
import * as ids from '../../deployments/deploymentActionIdsV1.js';
import { DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1 } from '../../scm/repositoryFilesPullRequestActionIds.js';
import { MACHINE_SERVICE_ADOPT_ACTION_ID, MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1,
  MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1 } from '../../local/services/actionIdsV1.js';
import { MANAGED_RETENTION_UPDATE_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { RPC_METHODS } from '../../rpc/methods.js';

const PLUGIN = formatQualifiedPluginActionId({ pluginId: 'happier.deploy-railway', localId: 'teardown-preview' });
const REF = ids.DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1;
const ENV_GET = ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, BIND = ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1;
const DEPLOY = ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1, DOMAIN = ids.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1;
const RETENTION = 'target-retention:', COPY_LINK = ids.deploymentCopyDataLinkChildRoleV1('');
const create = (shape: Record<string, unknown>) => ({ operation: 'create', mode: 'apply', ...shape }) as DeploymentPreparationAdmissionV1;
const template = (shape: Record<string, unknown>) => ({ operation: 'template', mode: 'apply', ...shape }) as DeploymentPreparationAdmissionV1;
const entry = (role: string, action: string, access: 'read' | 'write' = 'write', effect?: string) =>
  `${role} -> ${action}${effect ? ` (${effect})` : ''} ${access}`;
const show = (plan: readonly DeploymentReviewedChildPlanEntryV1[] | undefined) =>
  (plan ?? []).map(child => entry(child.role, child.action, child.access, child.effect)).sort();

const readSetup = (localId: string, databaseReadAccessMode?: 'apply' | 'preview') => ({
  deploymentReadAdmission: { actionId: 'action.invoke', action: parseQualifiedPluginActionId(localId)!, environmentId: 'environment',
    targetLinkId: 'database', databaseTarget: { kind: 'managed_deployment' },
    ...(databaseReadAccessMode ? { databaseReadAccessMode } : {}) } as unknown as DeploymentReadAdmissionV1 });
const READ_LOGIN = entry(ids.DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1, BIND);
type RootShape = Readonly<{ deploymentPreparationAdmission?: DeploymentPreparationAdmissionV1; deploymentReadAdmission?: DeploymentReadAdmissionV1 }>;
const prep = (admission: DeploymentPreparationAdmissionV1): RootShape => ({ deploymentPreparationAdmission: admission });
// Each root kind the owner approved, with the children it was reviewed with.
const rootKinds: readonly [string, string, RootShape, readonly string[]][] = [
  ['Deploy', DEPLOY, {}, [entry(REF, ENV_GET, 'read'), entry(REF, ENV_GET, 'read', RPC_METHODS.MACHINES_SERVICE_LIST)]],
  ['Rollback', ids.DEPLOYMENT_ROLLBACK_ACTION_ID_V1, {}, [entry(REF, ENV_GET, 'read')]],
  ['Promote', ids.DEPLOYMENT_PROMOTE_ACTION_ID_V1, {}, [entry(REF, ENV_GET, 'read')]],
  ['Restore', ids.DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, {}, []],
  ['Duplicate', ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, prep(create({ copyFrom: {} })),
    [entry('backup.bindings', BIND), entry(COPY_LINK, ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1),
      entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1)]],
  ['Create from catalog', ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, prep(create({ catalogApp: { kind: 'content', digest: 'sha256:x' } })),
    [entry('backup.bindings', BIND), entry('template.deploy', DEPLOY), entry('template.domain:', DOMAIN),
      entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1), entry(REF, ENV_GET, 'read')]],
  ['Create preview', ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, prep(create({ preview: {} })),
    [entry('preview.backup', ids.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1), entry('backup.bindings', BIND),
      entry('preview.bindings', BIND), entry('preview.deploy', DEPLOY), entry('template.domain:preview', DOMAIN),
      entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1), entry(REF, ENV_GET, 'read')]],
  ['Create empty', ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, prep(create({})), [entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1)]],
  ['Move', ids.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, {},
    [entry(DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1, ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1)]],
  ['Teardown', ids.DEPLOYMENT_TEARDOWN_ACTION_ID_V1, {},
    [entry(DEPLOYMENT_TEARDOWN_PREVIEW_CHILD_ROLE_V1, 'plugin', 'read'), entry(DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1, 'plugin', 'read')]],
  ['Template with deploy', ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, prep(template({ deploy: { requestKey: 'k' } })),
    [entry('template.deploy', DEPLOY), entry('template.domain:', DOMAIN), entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1),
      entry(REF, ENV_GET, 'read')]],
  ['Template without deploy', ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, prep(template({})), [entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1)]],
  ['Setup backup', ids.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, {}, [entry('backup.bindings', BIND)]],
  ['Setup telemetry', ids.DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, {}, [entry(ids.DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1, BIND)]],
  ['Setup preview', ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, {}, [entry('preview.setup', 'plugin', 'read')]],
  ['Setup Link', ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, {},
    [entry(ids.PLATFORM_FAILURE_SETUP_ROLE, 'plugin', 'read'), entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1)]],
  ['Adopt', MACHINE_SERVICE_ADOPT_ACTION_ID, {}, [entry(MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1, ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1),
    entry(MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1, BIND), entry(RETENTION, MANAGED_RETENTION_UPDATE_ACTION_ID_V1)]],
  ['Prepare', ids.DEPLOYMENT_PREPARE_ACTION_ID_V1, prep({ operation: 'prepare' } as DeploymentPreparationAdmissionV1),
    [entry(ids.DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1, 'session.spawn_new', 'read'),
      entry(ids.DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1, 'session.message.send', 'read')]],
  ['Plugin Action', 'action.invoke', {}, []],
  ['Database read access attach', 'action.invoke', readSetup(DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1), [READ_LOGIN]],
  ['Database read access create (apply)', 'action.invoke', readSetup(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1, 'apply'), [READ_LOGIN]],
  ['Database read access create (preview)', 'action.invoke', readSetup(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1, 'preview'), []],
];

/** A child presenting a declared row: family roles carry an operand. */
const childFor = (row: Pick<DeploymentReviewedChildPlanEntryV1, 'role' | 'action' | 'effect'>) => ({
  child: { actionId: row.action === 'plugin' ? PLUGIN : row.action, role: row.role.endsWith(':') ? `${row.role}operand` : row.role },
  effect: row.effect ?? (row.action === 'plugin' ? PLUGIN : row.action),
});

describe('deployment reviewed child plan bound at mint', () => {
  it.each(rootKinds)('%s binds exactly its declared children and admits only those', (_kind, root, shape, expected) => {
    const plan = selectDeploymentReviewedChildPlanV1({ actionId: root, ...shape });
    expect(show(plan)).toEqual([...expected].sort());
    const signed = { deploymentReviewedChildPlan: plan };
    // A bound entry names one exact role, or a role family whose operand the child carries.
    const named = (role: string, action: string, effect: string | undefined) => (plan ?? []).some(bound =>
      bound.action === action && bound.effect === effect
      && (bound.role === role || bound.role.endsWith(':') && role.startsWith(bound.role) && role.length > bound.role.length));
    // Every child the whole table declares, under any root, is admitted here only when this root's plan names it.
    for (const row of readDeploymentReviewedChildPlanV1()) {
      const { child, effect } = childFor(row);
      const admitted = readDeploymentReviewedChildV1(signed, child, effect);
      expect(admitted !== undefined, `${root}: ${entry(row.role, row.action, row.access, row.effect)}`)
        .toBe(named(child.role, row.action, row.effect));
    }
  });

  it('admits nothing for a root without a bound plan, whatever its Action id claims', () => {
    for (const row of readDeploymentReviewedChildPlanV1()) {
      const { child, effect } = childFor(row);
      expect(readDeploymentReviewedChildV1({}, child, effect)).toBeUndefined();
      expect(readDeploymentReviewedChildV1({ actionId: row.root } as never, child, effect)).toBeUndefined();
    }
    expect(readDeploymentReferenceServiceListEnvironmentIdV1(undefined, RPC_METHODS.MACHINES_SERVICE_LIST,
      { actionId: ENV_GET, role: REF, environmentId: 'reference' })).toBeUndefined();
  });

  it('keeps each entry exact: role family operand, effect and read access come from the bound entry', () => {
    const signed = { deploymentReviewedChildPlan: selectDeploymentReviewedChildPlanV1({ actionId: DEPLOY }) };
    expect(readDeploymentReferenceServiceListEnvironmentIdV1(signed, RPC_METHODS.MACHINES_SERVICE_LIST,
      { actionId: ENV_GET, role: REF, environmentId: 'reference' })).toBe('reference');
    expect(readDeploymentReviewedChildV1(signed, { actionId: ENV_GET, role: REF }, ENV_GET, { method: 'GET' })).toBeDefined();
    expect(readDeploymentReviewedChildV1(signed, { actionId: ENV_GET, role: REF }, ENV_GET, { method: 'POST', body: {} })).toBeUndefined();
    expect(readDeploymentReviewedChildV1(signed, { actionId: ENV_GET, role: REF }, ENV_GET, { method: 'GET', body: {} })).toBeUndefined();
    const catalog = { deploymentReviewedChildPlan: selectDeploymentReviewedChildPlanV1({ actionId: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1,
      deploymentPreparationAdmission: create({ catalogApp: { kind: 'content', digest: 'sha256:x' } }) }) };
    expect(readDeploymentReviewedChildV1(catalog, { actionId: DOMAIN, role: 'template.domain:web' }, DOMAIN)?.roleOperand).toBe('web');
    expect(readDeploymentReviewedChildV1(catalog, { actionId: DOMAIN, role: 'template.domain:' }, DOMAIN)).toBeUndefined();
    expect(readDeploymentReviewedChildV1(catalog, { actionId: DEPLOY, role: 'template.domain:web' }, DEPLOY)).toBeUndefined();
  });
});
