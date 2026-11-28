import { trackFaqOpened } from '../analytics/events';

export type FaqListItem = {
    id: string;
    q: string;
    a: ReadonlyArray<string>;
};

/**
 * A list of questions as native `<details>` disclosures.
 *
 * Still no JS accordion: the browser's own disclosure does the work, so the list
 * keeps behaving in an island-free prose page and cannot be broken by a bundle
 * that fails to load. A closed `<details>` carries its answer in the HTML
 * source, so crawlers parse the same bytes either way.
 *
 * Two sizes over one structure: `section` is the homepage FAQ (large question
 * headings, chevron), `compact` is the reference-page list on /plans (hairline
 * rows, a plus that folds into a minus). `defaultOpenId` opens one answer at
 * first paint, which is how the /plans lab frame shows the question most
 * readers arrive with.
 */
export function FaqList({
    items,
    variant = 'section',
    defaultOpenId,
    className = '',
}: {
    items: ReadonlyArray<FaqListItem>;
    variant?: 'section' | 'compact';
    defaultOpenId?: string;
    className?: string;
}) {
    const compact = variant === 'compact';
    return (
        <div className={`${compact ? 'faq--compact' : ''} ${className}`.trim()}>
            {items.map((item) => (
                <details
                    key={item.id}
                    className="faq__item"
                    open={item.id === defaultOpenId ? true : undefined}
                    /* Fires on OPEN as well as close: an entry people open is an
                       entry the page left them wondering about. `question` carries
                       the literal text rather than a slug, so the PostHog breakdown
                       is the keyword report. */
                    onToggle={(event) =>
                        trackFaqOpened({
                            question: item.q,
                            open: (event.currentTarget as HTMLDetailsElement).open,
                        })
                    }
                >
                    <summary className="faq__q" style={{ color: 'var(--fg)' }}>
                        {/* The question is a heading, not a styled span: question-shaped
                            H3s are what passage ranking reads, and inside a bare
                            <summary> they would be absent from the document outline. */}
                        <h3
                            className={
                                compact
                                    ? 'text-[16px] font-medium leading-[1.45] [text-wrap:pretty]'
                                    : 'text-[18px] font-semibold leading-[1.35] md:text-[20px]'
                            }
                        >
                            {item.q}
                        </h3>
                        {compact ? (
                            <span aria-hidden className="faq__pm" />
                        ) : (
                            <svg
                                aria-hidden
                                className="faq__chev"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="m6 9 6 6 6-6" />
                            </svg>
                        )}
                    </summary>
                    <div className="faq__a">
                        {item.a.map((paragraph, i) => (
                            <p
                                key={i}
                                className={
                                    compact
                                        ? 'mt-2.5 max-w-[720px] text-[15px] leading-[1.62] [text-wrap:pretty]'
                                        : 'mt-4 text-[15px] leading-[1.62] md:text-[16px]'
                                }
                                style={{ color: 'var(--muted)' }}
                            >
                                {paragraph}
                            </p>
                        ))}
                    </div>
                </details>
            ))}
        </div>
    );
}
