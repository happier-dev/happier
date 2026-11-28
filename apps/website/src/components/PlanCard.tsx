import type { PlanCardCopy } from '../data/plans';
import { useLocalePath } from '../i18n';
import { useSiteData } from '../i18n/siteData';
import { plansRelease } from '../data/plansRelease';

export const CheckIcon = () => (
    <svg aria-hidden viewBox="0 0 16 16" className="mt-[3px] h-[15px] w-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--fg)' }}>
        <path d="m3.5 8.5 3 3 6-7" />
    </svg>
);

export const PackStar = () => (
    <svg aria-hidden viewBox="0 0 16 16" className="mt-[2px] h-[15px] w-[15px] shrink-0" style={{ color: 'var(--gold)' }} fill="currentColor">
        <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.3-3 4.4-.5z" />
    </svg>
);

/**
 * One plan on /plans. Static: a card is prose and a link, so it prerenders and
 * ships no JavaScript. Every number in it comes from src/data/plans.ts.
 *
 * A paid card's action has nowhere to go until purchases are live
 * (plansRelease), and a button with nowhere to go is worse than no button, so
 * it renders as a quiet, non-interactive status instead.
 */
export function PlanCard({ card }: { card: PlanCardCopy }) {
    const localeHref = useLocalePath();
    const { plans: { PLANS_PAGE, PURCHASES_PENDING } } = useSiteData();
    const href = card.href === null ? null : localeHref(card.href);
    const pending = href === null && !plansRelease.purchasesLive;
    return (
        <article
            id={`plan-${card.id}`}
            className={`flex min-w-0 flex-col gap-3 rounded-[18px] p-[22px] ${card.featured ? 'surface-card' : 'surface-ground'}`}
            style={{ boxShadow: 'inset 0 0 0 1px var(--card-border)' }}
        >
            <h3 className="font-display text-[24px] font-normal leading-[1.1] tracking-[-0.02em]" style={{ color: 'var(--fg)' }}>
                {card.name}
            </h3>
            <p className="flex flex-wrap items-baseline gap-x-1.5 text-[14px]" style={{ color: 'var(--muted)' }}>
                <span className="font-display text-[36px] font-normal leading-[1.15] tracking-[-0.03em] tabular-nums" style={{ color: 'var(--fg)' }}>
                    {card.price}
                </span>
                {card.per}
            </p>
            <ul className="grid gap-2 text-[14px] leading-[1.45]" style={{ color: 'var(--muted)' }}>
                {card.lines.map((line) => (
                    <li key={line} className="flex gap-[9px] [text-wrap:pretty]">
                        <CheckIcon />
                        <span>{line}</span>
                    </li>
                ))}
                {card.includesPack ? (
                    <li className="flex gap-[9px] font-medium" style={{ color: 'var(--fg)' }}>
                        <PackStar />
                        <span>{PLANS_PAGE.includesPack}</span>
                    </li>
                ) : null}
            </ul>
            {card.note ? (
                <p
                    className="mt-0.5 rounded-[10px] px-3 py-2.5 text-[13px] leading-[1.5] [text-wrap:pretty]"
                    style={{ color: 'var(--muted)', background: 'var(--card)', boxShadow: 'inset 0 0 0 1px var(--line)' }}
                >
                    {card.note}
                </p>
            ) : null}
            <span className="flex-1" />
            {href !== null ? (
                <a href={href} className={`plan-pill w-full ${card.featured ? 'plan-pill--pri' : ''}`}>
                    {card.cta}
                </a>
            ) : (
                <span className="plan-pill plan-pill--pending w-full" aria-disabled="true">
                    {pending ? PURCHASES_PENDING : card.cta}
                </span>
            )}
        </article>
    );
}
