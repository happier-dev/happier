import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, registryContentRefEqualV1, type RegistryAppMappingV1 } from '@happier-dev/protocol/registries';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';

/** The catalog reader owns pin verification for every template creation path. */
export async function readPinnedDeploymentTemplateForHost(templateRef: DeploymentTemplateRefV1,
    host: Parameters<typeof createCliRegistryHostV1>[0], appMappingCorrection?: RegistryAppMappingV1) {
    const registry = createCliRegistryHostV1(host);
    const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
        kind: 'app', sourceId: templateRef.sourceId, itemId: templateRef.itemId, version: templateRef.version, ...(appMappingCorrection ? { appMappingCorrection } : {}) })).item;
    if (selected.payload.kind !== 'app' || selected.payload.state !== 'ready') {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'template_needs_review', error: 'template_needs_review' });
    }
    if (!registryContentRefEqualV1(selected.payload.ref, templateRef.ref)) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'template_changed', error: 'template_changed' });
    }
    return selected.payload.app;
}
