import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema,
    type DeploymentPublishPrepareInputV1, type DeploymentPublishPrepareResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ActionApprovalRequestCreatedResultSchema,
    type ActionExecuteFailure, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { MountedAuthoringActionExecute } from './sessionAuthoringActions';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import type { DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

/** Select the catalog's declared generators; the template planner owns defaults and missing-value validation.
 * Generated Saved Secrets stay private to their creator, with no additional audience grants.
 */
export function buildCatalogAppTemplateBindings(template: DeploymentTemplateV1): Pick<DeploymentTemplateInstantiateInputV1,
    'bindings' | 'generatedSecretAudience'> {
    const bindings: DeploymentTemplateInstantiateInputV1['bindings'] = template.generatedSecrets.map(secret => ({
        purpose: 'variable', name: secret.key, phase: 'runtime', source: { kind: 'generated', key: secret.key },
    }));
    return { bindings, ...(bindings.length ? { generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } } : {}) };
}

/** Store and New app enter the existing Publish owner with the unchanged pinned operand. */
export async function prepareCatalogAppPublish(input: DeploymentPublishPrepareInputV1,
    lifetime: ServerAccountScopeLifetime, executeAction: MountedAuthoringActionExecute,
    signal?: AbortSignal): Promise<DeploymentPublishPrepareResultV1 | ActionApprovalRequestCreatedResult | ActionExecuteFailure> {
    const stale = (): ActionExecuteFailure => ({ ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    if (!lifetime.isCurrent()) return stale();
    const result = await executeAction('deployments.publish.prepare', DeploymentPublishPrepareInputV1Schema.parse(input), { signal });
    if (!lifetime.isCurrent()) return stale();
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success && approval.data.actionId === DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1) return approval.data;
    const parsed = DeploymentPublishPrepareResultV1Schema.safeParse(result.result);
    return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}
