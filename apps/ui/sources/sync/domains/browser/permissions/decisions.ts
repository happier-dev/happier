import type {
    BrowserPermissionGrantV1,
    BrowserPermissionKindV1,
    BrowserPermissionStateV1,
} from '@happier-dev/protocol';

export type BrowserResolvedPermissionDecision = Readonly<{
    state: BrowserPermissionStateV1;
    source: 'grant' | 'default';
    grantId?: string;
}>;

type ResolveBrowserPermissionDecisionInput = Readonly<{
    grants: readonly BrowserPermissionGrantV1[];
    profileId: string;
    origin: string | null | undefined;
    permission: BrowserPermissionKindV1;
    browserSessionId?: string | null;
    targetId?: string | null;
    now: number;
}>;

function isGrantExpired(grant: BrowserPermissionGrantV1, now: number): boolean {
    return typeof grant.expiresAt === 'number' && grant.expiresAt <= now;
}

function grantMatchesScope(grant: BrowserPermissionGrantV1, input: ResolveBrowserPermissionDecisionInput): boolean {
    if (grant.profileId && grant.profileId !== input.profileId) return false;
    if (grant.scope === 'profile') return grant.profileId === input.profileId;
    if (grant.scope === 'target') return Boolean(input.targetId && grant.targetId === input.targetId);
    if (grant.scope === 'session') {
        return Boolean(input.browserSessionId && grant.browserSessionId === input.browserSessionId);
    }
    return true;
}

function grantSpecificity(grant: BrowserPermissionGrantV1): number {
    if (grant.scope === 'target') return 3;
    if (grant.scope === 'session') return 2;
    return 1;
}

export function resolveBrowserPermissionDecision(
    input: ResolveBrowserPermissionDecisionInput,
): BrowserResolvedPermissionDecision {
    let bestGrant: BrowserPermissionGrantV1 | null = null;
    for (const grant of input.grants) {
        if (grant.permission !== input.permission) continue;
        if (grant.origin !== input.origin) continue;
        if (isGrantExpired(grant, input.now)) continue;
        if (!grantMatchesScope(grant, input)) continue;
        if (!bestGrant || grantSpecificity(grant) > grantSpecificity(bestGrant)) {
            bestGrant = grant;
        }
    }
    if (bestGrant) {
        return {
            state: bestGrant.state,
            source: 'grant',
            grantId: bestGrant.id,
        };
    }
    return {
        state: 'prompt',
        source: 'default',
    };
}
