import type {
    HomeGovernanceProjectionV1,
    HomeHostAccessMethodV1,
    HomeReachabilityV1,
} from '@happier-dev/protocol/home/governance';

import { t } from '@/text';

/**
 * Pure decisions of the Reach page (plan `2026-09-26-home-owner-console` §3.2, lab `hcReach-*`).
 * The facts come from `home.reachability.get`, the settings entries and the governance projection;
 * nothing here decides reachability, it only chooses what the page says about it.
 */

/** Addresses read by host, never as raw origin URLs. */
export function reachAddressHost(url: string | null): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.pathname && parsed.pathname !== '/' ? `${parsed.host}${parsed.pathname}` : parsed.host;
    } catch {
        return url;
    }
}

/** Whether anyone who reaches this Home can create an account right now (the effective sign-in decision). */
export function homeAdmitsStrangers(projection: HomeGovernanceProjectionV1): boolean {
    return projection.authenticationOptions.methods.some((method) => (
        method.actions.some((action) => action.id === 'provision' && action.enabled)
    ));
}

const PUBLIC_METHODS: ReadonlySet<HomeHostAccessMethodV1> = new Set(['tailscale_funnel', 'cloudflare_tunnel']);

export type ReachExposure =
    | Readonly<{ kind: 'none' }>
    /** The hosting computer publishes this Home to the internet. */
    | Readonly<{ kind: 'internet'; method: HomeHostAccessMethodV1; strangersCanSignUp: boolean }>
    /** A public address is set while anyone who reaches it can create an account. */
    | Readonly<{ kind: 'open_address'; strangersCanSignUp: true }>;

/**
 * The exposure warning (§3.2): a method that reaches the internet (Tailscale Funnel, Cloudflare)
 * always warns, with copy that adapts to whether strangers can sign up; a public address warns only
 * while strangers can sign up, because that is the consequence the owner must see.
 */
export function resolveReachExposure(reach: HomeReachabilityV1, projection: HomeGovernanceProjectionV1): ReachExposure {
    const strangersCanSignUp = homeAdmitsStrangers(projection);
    const method = reach.hostAccess?.method;
    if (method && (reach.hostAccess?.exposure === 'public' || PUBLIC_METHODS.has(method))) {
        return { kind: 'internet', method, strangersCanSignUp };
    }
    if (reach.publicAddress.url && strangersCanSignUp) return { kind: 'open_address', strangersCanSignUp: true };
    return { kind: 'none' };
}

/** Turning direct connections off is offered only where devices keep an address to reach the Home. */
export function reachCanRetireIroh(reach: HomeReachabilityV1): boolean {
    return Boolean(reach.publicAddress.url?.startsWith('https://'));
}

/** The host-side access method by name. */
export function hostAccessMethodLabel(method: NonNullable<HomeReachabilityV1['hostAccess']>['method']): string {
    switch (method) {
        case 'local_only':
            return t('homeGovernance.reach.methodLocalOnly');
        case 'lan':
            return t('homeGovernance.reach.methodLan');
        case 'tailscale_serve':
            return t('homeGovernance.reach.methodTailscaleServe');
        case 'tailscale_funnel':
            return t('homeGovernance.reach.methodTailscaleFunnel');
        case 'cloudflare_tunnel':
            return t('homeGovernance.reach.methodCloudflare');
    }
}

/**
 * Where the effective public address comes from, in words (the Reach page and Overview). A
 * deployment-set address says so through `HomeDeploymentFixedNote` instead, so this is `undefined`.
 */
export function publicAddressCaption(reach: HomeReachabilityV1): string | undefined {
    const { publicAddress } = reach;
    switch (publicAddress.source) {
        case 'deployment':
            // Said by the row's `HomeDeploymentFixedNote`, with the key as a code chip.
            return undefined;
        case 'home':
            return t('homeGovernance.reach.publicAddressHome');
        case 'inferred':
            switch (publicAddress.inferredFrom) {
                case 'tailscale_serve':
                    return t('homeGovernance.reach.inferredFrom', { method: t('homeGovernance.reach.methodTailscaleServe') });
                case 'tailscale_funnel':
                    return t('homeGovernance.reach.inferredFrom', { method: t('homeGovernance.reach.methodTailscaleFunnel') });
                case 'relay_access':
                    return reach.hostAccess
                        ? t('homeGovernance.reach.inferredFrom', { method: hostAccessMethodLabel(reach.hostAccess.method) })
                        : t('homeGovernance.reach.inferredFromHost');
                default:
                    return t('homeGovernance.reach.inferredFromHost');
            }
        case 'none':
            return t('homeGovernance.reach.publicAddressNone');
    }
}
