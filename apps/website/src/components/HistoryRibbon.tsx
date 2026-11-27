import { useSiteData } from '../i18n/siteData';

/**
 * One example history drawn under each Happier Cloud plan's period: the same
 * draws for every row, only the edge moves, so the difference reads at a
 * glance (sp3Web:plans, round 5).
 *
 * Static and deterministic (a seeded generator), so it prerenders and ships no
 * JavaScript. The ticks are drawn ONCE per width as `<symbol>`s and each row
 * reuses them through clip regions: past the plan's edge they fade, in the last
 * seven days before it they are outlined (about to leave), pinned ticks stay
 * solid everywhere. Phones get their own, sparser draw rather than a squeezed
 * desktop one, which would turn into a solid block.
 */

const SPAN = 120;
const H = 40;
const NOTICE_DAYS = 7;

type Tick = { x: number; h: number; pinned: boolean; day: number };

function rng(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function draw(width: number, density: number, seed = 5): Tick[] {
    const r = rng(seed);
    const x = (day: number) => width - 4 - (day * (width - 8)) / SPAN;
    const ticks: Tick[] = [];
    for (let day = 0; day < SPAN; day += 1) {
        const weekend = (day + 2) % 7 >= 5;
        const n = weekend ? (r() < 0.4 ? 1 : 0) : Math.floor(r() * density);
        for (let j = 0; j < n; j += 1) {
            const at = x(day + r() * 0.85);
            const h = Math.round(10 + Math.pow(r(), 1.6) * (H - 16));
            ticks.push({ x: at, h, pinned: r() < 0.15, day });
        }
    }
    return ticks;
}

const VARIANTS = [
    { id: 'wide', width: 1050, density: 3.2, tickWidth: 2, className: 'hidden md:block' },
    { id: 'narrow', width: 300, density: 2.2, tickWidth: 1.6, className: 'block md:hidden' },
] as const;

function Row({ variant, keepDays, ticks }: { variant: (typeof VARIANTS)[number]; keepDays: number | null; ticks: Tick[] }) {
    const { id, width, tickWidth } = variant;
    const x = (day: number) => width - 4 - (day * (width - 8)) / SPAN;
    const pins = ticks.filter((t) => t.pinned && t.day > 14);
    const clip = `rib-${id}-${keepDays ?? 'all'}`;
    const edge = keepDays !== null ? x(keepDays) : null;
    const leaveStart = keepDays !== null ? x(keepDays - NOTICE_DAYS) : null;
    return (
        <svg viewBox={`0 -8 ${width} ${H + 8}`} preserveAspectRatio="none" aria-hidden className={variant.className}>
            {edge !== null && leaveStart !== null ? (
                <defs>
                    <clipPath id={`${clip}-old`}>
                        <rect x={-8} y={-8} width={edge + 8} height={H + 8} />
                    </clipPath>
                    <clipPath id={`${clip}-leave`}>
                        <rect x={edge} y={-8} width={leaveStart - edge} height={H + 8} />
                    </clipPath>
                    <clipPath id={`${clip}-kept`}>
                        <rect x={leaveStart} y={-8} width={width - leaveStart + 8} height={H + 8} />
                    </clipPath>
                </defs>
            ) : null}
            {edge !== null ? <line className="edge" x1={edge} y1={0} x2={edge} y2={H} vectorEffect="non-scaling-stroke" /> : null}
            <line className="base" x1={0} y1={H} x2={width} y2={H} vectorEffect="non-scaling-stroke" />
            {edge !== null ? (
                <>
                    <use href={`#rib-${id}-free`} clipPath={`url(#${clip}-kept)`} />
                    <use href={`#rib-${id}-free`} clipPath={`url(#${clip}-leave)`} className="leave" />
                    <use href={`#rib-${id}-free`} clipPath={`url(#${clip}-old)`} className="old" />
                </>
            ) : (
                <use href={`#rib-${id}-free`} />
            )}
            <use href={`#rib-${id}-pinned`} />
            {pins.map((t, i) => (
                <circle key={i} className="pd" cx={(t.x + tickWidth / 2).toFixed(1)} cy={H - t.h - 5} r={2.2} />
            ))}
        </svg>
    );
}

export function HistoryRibbon() {
    const { plans: { PLANS_PAGE } } = useSiteData();
    const drawn = VARIANTS.map((variant) => ({ variant, ticks: draw(variant.width, variant.density) }));
    return (
        <div className="ribbon">
            {/* Tick geometry, defined once per width and reused by every row. */}
            <svg aria-hidden style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
                <defs>
                    {drawn.map(({ variant, ticks }) => (
                        <g key={variant.id}>
                            {(['free', 'pinned'] as const).map((kind) => (
                                <symbol key={kind} id={`rib-${variant.id}-${kind}`} viewBox={`0 -8 ${variant.width} ${H + 8}`} preserveAspectRatio="none" overflow="visible">
                                    {ticks
                                        .filter((t) => (kind === 'pinned') === t.pinned)
                                        .map((t, i) => (
                                            <rect key={i} x={t.x.toFixed(1)} y={H - t.h} width={variant.tickWidth} height={t.h} rx={1} vectorEffect="non-scaling-stroke" />
                                        ))}
                                </symbol>
                            ))}
                        </g>
                    ))}
                </defs>
            </svg>
            {PLANS_PAGE.ribbonRows.map((row, i) => (
                <div key={row.id} className={i > 0 ? 'mt-[18px]' : ''}>
                    <div className="mb-1.5 flex flex-col gap-0 text-[13px] leading-[1.45] md:flex-row md:flex-wrap md:items-baseline md:justify-between md:gap-x-4" style={{ color: 'var(--muted)' }}>
                        <b className="text-[14px] font-semibold" style={{ color: 'var(--fg)' }}>
                            {row.name}
                        </b>
                        <span>{row.caption}</span>
                    </div>
                    {drawn.map(({ variant, ticks }) => (
                        <Row key={variant.id} variant={variant} keepDays={row.keepDays} ticks={ticks} />
                    ))}
                </div>
            ))}
            <div className="relative mt-2.5 h-4 font-mono text-[10.5px] tabular-nums" style={{ color: 'var(--muted)' }} aria-hidden>
                {[120, 90, 60, 30, 0].map((day, i, all) => (
                    <span
                        key={day}
                        className="absolute top-0 whitespace-nowrap"
                        style={{
                            left: `${(1 - day / SPAN) * 100}%`,
                            transform: i === 0 ? 'none' : i === all.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                        }}
                    >
                        {day === 0 ? (
                            PLANS_PAGE.ribbonAxisToday
                        ) : i === 0 ? (
                            <>
                                {day}
                                <span className="hidden md:inline"> {PLANS_PAGE.ribbonAxisAgo}</span>
                                <span className="md:hidden"> d</span>
                            </>
                        ) : (
                            day
                        )}
                    </span>
                ))}
            </div>
        </div>
    );
}
