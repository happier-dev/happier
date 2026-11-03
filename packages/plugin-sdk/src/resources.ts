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
