import { UPCOMING_RELEASE } from '../data/availability';
import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { InstallCommand } from '../components/InstallCommand';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import type { ReactNode } from 'react';

/**
 * /agents
 *
 * A directory, not a scoreboard.
 *
 * This page used to open with a thirteen-by-nine capability matrix generated
 * from the agent registry in packages/agents. It was removed for the reason set
 * out in src/data/agents.ts: the registry this repository builds against is
 * ahead of the released build, and on Grok the two disagreed on five cells — so
 * the matrix published capabilities the shipped product does not have. A table
 * that can be wrong about the product is worse than no table, and the honest
 * per-agent limits belong in the docs, which are versioned with the product.
 *
 * THREE STATES, ONE PAGE. The grid is the shipped set and nothing else. The
 * "not yet" band below it names the agents that exist only in the unreleased
 * tree, each behind UPCOMING_LABEL, because leaving them out entirely would be
 * its own kind of inaccuracy — they are being worked on — while putting them in
 * the grid would be the inaccuracy that actually costs someone an afternoon.
 * availability.test.ts renders this page and fails if an upcoming name ever
 * appears outside that band.
 */
export function AgentsIndex() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const { agents: { AGENTS, UNLISTED_AGENTS, UPCOMING_AGENTS }, availability: { UPCOMING_LABEL } } = useSiteData();

    return (
        <PageShell>
            <PageHeader
                eyebrow="Every agent, one app"
                title="Every AI coding agent Happier runs"
                standfirst={
                    <>
                        {AGENTS.length} command-line coding agents, on your own computers, with your
                        own subscriptions and API keys — in one open-source app that runs on your
                        phone, your browser and your desktop.
                    </>
                }
            />

            <Prose data-section="agents-intro">
                <P>{rich(PAGE_PROSE.agentsIndex.p0)}</P>
                <P>{rich(PAGE_PROSE.agentsIndex.p1)}</P>
                <P>{rich(PAGE_PROSE.agentsIndex.p2)}</P>
            </Prose>

            <section className="relative" data-section="agents-list">
                <div className="mx-auto max-w-[1400px] px-6 py-6 md:px-10 md:py-8">
                    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                        {AGENTS.map((agent) => (
                            <a
                                key={agent.id}
                                href={`/agents/${agent.slug}`}
                                className="block rounded-2xl border p-5 transition-transform hover:-translate-y-[2px]"
                                style={{ borderColor: 'var(--card-border)' }}
                            >
                                <h2 className="text-[17px] font-semibold" style={{ color: 'var(--fg)' }}>
                                    {agent.name}
                                </h2>
                                <div
                                    className="mt-1 font-mono text-[12px]"
                                    style={{ color: 'var(--muted)' }}
                                >
                                    {agent.vendor} · happier {agent.id}
                                </div>
                                <p
                                    className="mt-3 text-[14px] leading-[1.6]"
                                    style={{ color: 'var(--muted)' }}
                                >
                                    {agent.standfirst}
                                </p>
                            </a>
                        ))}
                    </div>
                </div>
            </section>

            <Prose heading="What is not on this list, and why" data-section="agents-unlisted">
                {/*
                 * The dropped clause explained the mechanism to the reader: "A build-time test
                 * fails if a shipped id appears in neither place — which is how this page finds out
                 * about a new agent before you do." True — availability.test.ts asserts every
                 * shipped id is either an AGENTS card or an UNLISTED_AGENTS entry — but it is our
                 * build process, not the reader's answer. Recorded here so the guarantee is not
                 * lost with the sentence.
                 */}
                <P>{rich(PAGE_PROSE.agentsIndex.p3)}</P>
                <dl className="space-y-5">
                    {Object.entries(UNLISTED_AGENTS).map(([id, reason]) => (
                        <div key={id}>
                            <dt className="font-mono text-[14px]" style={{ color: 'var(--fg)' }}>
                                {id}
                            </dt>
                            <dd
                                className="mt-1 text-[15px] leading-[1.65]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {reason}
                            </dd>
                        </div>
                    ))}
                </dl>
            </Prose>

            <Prose heading="Coming in the next version" data-section="agents-upcoming">
                <P>{rich(PAGE_PROSE.agentsIndex.p4, undefined, { length: AGENTS.length })}</P>
                <dl className="space-y-5">
                    {UPCOMING_AGENTS.map((agent) => (
                        <div key={agent.id}>
                            <dt className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span className="text-[15px] font-semibold" style={{ color: 'var(--fg)' }}>
                                    {agent.name}
                                </span>
                                <span className="font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
                                    {agent.vendor} · {agent.binary}
                                </span>
                                <span
                                    className="rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium"
                                    style={{ borderColor: 'var(--card-border)', color: 'var(--muted)' }}
                                    data-availability="upcoming"
                                >
                                    {UPCOMING_LABEL}
                                </span>
                            </dt>
                            <dd
                                className="mt-1.5 text-[15px] leading-[1.65]"
                                style={{ color: 'var(--muted)' }}
                            >
                                {agent.note}
                            </dd>
                        </div>
                    ))}
                </dl>
                <P>
                    When one of them ships in {UPCOMING_RELEASE} it moves up into the grid and gets a
                    page of its own.
                </P>
            </Prose>

            <Prose heading="Or bring your own" data-section="agents-custom">
                <P>{rich(PAGE_PROSE.agentsIndex.p5)}</P>
            </Prose>

            <Prose heading="Running any of them" data-section="agents-cta">
                <P>{rich(PAGE_PROSE.agentsIndex.p6, { 1: (c: ReactNode) => <code className="font-mono">{c}</code>, 2: (c: ReactNode) => <code className="font-mono">{c}</code>, 3: (c: ReactNode) => <code className="font-mono">{c}</code> })}</P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
            </Prose>
        </PageShell>
    );
}
