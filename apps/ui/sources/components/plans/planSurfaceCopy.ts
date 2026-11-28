import { countSupporterMonths, type AccountLimitsV1, type AccountPlanResponseV1, type PlanDefinitionV1, type PlanPriceV1 } from '@happier-dev/protocol';

import { getPreferredLanguage, t } from '@/text';

/**
 * The one copy and formatting owner for the Plans & Supporter surfaces (plan 04).
 *
 * Every number shown on these surfaces comes from `GET /v1/account/plan`: this module formats what
 * the server sent and never supplies a price, a period or a limit of its own.
 */

const FREE_COLUMN_ID = 'free';

export type PlanLadderColumn = Readonly<{
    id: string;
    name: string;
    /** Null for the base tier, which costs nothing. */
    price: PlanPriceV1 | null;
    limits: AccountLimitsV1;
    /** Every paid plan includes the Supporter pack (PROGRAM, `supporter.active`). */
    includesPack: boolean;
    current: boolean;
}>;

export function monthlyPrice(plan: Pick<PlanDefinitionV1, 'prices'>): PlanPriceV1 | null {
    return plan.prices.find((price) => price.interval === 'month') ?? null;
}

function isPaid(plan: PlanDefinitionV1): boolean {
    return plan.prices.some((price) => price.amountMinor > 0);
}

/**
 * The comparison drawn in "Keep more": Free (only when the server publishes base limits) followed by
 * the offered plans in the server's order, low to high. An offer the server did not send is absent.
 */
export function buildPlanLadder(params: Readonly<{
    baseLimits: AccountLimitsV1 | null;
    plans: readonly PlanDefinitionV1[];
    currentPlanId: string | null;
}>): PlanLadderColumn[] {
    const columns: PlanLadderColumn[] = [];
    if (params.baseLimits) {
        columns.push({
            id: FREE_COLUMN_ID,
            name: t('planSurface.free'),
            price: null,
            limits: params.baseLimits,
            includesPack: false,
            current: params.currentPlanId === null,
        });
    }
    for (const plan of params.plans) {
        columns.push({
            id: plan.id,
            name: plan.name,
            price: monthlyPrice(plan),
            limits: plan.limits,
            includesPack: isPaid(plan),
            current: plan.id === params.currentPlanId,
        });
    }
    return columns;
}

export function nextPlanUp(ladder: readonly PlanLadderColumn[]): PlanLadderColumn | null {
    const currentIndex = ladder.findIndex((column) => column.current);
    const next = ladder[currentIndex + 1];
    return next && next.price ? next : null;
}

/** The plan named by the Cloud-only line on the Supporter block (PROGRAM Q30). */
export function cheapestPackPlan(plans: readonly PlanDefinitionV1[]): PlanDefinitionV1 | null {
    let cheapest: PlanDefinitionV1 | null = null;
    for (const plan of plans) {
        const price = monthlyPrice(plan);
        if (!price || price.amountMinor <= 0) continue;
        const best = cheapest ? monthlyPrice(cheapest) : null;
        if (!best || price.amountMinor < best.amountMinor) cheapest = plan;
    }
    return cheapest;
}

export function formatMinorAmount(amountMinor: number, currency: string, locale?: string): string {
    const whole = amountMinor % 100 === 0;
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: 2,
    }).format(amountMinor / 100);
}

export function formatPrice(price: PlanPriceV1 | null, locale?: string): string {
    return price ? formatMinorAmount(price.amountMinor, price.currency, locale) : formatMinorAmount(0, 'usd', locale);
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export function formatStorageBytes(bytes: number, locale?: string): string {
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    return bytes >= GIB ? `${number.format(bytes / GIB)} GB` : `${number.format(bytes / MIB)} MB`;
}

/** "60 days", "1 year", or "No limit" for an unlimited period. */
export function formatRetentionPeriod(days: number | null): string {
    if (days === null) return t('planSurface.noLimit');
    if (days % 365 === 0) return t('planSurface.years', { count: days / 365 });
    return t('planSurface.days', { count: days });
}

export function formatPinLimit(pins: number | null, locale?: string): string {
    return pins === null ? t('planSurface.noLimit') : new Intl.NumberFormat(locale).format(pins);
}

export function formatStorageLimit(bytes: number | null, locale?: string): string {
    return bytes === null ? t('planSurface.noLimit') : formatStorageBytes(bytes, locale);
}

export function formatPlanDate(epochMs: number, locale?: string): string {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(epochMs));
}

export function formatMonthYear(epochMs: number, locale?: string): string {
    return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(new Date(epochMs));
}

export function formatSupporterTenure(supporter: AccountPlanResponseV1['supporter'], nowMs = Date.now()): string | null {
    if (!supporter.active) return null;
    if (supporter.recurringSince !== null) {
        const since = new Intl.DateTimeFormat(getPreferredLanguage(), { month: 'long', year: 'numeric', timeZone: 'UTC' })
            .format(supporter.recurringSince);
        return t('planSurface.supportingForMonths', { count: countSupporterMonths(supporter.recurringSince, nowMs), since });
    }
    return supporter.since === null ? null : t('planSurface.supporterSinceYear', { year: new Date(supporter.since).getUTCFullYear() });
}

/** Pads a supporter number the way the pass prints it: 42 → "0042". */
export function formatSupporterNumber(value: number): string {
    return String(value).padStart(4, '0');
}

/** Who bills a plan, from the plan's `source` (plan 03 writes polar, app_store, play, manual, team). */
export function billedByLabel(source: string | null): string | null {
    switch (source) {
        case 'polar': return t('planSurface.billedByWeb');
        case 'app_store': return t('planSurface.billedByAppStore');
        case 'play': return t('planSurface.billedByPlay');
        case 'manual': return t('planSurface.billedByHappier');
        default: return null;
    }
}

/** "Lite and Plus" in the active language where the platform can join a list. */
export function joinPlanNames(names: readonly string[], locale?: string): string {
    const ListFormat = (Intl as unknown as { ListFormat?: new (locale?: string, options?: object) => { format(list: readonly string[]): string } }).ListFormat;
    return ListFormat ? new ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names) : names.join(', ');
}
