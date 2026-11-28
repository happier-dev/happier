import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { fetchAccountPlan, PlanSurfaceRequestError, postBillingRefresh, postSupporterAskClose, putSupporterRing } from '@/sync/api/account/apiAccountPlan';
import { fetchSessionRetentionSummary } from '@/sync/api/session/apiRetentionSummary';
import { fetchSupportersWall } from '@/sync/api/supporters/fetchSupportersWall';
import { getAccountPlanEntry, refreshAccountPlan } from '@/sync/domains/plans/accountPlanResource';
import { applySupporterCode, openBillingManage, openPlanCheckout, openSupporterCheckout, openSupporterDiscordLink, openSupporterGitHubClaim, supportsHostedCheckout, usesAccountBilling } from '@/sync/domains/purchases/purchaseFlow';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { RPC_METHODS, type GithubStarResult } from '@happier-dev/protocol/rpc';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';
import { writeLeavingFootDismissal } from '@/sync/domains/session/retention/leavingFootDismissal';
import { storage } from '@/sync/domains/state/storage';
import { setSessionPin } from '@/sync/ops/sessionOrganization/setSessionPin';
import { HappyError } from '@/utils/errors/errors';
import { listAppIcons, setAppIcon } from '@/components/settings/appearance/appIcon/appIconChoice';
import type { AppIconEntitlement } from '@/components/settings/appearance/appIcon/appIcons';

/**
 * Action adapters for the account and purchase operations used by the Plans & Supporter page.
 */
export function createPlanActionDeps(readAccountId: () => string): Pick<ActionExecutorDeps,
    'accountPlanGet' | 'billingCheckoutOpen' | 'billingManageOpen' | 'billingRefresh' | 'supporterCodeApply' | 'supporterCreditsList' | 'supporterRingSet'
    | 'githubStar' | 'githubStarStatus' | 'supporterAskClose' | 'supporterDiscordLink' | 'supporterGithubLink'
    | 'sessionOrganizationPinSet' | 'sessionRetentionLeavingDismiss' | 'sessionRetentionLeavingList'
    | 'sessionRetentionSummaryGet' | 'sessionExport' | 'appIconList' | 'appIconSet'
> {
    async function loadCurrentPlan(): Promise<boolean> {
        const serverId = getActiveServerSnapshot().serverId;
        const accountId = readAccountId();
        const entry = getAccountPlanEntry();
        if (!entry.data && entry.status !== 'unavailable') await refreshAccountPlan();
        return getActiveServerSnapshot().serverId === serverId && readAccountId() === accountId;
    }

    /** `supporter.active` decides the six icons; a 404 plan read means this server offers no Supporter pack. */
    async function readAppIconEntitlement(): Promise<AppIconEntitlement> {
        await loadCurrentPlan();
        const entry = getAccountPlanEntry();
        return { supporterActive: entry.data?.supporter.active === true, supporterIconsOffered: entry.status !== 'unavailable' };
    }

    function guardActiveAccount(requestedServerId: string | null, signal?: AbortSignal) {
        const { serverId } = getActiveServerSnapshot();
        const accountId = readAccountId();
        const check = () => {
            signal?.throwIfAborted();
            if ((requestedServerId && requestedServerId !== serverId)
                || getActiveServerSnapshot().serverId !== serverId || readAccountId() !== accountId) {
                throw new Error('server_unavailable');
            }
        };
        check();
        return check;
    }

    async function invokeGithubStar(method: string, target: { machineId: string; serverId: string | null }): Promise<GithubStarResult> {
        const scope = getActiveServerAccountScope();
        if (!scope || (target.serverId && scope.serverId !== target.serverId)) return { status: 'unknown' };
        return await machineRpcWithServerScope<GithubStarResult, Record<string, never>>({
            ...scope, machineId: target.machineId, method, payload: {},
            onIssued: () => {
                if (!areServerAccountScopesEqual(scope, getActiveServerAccountScope())) throw new Error('The account changed before the GitHub request');
            },
        });
    }

    return {
        githubStarStatus: (target) => invokeGithubStar(RPC_METHODS.GITHUB_STAR_STATUS, target),
        githubStar: (target) => invokeGithubStar(RPC_METHODS.GITHUB_STAR, target),
        supporterAskClose: postSupporterAskClose,
        supporterDiscordLink: () => openSupporterDiscordLink(readAccountId()),
        supporterGithubLink: () => openSupporterGitHubClaim(readAccountId()),
        accountPlanGet: async ({ signal }) => {
            const result = await fetchAccountPlan(signal);
            return result.kind === 'ok' ? result.plan : { ok: false, errorCode: 'plans_unavailable' };
        },
        billingCheckoutOpen: async ({ offerId, interval, amountMinor }) => {
            if (!supportsHostedCheckout() || !await loadCurrentPlan()) return 'unavailable';
            const offers = getAccountPlanEntry().data?.offers;
            const accountId = readAccountId();
            if (!offers || !accountId) return 'unavailable';
            if (offerId === 'supporter') {
                if (!offers.supporter || interval === 'year') return 'unavailable';
                return openSupporterCheckout({
                    offer: offers.supporter,
                    interval: interval === 'month' ? 'monthly' : 'once',
                    accountId,
                    amountMinor,
                });
            }
            const plan = offers.plans.find((candidate) => candidate.id === offerId);
            if (!plan || interval === 'once' || amountMinor !== undefined) return 'unavailable';
            return openPlanCheckout({ plan, interval, accountId });
        },
        billingManageOpen: async () => {
            if (!supportsHostedCheckout() || !await loadCurrentPlan()) return false;
            return openBillingManage(getAccountPlanEntry().data?.offers?.portalUrl ?? null);
        },
        // Account billing only: elsewhere Check again settles through the app's own supporter lookup.
        billingRefresh: async () => {
            if (!await loadCurrentPlan()) return { ok: false, errorCode: 'plans_unavailable' };
            if (!usesAccountBilling()) {
                return { ok: false, errorCode: 'billing_refresh_cloud_only' };
            }
            await postBillingRefresh();
            return { ok: true };
        },
        supporterCodeApply: async ({ code }) => {
            if (!supportsHostedCheckout()) return 'invalid';
            if (!await loadCurrentPlan()) return 'failed';
            if (usesAccountBilling()) return 'invalid';
            return applySupporterCode(code);
        },
        supporterCreditsList: ({ signal }) => fetchSupportersWall(signal),
        appIconList: async () => listAppIcons(await readAppIconEntitlement()),
        appIconSet: async ({ iconId }) => setAppIcon(iconId, await readAppIconEntitlement()),
        supporterRingSet: async ({ visible }) => {
            try {
                return { visible: await putSupporterRing(visible) };
            } catch (error) {
                if (error instanceof PlanSurfaceRequestError && error.status === 409 && error.code === 'not_a_supporter') {
                    return { ok: false, errorCode: 'not_a_supporter' };
                }
                throw error;
            }
        },
        sessionOrganizationPinSet: async ({ serverId, sessionId, pinned }) => {
            const resolved = await resolveSessionOrganizationMutationScope(serverId ?? getActiveServerSnapshot().serverId);
            if (!resolved.ok) return { ok: false, errorCode: 'server_unavailable' };
            try {
                await setSessionPin({ ...resolved.scope, sessionId, pinned });
                return { ok: true };
            } catch (error) {
                if (error instanceof HappyError && error.code === 'session-pin-limit-exceeded') {
                    return { ok: false, errorCode: error.code };
                }
                throw error;
            }
        },
        sessionRetentionLeavingDismiss: async ({ serverId, through }) => {
            writeLeavingFootDismissal(serverId ?? getActiveServerSnapshot().serverId, { leavingThrough: through });
            return { dismissed: true };
        },
        sessionRetentionLeavingList: async ({ serverId, signal }) => {
            const checkScope = guardActiveAccount(serverId, signal);
            const { sync } = await import('@/sync/sync');
            return sync.listLeavingSessions(checkScope, signal);
        },
        sessionRetentionSummaryGet: ({ signal }) => fetchSessionRetentionSummary(signal),
        sessionExport: async ({ sessionId, all, seqs, format, serverId, signal }) => {
            const checkScope = guardActiveAccount(serverId, signal);
            const { saveAccountTranscriptExport, saveSessionTranscriptExport } = await import('@/components/sessions/transcript/presentTranscriptExport');
            checkScope();
            if (all) return saveAccountTranscriptExport(format, { signal });
            if (!sessionId) throw new Error('session_required');
            if (!storage.getState().sessions[sessionId]) {
                const { sync } = await import('@/sync/sync');
                await sync.ensureSessionVisibleForMessageRoute(sessionId);
                checkScope();
            }
            return saveSessionTranscriptExport(sessionId, format, { seqs, signal });
        },
    };
}
