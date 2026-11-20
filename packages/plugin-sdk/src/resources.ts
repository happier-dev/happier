import { PluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from './errors.js';
import type { JsonValue, PluginContributionRef } from './identity.js';
import type { PluginDynamicResourceRuntime } from './services/resources.js';

/** @moduleRealm any */
export type { InputTypeOptionsQueryV1 } from './actions/dtos/pluginActionDtoSupport.generated.js';

/** @realm any */
export type {
    PluginPromptAssetContributionV1 as PromptAssetContribution,
    PluginResourceKind,
    PluginResourceContributionV2 as ResourceContribution,
} from '@happier-dev/protocol';

export type {
    PluginDynamicResourceRuntime,
    PluginDynamicResourceInvocationOptionsV1,
    PluginResourceContextV1,
    PluginResourceDescriptor as ResourceDescriptor,
    ResourcesService,
} from './services/resources.js';

/** Read finite deployment options through the Resource's admitted read-only Action binding. */
export function createDeploymentTargetOptionsResource(
    action: PluginContributionRef,
    phase: string,
    projectDraft: (draft: Readonly<Record<string, JsonValue>>) => Readonly<Record<string, JsonValue>>,
): PluginDynamicResourceRuntime {
    return {
        async read({ query, signal, readAction }) {
            signal.throwIfAborted();
            const draft = query?.draftInput;
            if (!query?.fieldPath || !draft || Array.isArray(draft) || !draft.credentialRef || !draft.credentialPrincipal) {
                throw new PluginError({ code: 'invalid_parameters' });
            }
            // The host admits the partial JSON draft. The Action executor admits its selected credential.
            const admitted = draft as Readonly<Record<string, JsonValue>>;
            const result = await readAction(action, {
                ...projectDraft(admitted),
                credentialRef: admitted.credentialRef,
                credentialPrincipal: admitted.credentialPrincipal,
                fieldPath: query.fieldPath,
                ...(query.query === undefined ? {} : { query: query.query }),
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            }, { signal });
            if (!result.ok) {
                const code = 'errorCode' in result && typeof result.errorCode === 'string'
                    ? result.errorCode : 'deployment_unavailable';
                const details = 'details' in result ? result.details : undefined;
                const requiredDraftPath = details && typeof details === 'object' && 'requiredDraftPath' in details
                    ? details.requiredDraftPath : undefined;
                const error = new PluginError({ code, failureCause: projectActionFailureCauseV1(result, phase),
                    ...(code === 'missing_option_dependency' && typeof requiredDraftPath === 'string'
                        ? { details: { requiredDraftPath } } : {}) });
                throw code === 'missing_option_dependency' ? error : withActionFailureDiagnostic(error,
                    { phase, causeKind: 'native_failure', error: result });
            }
            return JSON.stringify(result.result);
        },
        observe: () => ({ dispose() {} }),
    };
}
