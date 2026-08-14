import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { SECURITY_DOCS_URL, type SecurityHop } from '../data/security';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import type { ReactNode } from 'react';

/**
 * /security
 *
 * The footer link "Security & encryption" pointed straight at the docs, which
 * sent the one visitor most likely to be evaluating us off the site before they
 * had read a sentence we wrote. Encryption is load-bearing for this product; it
 * gets a page.
 *
 * WHO THIS IS FOR, and the line against /enterprise: this page is one developer
 * asking "what does the relay see". /enterprise is a buyer with a compliance
 * team asking "what can I enforce". So the storage policy appears on both and
 * is written twice from opposite ends — what changes for you here, which
 * variable sets it there — and neither page repeats the other's half. They link
 * to each other once, in each direction, and nowhere else.
 *
 * Every claim is anchored in src/data/security.ts, including the one anchor
 * that was checked and deliberately produced no sentence.
 */

const CIPHER_SAMPLE = 'hQx2Vb9k4Tn1Rm7c…';
const PLAIN_SAMPLE = 'push the hotfix branch';

export function SecurityPage() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { security: { SECURITY_KEYS, SECURITY_NOTIFICATIONS, SECURITY_PAIRING, SECURITY_SELF_HOST, SECURITY_SOURCE, SECURITY_STORAGE } } = useSiteData();

    return (
        <PageShell>
            {/*
              * THE H1 USED TO READ "The relay carries your session. It cannot
              * read it." Two defects in one line. It framed instead of
              * describing — a stranger arriving cold from search learns
              * nothing about what this page gives them — and it defined the
              * product by what the relay is unable to do rather than by what
              * the reader gets. The searchable nouns are "end-to-end
              * encryption" and "keys", and both are now in the heading. The
              * relay's limits are still stated, at length, in the ledger and
              * in the hop cards, where they are evidence rather than framing.
              */}
            <PageHeader
                eyebrow="Security"
                title="End-to-end encryption, with the keys on your own devices"
                standfirst="Happier keeps one coding session in sync between the computer it runs on and every device you watch it from, and a relay server sits in the middle of that. This page is the architecture under that sentence: which key is made where, what the relay actually holds, what it can still see, and what changes on a server configured to turn encryption off."
            />

            <MessagePath />

            <Ledger />

            <Prose heading="Your encryption keys are created on your own device" data-section="security-keys">
                {SECURITY_KEYS.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="Linking a new device, and how your keys reach it" data-section="security-pairing">
                {SECURITY_PAIRING.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="Storage policy: end-to-end encryption is the default" data-section="security-storage">
                {SECURITY_STORAGE.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
                <P>{rich(PAGE_PROSE.securityPage.p0, { 1: (c: ReactNode) => <a
                        href="/enterprise"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
            </Prose>

            <Prose heading="Push notifications are sent by your own computer" data-section="security-notifications">
                {SECURITY_NOTIFICATIONS.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="Self-hosted relay: the metadata stays on your hardware too" data-section="security-selfhost">
                {SECURITY_SELF_HOST.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="Read the encryption code yourself" data-section="security-source">
                {SECURITY_SOURCE.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
                <P>{rich(PAGE_PROSE.securityPage.p1, { 1: (c: ReactNode) => <a
                        href={SECURITY_DOCS_URL}
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
            </Prose>
        </PageShell>
    );
}

/**
 * The diagram, and the only animated thing on the page.
 *
 * It says one thing: the words are readable at both ends and ciphertext in the
 * middle. Nothing on the page is illustrated twice, and nothing is animated
 * that a still frame could not have said — this one needs the motion because
 * the argument IS the transition between the two states.
 *
 * The node row is <div className="stackrow">, the same primitive the homepage
 * self-host diagram uses, so the two pictures of these three nodes agree.
 */
function MessagePath() {
    const { security: { SECURITY_DIAGRAM_CAPTION, SECURITY_HOPS } } = useSiteData();

    return (
        <section className="relative" data-section="security-path">
            <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                <div className="max-w-[880px]">
                    <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                        How a message is encrypted between your phone and your computer
                    </h2>
                    <p
                        className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                        style={{ color: 'var(--muted)' }}
                    >
                        {SECURITY_DIAGRAM_CAPTION}
                    </p>
                </div>

                <div className="wire mx-auto mt-12 max-w-[720px]">
                    <div className="wire__lane" aria-hidden>
                        <div className="wire__carrier">
                            <div className="wire__packet">
                                <span className="wire__text wire__text--plain">{PLAIN_SAMPLE}</span>
                                <span className="wire__text wire__text--cipher font-mono">
                                    {CIPHER_SAMPLE}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="stackrow">
                        {SECURITY_HOPS.map((hop) => (
                            <div key={hop.id} className="text-center">
                                <span className="stackrow__icon" style={{ color: 'var(--fg)' }}>
                                    <HopIcon id={hop.id} />
                                </span>
                                <span
                                    className="mt-3.5 block text-[13px] font-semibold leading-tight sm:text-[15px]"
                                    style={{ color: 'var(--fg)' }}
                                >
                                    {hop.label}
                                </span>
                                <span
                                    className="stackrow__detail mt-1 block text-[12.5px] leading-[1.45]"
                                    style={{ color: 'var(--muted)' }}
                                >
                                    {hop.verb}
                                </span>
                            </div>
                        ))}

                        {/* Siblings of the cells, not gutter items, so both rails
                            are anchored to the icon centres at every width. */}
                        <div className="wire__rail wire__rail--1" aria-hidden />
                        <div className="wire__rail wire__rail--2" aria-hidden />
                    </div>
                </div>

                <dl className="mx-auto mt-12 grid max-w-[1080px] gap-4 md:grid-cols-3">
                    {SECURITY_HOPS.map((hop) => (
                        <div
                            key={hop.id}
                            className="rounded-2xl border p-6"
                            style={{ borderColor: 'var(--card-border)', background: 'var(--card)' }}
                        >
                            <dt
                                className="text-[11px] font-semibold uppercase tracking-[0.14em]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {hop.label}
                            </dt>
                            <dd
                                className="mt-3 text-[14.5px] leading-[1.6]"
                                style={{ color: 'var(--muted)' }}
                            >
                                <strong className="font-semibold" style={{ color: 'var(--fg)' }}>
                                    {hop.verb}.
                                </strong>{' '}
                                {hop.body}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
        </section>
    );
}

/**
 * The two columns of the ledger. Green and red would be a value judgement about
 * a design decision, so both columns are the same colour and only the headings
 * differ — the reader is being handed a fact to weigh, not a scorecard.
 */
function Ledger() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { security: { SECURITY_INVISIBLE, SECURITY_VISIBLE } } = useSiteData();

    return (
        <section className="relative" data-section="security-ledger">
            <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                <div className="max-w-[880px]">
                    <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                        What the relay server stores
                    </h2>
                    <p
                        className="mt-4 max-w-[720px] text-[16px] leading-[1.65]"
                        style={{ color: 'var(--muted)' }}
                    >{rich(PAGE_PROSE.securityPage.p2)}</p>
                </div>

                <div className="mt-10 grid gap-10 md:grid-cols-2 md:gap-14">
                    <LedgerColumn heading="It holds" items={SECURITY_VISIBLE} />
                    <LedgerColumn heading="It does not hold" items={SECURITY_INVISIBLE} />
                </div>
            </div>
        </section>
    );
}

function LedgerColumn({
    heading,
    items,
}: {
    heading: string;
    items: ReadonlyArray<{ id: string; title: string; body: string }>;
}) {
    return (
        <div>
            <div
                className="mb-6 border-b pb-3 text-[12px] font-semibold uppercase tracking-[0.16em]"
                style={{ color: 'var(--muted)', borderColor: 'var(--card-border)' }}
            >
                {heading}
            </div>
            <dl className="space-y-6">
                {items.map((item) => (
                    <div key={item.id}>
                        <dt className="text-[16px] font-semibold" style={{ color: 'var(--fg)' }}>
                            {item.title}
                        </dt>
                        <dd
                            className="mt-1.5 text-[15px] leading-[1.62]"
                            style={{ color: 'var(--muted)' }}
                        >
                            {item.body}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

/**
 * Same construction as the self-host stack glyphs — 24-unit box, 1.3 stroke at
 * 36px — so the two diagrams read as one icon set. The relay carries a padlock
 * because that is the one node whose state the page is about.
 */
// `SecurityHop['id']`, not `(typeof SECURITY_HOPS)[number]['id']`. The array now
// reaches the page through useSiteData(), and a type query would sit in the
// PARAMETER LIST — outside any body a hook can run in — so it has to name the
// exported type instead of the module-level const.
function HopIcon({ id }: { id: SecurityHop['id'] }) {

    const props = {
        width: 36,
        height: 36,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
    };

    if (id === 'device') {
        return (
            <svg {...props}>
                <rect x="7" y="2.5" width="10" height="19" rx="2.6" />
                <path d="M10.9 5.5h2.2" />
            </svg>
        );
    }

    if (id === 'relay') {
        return (
            <svg {...props}>
                <rect x="2.5" y="4" width="19" height="6" rx="2" />
                <path d="M6 7h.01" />
                <rect x="8.5" y="14" width="7" height="5.5" rx="1.4" />
                <path d="M10.2 14v-1.6a1.8 1.8 0 0 1 3.6 0V14" />
            </svg>
        );
    }

    return (
        <svg {...props}>
            <rect x="2.5" y="4" width="19" height="13" rx="2.4" />
            <path d="m6.8 8.7 2.5 1.8-2.5 1.8M12 12.9h4.6" />
            <path d="M9 20.5h6" />
        </svg>
    );
}
