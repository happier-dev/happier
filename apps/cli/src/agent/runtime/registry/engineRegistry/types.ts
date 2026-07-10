import type {
    FetchRuntimeServiceV1,
    PluginAuthMaterializedServiceV1,
    PluginAuthMaterializeRequestV1,
} from '@happier-dev/plugin-sdk';
import type { ReviewCommentActionExecutor } from '@/agent/reviews/comments/pluginApi';
import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import type { PluginDaemonConnectionStateSource } from '../pluginConnectionStateSource';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

export type PluginLocalServicesRuntimeBridgeFactory = Pick<LocalServicesDaemonRuntime, 'createPluginLocalServicesBridge'>;

export type ResolveEngineRegistryParams = Readonly<{
    happyHomeDir?: string;
    backendId?: string;
    contributes?: ResolvedContributionRegistry;
    connectionStateSource?: PluginDaemonConnectionStateSource | null;
    fetchAdapter?: FetchRuntimeServiceV1 | null;
    runtimeRegistry?: ResolvedExecutablePluginRuntimeRegistry | null;
    localServicesRuntime?: PluginLocalServicesRuntimeBridgeFactory | null;
    authMaterializeAdapter?: (request: PluginAuthMaterializeRequestV1) => Promise<PluginAuthMaterializedServiceV1 | null>;
    reviewCommentActionExecutor?: ReviewCommentActionExecutor | null;
}>;
