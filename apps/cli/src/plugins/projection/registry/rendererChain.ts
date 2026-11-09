export { buildPluginUiRendererContributionKey, resolvePluginUiRendererChain } from '@happier-dev/cli-common/plugins/registration';
import type { ResolvedUiRendererV2Contribution } from './types';
import type { PluginUiRendererChainResolution as PortablePluginUiRendererChainResolution } from '@happier-dev/cli-common/plugins/registration';
export type PluginUiRendererChainResolution = PortablePluginUiRendererChainResolution<ResolvedUiRendererV2Contribution>;
