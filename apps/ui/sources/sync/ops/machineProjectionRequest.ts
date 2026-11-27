import { DaemonContributionRegistryProjectionDescribeRequestSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolveNativeReactNativeHostRuntimeIdentity } from '@/components/plugins/reactNative/hostRuntimeIdentity';
import { resolveHostedWebFrameCapability } from '@/components/plugins/hostedWeb/hostedWebFrameCapability';
import { getPreferredLanguage } from '@/text';

type DescribeRequest = ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>;
type DiscoveryRequest = Extract<DescribeRequest, { deferredSections?: true }>;
export type ProjectionDescribeSelection = Readonly<{ selection?: 'agents' | 'connectedAccountAdmission' }>
    | (Readonly<{ selection: 'machineRecipes' }> & Pick<DiscoveryRequest, 'recipeRefs'>)
    | Readonly<{
        selection: 'mountedActions';
        callers: Extract<DescribeRequest, { selection: 'mountedActions' }>['callers'];
        actions: Extract<DescribeRequest, { selection: 'mountedActions' }>['actions'];
    }>;

export async function readProjectionClientContext(machineId: string, locale: string = getPreferredLanguage()) {
    const reactNativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
    const hostedWebFrameCapability = await resolveHostedWebFrameCapability();
    return {
        machineId,
        // Every projection read narrows plugin translation bundles to what this
        // client renders: its preferred locale merged over English. Capture it
        // before asynchronous platform probing so the request and its cache
        // qualification refer to the same locale, including remote settings updates.
        locale,
        ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
        ...(hostedWebFrameCapability ? { hostedWebFrameCapability } : {}),
    };
}

export async function buildProjectionDescribeRequest(machineId: string, opts?: Readonly<{
    locale?: string;
    knownProjection?: Readonly<{ projectionDigest: string }>;
}> & ProjectionDescribeSelection): Promise<DescribeRequest> {
    return DaemonContributionRegistryProjectionDescribeRequestSchema.parse(
        opts?.selection === 'machineRecipes'
            ? { machineId, selection: 'machineRecipes',
                ...(opts.recipeRefs === undefined ? {} : { recipeRefs: opts.recipeRefs }) }
            : opts?.selection === 'agents' || opts?.selection === 'connectedAccountAdmission'
                ? { machineId, selection: opts.selection }
            : opts?.selection === 'mountedActions'
                ? { machineId, selection: opts.selection, locale: opts.locale ?? getPreferredLanguage(), callers: opts.callers, actions: opts.actions }
                : { ...await readProjectionClientContext(machineId, opts?.locale),
                    deferredSections: true as const,
                    sectionBindingOverlay: true as const,
                    supportedEventObservationBindingVersions: [1],
                    ...(opts?.knownProjection ? { knownProjectionDigest: opts.knownProjection.projectionDigest } : {}) },
    );
}
