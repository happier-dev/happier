import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useAccountPlanValue, type AccountPlanEntry } from '@/sync/domains/plans/accountPlanResource';
import { isHappierCloudServerUrl } from '@/sync/domains/server/serverProfiles';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { t } from '@/text';

export type PlanSurfaceVisibility = Readonly<{
    /** The page, its Settings row and its routes exist only when one of the two bits is on. */
    visible: boolean;
    /** Cloud plans, limits and history (`plans` bit). */
    plans: boolean;
    /** The Supporter offer, ring and credits (`supporter` bit). */
    supporter: boolean;
    cloudPlans: boolean;
    /** Both decisions are known; until then a direct route waits instead of redirecting. */
    resolved: boolean;
}>;

/**
 * The one decider for whether the Plans & Supporter surfaces exist on this server (PROGRAM, Gates).
 * Both bits fail closed: a missing or malformed bit hides everything and issues no plan read.
 */
export function usePlanSurfaceVisibility(): PlanSurfaceVisibility {
    const plansDecision = useFeatureDecision('plans');
    const supporterDecision = useFeatureDecision('supporter');
    const plans = plansDecision?.state === 'enabled';
    const supporter = supporterDecision?.state === 'enabled';
    const { cloudPlans } = usePlanSurfacePresentation(plans);
    return { cloudPlans, visible: plans || supporter, plans, supporter, resolved: plansDecision !== null && supporterDecision !== null };
}

const selectPaidOffers = (entry: AccountPlanEntry) => entry.data
    ? entry.data.offers?.plans.some((plan) => plan.prices.some((price) => price.amountMinor > 0)) === true
    : null;

export function usePlanSurfacePresentation(plansEnabled: boolean): Readonly<{ isCloudServer: boolean; cloudPlans: boolean }> {
    const { serverUrl } = useActiveServerSnapshot();
    const paidOffers = useAccountPlanValue(selectPaidOffers);
    const isCloudServer = isHappierCloudServerUrl(serverUrl);
    return { isCloudServer, cloudPlans: plansEnabled && isCloudServer && paidOffers !== false };
}

export function planSurfaceTitle(visibility: Pick<PlanSurfaceVisibility, 'cloudPlans'>): string {
    return visibility.cloudPlans ? t('planSurface.titlePlans') : t('planSurface.titleSupport');
}
