import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, registryContentRefEqualV1, type RegistryAppMappingV1 } from '@happier-dev/protocol/registries';
import { REGISTRY_ITEMS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/registries/registryActionIdsV1';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';

/** The catalog reader owns pin verification for every template creation path. */
export async function readPinnedDeploymentTemplateForHost(templateRef: DeploymentTemplateRefV1,
    host: Parameters<typeof createCliRegistryHostV1>[0], appMappingCorrection?: RegistryAppMappingV1) {
    const registry = createCliRegistryHostV1(host);
    const actionId = REGISTRY_ITEMS_READ_ACTION_ID_V1;
    const { sourceId, itemId, version } = templateRef;
    const input = { kind: 'app' as const, sourceId, itemId, version };
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await registry.execute(actionId, {
        ...input, ...(appMappingCorrection ? { appMappingCorrection } : {}),
    })).item;
    if (selected.payload.kind !== 'app') {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'template_needs_review', error: 'template_needs_review' });
    }
    if (!registryContentRefEqualV1(selected.payload.ref, templateRef.ref)) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'template_changed', error: 'template_changed' });
    }
    if (selected.payload.state === 'needs_review') {
        throw createActionExecuteFailureError({
            ok: false, errorCode: 'template_needs_review', error: 'template_needs_review',
            details: {
                diagnostics: selected.payload.diagnostics,
                requiredFact: 'The selected template has fields that need review.',
                remedy: 'Open the pinned template with registries.items.read to review the reported fields.',
                nextAction: { kind: 'action', actionId, input },
            },
        });
    }
    return selected.payload.app;
}
