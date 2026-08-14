import { AGENTS, UNLISTED_AGENTS, UPCOMING_AGENTS } from '../data/agents';
import { UPCOMING_LABEL, UPCOMING_RELEASE } from '../data/availability';
import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { InstallCommand } from '../components/InstallCommand';

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
                <P>
                    Happier does not host any of these agents and does not put a model of its own in
                    front of them. It installs on the computer that holds your repository, starts
                    the vendor’s own CLI there as an ordinary subprocess under your own login, and
                    carries the conversation to your other devices end-to-end encrypted.
                </P>
                <P>
                    What that means in practice is that you keep every agent you already pay for and
                    stop needing a different remote for each one. Each page below covers one agent
                    in the detail you want before installing something: the command Happier runs and
                    what it hands that binary, how a permission choice made on a phone is expressed
                    to that particular CLI, which sign-in flow the app can start for you, how the
                    binary gets onto your computer, whether the session can move to the agent’s own
                    terminal interface, and the questions people ask about running it this way.
                </P>
                <P>
                    Per-agent limits — which sessions can be forked, resumed, reattached or moved to
                    another computer — live in the Happier documentation rather than here, because
                    the documentation ships with the product and a marketing page does not.
                </P>
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
                <P>
                    The release ships one more id than this page has cards for, and leaving that
                    unsaid would make the page wrong within a release. A build-time test fails if a
                    shipped id appears in neither place — which is how this page finds out about a
                    new agent before you do.
                </P>
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
                <P>
                    Four more agents are coming in the next version and are not in the build you can
                    install today. None of them runs if you download Happier this afternoon, and
                    none of them is counted in the {AGENTS.length} above. They are here because a
                    page that quietly omitted them would be answering a different question than the
                    one you asked.
                </P>
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
                    page of its own. Until then it stays down here, in the future tense.
                </P>
            </Prose>

            <Prose heading="Or bring your own" data-section="agents-custom">
                <P>
                    Anything speaking the Agent Client Protocol can be added as a backend of your own
                    without waiting for us. That path has no page here because what it can do is
                    whatever your CLI implements, and writing a page about it would be writing a page
                    about your code.
                </P>
            </Prose>

            <Prose heading="Running any of them" data-section="agents-cta">
                <P>
                    Install Happier on the computer that holds your code, then start any agent on
                    this page by name — <code className="font-mono">happier claude</code>,{' '}
                    <code className="font-mono">happier codex</code>,{' '}
                    <code className="font-mono">happier opencode</code>. The agent runs there, under
                    your own subscription or API key. Happier is the transport and the interface,
                    not a middleman for the model call.
                </P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
            </Prose>
        </PageShell>
    );
}
