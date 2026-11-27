import snapshot from '../data/financesSnapshot.json';
import { useI18n, type Locale } from '../i18n';
import { rich, substitute } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';
import { RollingNumber } from './RollingNumber';
import { statsUrl, usePublicStat } from './publicStats';
import { SupporterWall } from './SupporterWall';

/**
 * The money sheet on /open: what Happier costs to run and build, how much of
 * that people's payments cover, and the latest supporters.
 *
 * Reads plan 07's `finances.json` v1 once per mount, starting from the compiled,
 * dated snapshot (src/data/financesSnapshot.json, the last owner-approved file),
 * so crawlers and a failed fetch both see real figures with their own `asOf`.
 * No poll, no timer.
 *
 * Order follows the owner's tone note: coverage and what people paid lead, the
 * monthly breakdown sits calmly below as operating and development costs.
 *
 * Everything is in the file's currency; the page performs no conversion and no
 * arithmetic on coverage (plan 07 computes `coveredPercent` once).
 */

export type FinancesMonth = {
    month: string;
    costs: { ai: number; servers: number; marketing: number; software: number };
    costsTotal: number;
    incomeReceived: number;
    earnedUsd: { hosted: number; supporter: number };
    people: { plus: number; lite: number | null; teamSeats: number; supportersRecurring: number; supportersOneTime: number } | null;
};

export type FinancesGoal = {
    id: 'servers' | 'ai' | 'everything';
    coveredPercent: number;
    plusMembersToCover: number | null;
};

export type Finances = {
    asOf: string;
    currency: string;
    scope: string;
    fx: { source: string; sourceUrl: string | null } | null;
    months: FinancesMonth[];
    goals: FinancesGoal[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isCount = (value: unknown): value is number => isNumber(value) && value >= 0 && Number.isInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function parseMonth(raw: unknown): FinancesMonth | null {
    if (!isObject(raw) || typeof raw.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.month)) return null;
    const { costs, earnedUsd, people } = raw;
    if (!isObject(costs) || !isObject(earnedUsd)) return null;
    if (![costs.ai, costs.servers, costs.marketing, costs.software].every(isNumber)) return null;
    if (!isNumber(raw.costsTotal) || !isNumber(raw.incomeReceived)) return null;
    if (!isNumber(earnedUsd.hosted) || !isNumber(earnedUsd.supporter)) return null;
    let parsedPeople: FinancesMonth['people'] = null;
    if (people !== null) {
        if (!isObject(people)) return null;
        if (![people.plus, people.teamSeats, people.supportersRecurring, people.supportersOneTime].every(isCount)) return null;
        if (people.lite !== undefined && !isCount(people.lite)) return null;
        parsedPeople = {
            plus: people.plus as number,
            lite: isCount(people.lite) ? people.lite : null,
            teamSeats: people.teamSeats as number,
            supportersRecurring: people.supportersRecurring as number,
            supportersOneTime: people.supportersOneTime as number,
        };
    }
    return {
        month: raw.month,
        costs: {
            ai: costs.ai as number,
            servers: costs.servers as number,
            marketing: costs.marketing as number,
            software: costs.software as number,
        },
        costsTotal: raw.costsTotal,
        incomeReceived: raw.incomeReceived,
        earnedUsd: { hosted: earnedUsd.hosted, supporter: earnedUsd.supporter },
        people: parsedPeople,
    };
}

const GOAL_IDS = new Set(['servers', 'ai', 'everything']);

function parseGoal(raw: unknown): FinancesGoal | null {
    if (!isObject(raw) || typeof raw.id !== 'string' || !GOAL_IDS.has(raw.id)) return null;
    if (!isNumber(raw.coveredPercent) || raw.coveredPercent < 0 || raw.coveredPercent > 100) return null;
    if (raw.plusMembersToCover !== null && !isCount(raw.plusMembersToCover)) return null;
    return {
        id: raw.id as FinancesGoal['id'],
        coveredPercent: raw.coveredPercent,
        plusMembersToCover: raw.plusMembersToCover,
    };
}

/**
 * Whole-document check. Any failure returns null and the caller keeps the
 * snapshot WHOLE, so months and totals from two documents never mix on a page
 * whose only asset is trust. Unknown fields are tolerated (plan 07, v1 is
 * additive); a document with no complete month is not a document to show.
 */
export function parseFinances(raw: unknown): Finances | null {
    if (!isObject(raw) || raw.schemaVersion !== 1) return null;
    if (!isText(raw.asOf) || !/^\d{4}-\d{2}-\d{2}$/.test(raw.asOf)) return null;
    if (!isText(raw.currency) || !/^[A-Z]{3}$/.test(raw.currency) || !isText(raw.scope)) return null;
    if (!Array.isArray(raw.months) || raw.months.length === 0 || !Array.isArray(raw.goals)) return null;
    const months = raw.months.map(parseMonth);
    const goals = raw.goals.map(parseGoal);
    if (months.some((m) => m === null) || goals.some((g) => g === null)) return null;
    const ordered = months as FinancesMonth[];
    for (let i = 1; i < ordered.length; i += 1) {
        if (ordered[i - 1].month >= ordered[i].month) return null;
    }
    let fx: Finances['fx'] = null;
    if (raw.fx !== null && raw.fx !== undefined) {
        if (!isObject(raw.fx) || !isText(raw.fx.source)) return null;
        const url = typeof raw.fx.sourceUrl === 'string' && raw.fx.sourceUrl.startsWith('https://') ? raw.fx.sourceUrl : null;
        fx = { source: raw.fx.source, sourceUrl: url };
    }
    return { asOf: raw.asOf, currency: raw.currency, scope: raw.scope.trim(), fx, months: ordered, goals: goals as FinancesGoal[] };
}

/** The compiled fallback, parsed by the same rules; null until the first approved month. */
export const FINANCES_SNAPSHOT = parseFinances(snapshot);

const COLUMNS = 12;

const monthDate = (month: string) => new Date(`${month}-01T00:00:00Z`);
const monthShort = (locale: Locale, month: string) =>
    monthDate(month).toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' });
const monthLong = (locale: Locale, month: string) =>
    monthDate(month).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' });
const dayLong = (locale: Locale, date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function nextMonth(month: string): string {
    const d = monthDate(month);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 7);
}

function money(locale: Locale, amount: number, currency: string): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

/** "US dollars" from "USD", so the page never hardcodes a currency word. */
function currencyName(locale: Locale, currency: string): string {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'name' })
        .formatToParts(2)
        .find((p) => p.type === 'currency');
    return part?.value ?? currency;
}

const pos = (value: number) => Math.max(0, value);

function WidgetHead({ title, scope }: { title: string; scope?: string }) {
    return (
        <div className="mb-4 flex flex-col gap-0.5 md:flex-row md:items-baseline md:gap-2.5">
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--fg)' }}>
                {title}
            </h3>
            {scope ? (
                <span className="text-[13px]" style={{ color: 'var(--muted)' }}>
                    {scope}
                </span>
            ) : null}
        </div>
    );
}

function Covered({ goals }: { goals: FinancesGoal[] }) {
    const { open: { OPEN_MONEY } } = useSiteData();
    const label = { servers: OPEN_MONEY.goalServers, ai: OPEN_MONEY.goalAi, everything: OPEN_MONEY.goalEverything };
    const servers = goals.find((g) => g.id === 'servers')?.plusMembersToCover ?? null;
    const everything = goals.find((g) => g.id === 'everything')?.plusMembersToCover ?? null;
    const note =
        servers !== null && everything !== null
            ? substitute(OPEN_MONEY.coveredNoteAll, { servers, everything })
            : servers !== null
              ? substitute(OPEN_MONEY.coveredNoteServers, { servers })
              : null;
    return (
        <div className="grid gap-3.5">
            {goals.map((goal) => {
                const percent = Math.round(goal.coveredPercent);
                return (
                    <div
                        key={goal.id}
                        className="grid grid-cols-[minmax(0,1fr)_90px_52px] items-center gap-3 text-[14px] md:grid-cols-[minmax(0,1fr)_150px_64px]"
                    >
                        <span style={{ color: 'var(--fg)' }}>{label[goal.id]}</span>
                        <span
                            className="money-track"
                            role="meter"
                            aria-label={label[goal.id]}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={percent}
                        >
                            <b style={{ width: `${goal.coveredPercent}%` }} />
                        </span>
                        <span className="text-right font-medium" style={{ color: 'var(--fg)' }}>
                            {percent}%
                        </span>
                    </div>
                );
            })}
            {note ? (
                <p className="text-[12.5px] leading-[1.5] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {note}
                </p>
            ) : null}
        </div>
    );
}

function Paid({ last, currency }: { last: FinancesMonth; currency: string }) {
    const { locale } = useI18n();
    const { open: { OPEN_MONEY } } = useSiteData();
    const earned = last.earnedUsd.hosted + last.earnedUsd.supporter;
    const p = last.people;
    const parts = p
        ? [
              `${p.supportersRecurring + p.supportersOneTime} ${OPEN_MONEY.peopleSupporter}`,
              ...(p.lite !== null ? [`${p.lite} ${OPEN_MONEY.peopleLite}`] : []),
              `${p.plus} ${OPEN_MONEY.peoplePlus}`,
              `${p.teamSeats} ${OPEN_MONEY.peopleTeamSeats}`,
          ]
        : null;
    return (
        <div>
            <div className="flex items-baseline gap-1.5">
                <span className="font-display text-[48px] leading-none tracking-[-0.03em]" style={{ color: 'var(--fg)' }}>
                    <RollingNumber value={money(locale, earned, currency)} />
                </span>
                <span className="text-[15px]" style={{ color: 'var(--muted)' }}>
                    {OPEN_MONEY.paidUnit}
                </span>
            </div>
            {parts ? (
                <p className="mt-2 text-[13px] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                    {OPEN_MONEY.payingPeople}: {parts.join(' · ')}
                </p>
            ) : null}
        </div>
    );
}

function CostBars({ months, currency }: { months: FinancesMonth[]; currency: string }) {
    const { locale } = useI18n();
    const { open: { OPEN_MONEY } } = useSiteData();
    const shown = months.slice(-COLUMNS);
    const future: string[] = [];
    let cursor = shown[shown.length - 1].month;
    while (shown.length + future.length < COLUMNS) {
        cursor = nextMonth(cursor);
        future.push(cursor);
    }
    const scale =
        Math.max(1, ...shown.map((m) => Math.max(m.costsTotal, pos(m.costs.ai) + pos(m.costs.servers), m.incomeReceived))) * 1.08;
    const pct = (value: number) => `${(pos(value) / scale) * 100}%`;
    const average = shown.reduce((sum, m) => sum + m.costsTotal, 0) / shown.length;

    return (
        <>
            <div className="money-bars" role="img" aria-label={substitute(OPEN_MONEY.costsChartLabel, {
                title: OPEN_MONEY.costsTitle, months: shown.length, currency: currencyName(locale, currency),
            })}>
                {shown.map((m, i) => {
                    const other = m.costsTotal - pos(m.costs.ai) - pos(m.costs.servers);
                    return (
                        <div key={m.month} className={`money-bars__m ${i === shown.length - 1 ? 'money-bars__m--last' : ''}`}>
                            <i className="money-bars__other" style={{ height: pct(other) }} />
                            <i className="money-bars__ai" style={{ height: pct(m.costs.ai) }} />
                            <i className="money-bars__srv" style={{ height: pct(m.costs.servers) }} />
                            {m.incomeReceived > 0 ? (
                                <>
                                    <b className="money-bars__inc" style={{ height: pct(m.incomeReceived) }} />
                                    <span className="money-bars__incv" style={{ bottom: `calc(${pct(m.incomeReceived)} + 4px)` }}>
                                        <span>{money(locale, m.incomeReceived, currency)}</span>
                                    </span>
                                </>
                            ) : null}
                        </div>
                    );
                })}
                {future.map((month) => (
                    <div key={month} className="money-bars__m" aria-hidden>
                        <i className="money-bars__fut" style={{ height: '92%' }} />
                    </div>
                ))}
                <div className="money-bars__avg" style={{ bottom: pct(average) }} aria-hidden />
            </div>
            <div className="money-axis" aria-hidden>
                {[...shown.map((m) => m.month), ...future].map((month) => (
                    <span key={month}>{monthShort(locale, month)}</span>
                ))}
            </div>
            <ul className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]" style={{ color: 'var(--muted)' }}>
                {(
                    [
                        ['money-bars__srv', OPEN_MONEY.legendServers],
                        ['money-bars__ai', OPEN_MONEY.legendAi],
                        ['money-bars__other', OPEN_MONEY.legendOther],
                    ] as const
                ).map(([cls, text]) => (
                    <li key={cls} className="inline-flex items-center gap-1.5">
                        <i aria-hidden className={`${cls} inline-block h-[9px] w-[9px] rounded-[2px]`} />
                        {text}
                    </li>
                ))}
                <li className="inline-flex items-center gap-1.5">
                    <i aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px]" style={{ background: 'var(--gold)' }} />
                    {OPEN_MONEY.legendIncome}
                </li>
            </ul>
            {/* The same figures as text: the bars are a picture of this table. */}
            {/* sr-only on a wrapper: a <table> ignores width:1px and would widen the page. */}
            <div className="sr-only">
            <table>
                <caption>{OPEN_MONEY.costsTitle}</caption>
                <thead>
                    <tr>
                        <th scope="col">{OPEN_MONEY.costsMonth}</th>
                        <th scope="col">{OPEN_MONEY.legendServers}</th>
                        <th scope="col">{OPEN_MONEY.legendAi}</th>
                        <th scope="col">{OPEN_MONEY.costsTotal}</th>
                        <th scope="col">{OPEN_MONEY.income}</th>
                    </tr>
                </thead>
                <tbody>
                    {shown.map((m) => (
                        <tr key={m.month}>
                            <th scope="row">{monthLong(locale, m.month)}</th>
                            <td>{money(locale, m.costs.servers, currency)}</td>
                            <td>{money(locale, m.costs.ai, currency)}</td>
                            <td>{money(locale, m.costsTotal, currency)}</td>
                            <td>{money(locale, m.incomeReceived, currency)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            </div>
        </>
    );
}

export function MoneySheet() {
    const { locale } = useI18n();
    const { open: { OPEN_MONEY } } = useSiteData();
    const finances = usePublicStat(statsUrl('finances.json'), parseFinances, FINANCES_SNAPSHOT);

    const last = finances && finances.months[finances.months.length - 1];
    return (
        <>
            <p className="max-w-[720px] text-[16px] leading-[1.65] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                {finances ? (
                    <>
                        {substitute(OPEN_MONEY.asOf, {
                            date: dayLong(locale, finances.asOf), currency: currencyName(locale, finances.currency),
                        })} {finances.scope}
                        {/[.!?]$/.test(finances.scope) ? '' : '.'} {OPEN_MONEY.lead}
                    </>
                ) : OPEN_MONEY.empty}
            </p>
            <div className={finances ? 'money-sheet money-figures mt-7' : 'money-sheet mt-7'}>
                {finances && last ? (
                    <>
                        <section>
                            <WidgetHead title={OPEN_MONEY.coveredTitle} scope={OPEN_MONEY.coveredScope} />
                            <Covered goals={finances.goals} />
                        </section>
                        <section>
                            <WidgetHead title={OPEN_MONEY.paidTitle} scope={monthLong(locale, last.month)} />
                            <Paid last={last} currency={finances.currency} />
                        </section>
                        <section className="money-full">
                            <WidgetHead
                                title={OPEN_MONEY.costsTitle}
                                scope={finances.months.length < COLUMNS ? `${OPEN_MONEY.costsScopeMonthly} · ${OPEN_MONEY.costsScopeFuture}` : OPEN_MONEY.costsScopeMonthly}
                            />
                            <CostBars months={finances.months} currency={finances.currency} />
                            {finances.fx ? (
                                <p className="mt-3 text-[12.5px] [text-wrap:pretty]" style={{ color: 'var(--muted)' }}>
                                    {rich(OPEN_MONEY.convertedAt, {
                                        1: (children) => finances.fx?.sourceUrl ? (
                                            <a href={finances.fx.sourceUrl} className="underline underline-offset-2" rel="noopener">
                                                {children}
                                            </a>
                                        ) : children,
                                    }, { currency: currencyName(locale, finances.currency), source: finances.fx.source })}
                                </p>
                            ) : null}
                        </section>
                    </>
                ) : null}
                <section className="money-full">
                    <WidgetHead title={OPEN_MONEY.wallTitle} scope={OPEN_MONEY.wallScope} />
                    <SupporterWall limit={6} />
                </section>
            </div>
        </>
    );
}
