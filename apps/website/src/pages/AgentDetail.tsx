import {
    AGENTS,
    setupLinkFor,
    type AgentRecord,
    type ConnectedServiceId,
} from '../data/agents';
import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { InstallCommand } from '../components/InstallCommand';
import { DOCS_URL, GUIDES_URL, WEB_APP_URL } from '../data/downloads';
import { rich, substitute } from '../i18n/rich';
import type { ReactNode } from 'react';
import { useSiteData } from '../i18n/siteData';
import { useLocalePath } from '../i18n';

/** The slot renderer every message in this file uses for an inline code span. */
const CODE = (c: ReactNode) => <code className="font-mono">{c}</code>;

/**
 * /agents/<slug>
 *
 * The page answers one question — "does this run MY agent, on MY computer, from
 * MY phone?" — and refuses the second job it used to have, which was ranking
 * thirteen vendors against each other in a nine-column matrix. See the docblock
 * in src/data/agents.ts for why that matrix was removed rather than corrected.
 *
 * WHY THIRTEEN PAGES ARE NOT ONE PAGE THIRTEEN TIMES
 * --------------------------------------------------
 * The obvious fix for thirteen near-identical pages is to reword them. That is
 * the wrong fix: reworded identical content is still identical content, and the
 * pattern it produces is the doorway set search engines discount. So the
 * variation is carried by branches on facts that genuinely differ, each read
 * off the shipped manifest, and each changing what the reader can do:
 *
 *   lead                  authored per agent, first on the page, and now the
 *                         section that carries most of the weight: 200-350
 *                         words about what happens when Happier starts THIS
 *                         binary. It was one 55-120 word paragraph, which left
 *                         the page one paragraph of difference followed by five
 *                         sections of shared argument.
 *   InstallReality        four shapes, from `install.managed`/`install.manual`.
 *   RunsOnAccount         rendered for the five agents that can consume a
 *                         connected service; absent for the other eight.
 *   TerminalHandoff       three shapes, from `runtime.localControl` — see its
 *                         own docblock for the sentence it replaced.
 *   tool delivery         native MCP or the `happier tools` shell bridge.
 *
 * What remains shared is shared on purpose. One app, one session list, one
 * install command — repeating that is not duplication, it is the product.
 *
 * THE SECTION HEADINGS DESCRIBE, THEY DO NOT FRAME
 * ------------------------------------------------
 * They used to be written for a reader who already knew what the page was:
 * "Claude Code in particular", "What it does", "Terminal or UI". Each named a
 * position in the argument rather than a thing the reader gets, and none of
 * them carried a noun anyone types into a search box. Someone arriving cold on
 * "gemini cli mobile app" got no purchase on any of them.
 *
 * Every heading now says what its section covers, and carries the agent's name
 * where the sentence wants one — which is most of them, because that name is
 * the search term these pages exist for. It also cuts rendered similarity
 * rather than adding to it: the headings differ per page where the template
 * used to repeat verbatim. The doorway gate in agents.test.ts is the number to
 * watch if that ever stops being true.
 */

const OTHER_AGENT_COUNT = AGENTS.length - 1;

/**
 * How a connected service reads inside a sentence, keyed by the protocol id.
 *
 * THE ARTICLE IS PART OF THE LABEL, and that is what broke. These strings carry
 * "a"/"an" because the sentence that introduced them needed one — "It accepts a
 * Claude subscription" — but a second sentence dropped the same string in after
 * "the same", and the flagship page's second paragraph shipped reading "the same
 * a Claude subscription is selectable", on all five connected-service pages.
 * Anywhere the sentence supplies its own determiner, use `withoutArticle`.
 * copyClaims.test.ts renders every route and fails on a doubled article.
 */
const CONNECTED_SERVICE_LABELS: Record<ConnectedServiceId, string> = {
    'openai-codex': 'a Codex subscription',
    openai: 'an OpenAI API key',
    'claude-subscription': 'a Claude subscription',
    anthropic: 'an Anthropic API key',
    gemini: 'a Gemini login',
};

/** The same label with its leading article removed, for slots that carry one. */
function withoutArticle(label: string): string {
    return label.replace(/^(?:an?|the)\s+/i, '');
}

function joinWithOr(parts: ReadonlyArray<string>): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

function docsHref(path: string): string {
    return `${DOCS_URL.replace(/\/$/, '')}${path}`;
}

/**
 * `backticks` in an authored string become real <code> spans.
 *
 * The copy in src/data/agents.ts writes commands and package names the way
 * anyone writing them down does — `happier codex`, `@google/gemini-cli` — and
 * the old page rendered those backticks as literal punctuation, so every page
 * shipped visible grave accents. Doing it here rather than storing JSX keeps
 * the data file a data file: agents.test.ts reads those strings for the
 * superlative and duplicate-sentence gates, and it cannot read React nodes.
 */
function Ticks({ text }: { text: string }) {
    const parts = text.split('`');
    return (
        <>
            {parts.map((part, index) =>
                index % 2 === 1 ? (
                    // eslint-disable-next-line react/no-array-index-key -- positional by construction
                    <code key={index} className="font-mono text-[0.94em]">
                        {part}
                    </code>
                ) : (
                    // eslint-disable-next-line react/no-array-index-key -- positional by construction
                    <span key={index}>{part}</span>
                ),
            )}
        </>
    );
}

/**
 * The install sentence, per agent, from `install.managed` and
 * `install.manual.kind` in the definition.
 *
 * The old page rendered "It does not bundle {name} and does not update it for
 * you" on all thirteen. Eight of the thirteen declare a managed install path,
 * so on eight pages that sentence was simply false. These four are what the
 * definitions actually say.
 */
function InstallReality({ agent }: { agent: AgentRecord }) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const values = {
        binary: agent.binary,
        source: agent.managedSource ?? '',
        path: `~/.happier/tools/providers/${agent.id}/`,
    };

    switch (agent.installKind) {
        case 'happier-managed-package':
            return <P>{rich(PAGE_PROSE.agentDetail.p14, { 1: CODE, 2: CODE, 3: CODE }, values)}</P>;
        case 'happier-managed-release':
            return <P>{rich(PAGE_PROSE.agentDetail.p15, { 1: CODE, 2: CODE, 3: CODE }, values)}</P>;
        case 'vendor-script':
            return (
                <P>{rich(PAGE_PROSE.agentDetail.p0, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> }, { binary: agent.binary, vendor: agent.vendor })}</P>
            );
        case 'you-install-it':
            return (
                <P>{rich(PAGE_PROSE.agentDetail.p1, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> }, { binary: agent.binary, vendor: agent.vendor })}</P>
            );
    }
}

/**
 * The hand-off sentence, per agent, from `runtime.localControl`.
 *
 * The old page rendered one template on all thirteen: "Typing happier {id}
 * gives you {vendor}'s own interface … and the same session is simultaneously
 * in the app." Both halves were wrong nearly everywhere.
 *
 *   • `happier <id>` draws HAPPIER's display, not the vendor's TUI. The shipped
 *     backends ship their own renderers — apps/cli/src/backends/claude/ui/
 *     RemoteModeDisplay.tsx, backends/codex/ui/CodexTerminalDisplay.tsx and the
 *     equivalents for the rest — and the ACP providers launch a stdio process
 *     with no TUI at all.
 *   • The vendor TUI is reached through local control, and the shipped manifest
 *     (remote-dev/packages/agents/src/manifest.ts) declares a usable strategy
 *     for exactly three: claude (:56, tmux), codex (:140, tmux) and opencode
 *     (:196, provider_attach). Kiro, Cursor and Grok declare
 *     `attachStrategy: 'unsupported'`; the other seven declare nothing.
 *   • "Simultaneously in the app" is wrong for the tmux pair as well: their
 *     topology is `exclusive`, so app messages queue while the TUI holds the
 *     session — "If you send a message from the app while Claude is locally
 *     controlled, Happier stores it in the pending queue first"
 *     (apps/docs/content/docs/providers/claude.mdx:32).
 *   • OpenCode is not exclusive, and the shipped docs say so outright: "the
 *     session stays writable from the app even when a terminal is attached"
 *     (apps/docs/content/docs/providers/opencode.mdx:120-127). It used to be
 *     introduced as the ONLY agent that behaves that way, which stopped being
 *     true: Claude Code's unified terminal runtime publishes `topology: 'shared'`
 *     with `remoteWritable: true` (remote-dev/apps/cli/src/backends/claude/
 *     localControl/buildClaudeAgentState.ts:31-48). What is still only true of
 *     OpenCode is that it needs no multiplexer and no setting turned on, so that
 *     is what the sentence says now.
 *   • For the ten with no strategy, `happier attach` still runs — it lists what
 *     is on that computer and leaves what it cannot reattach disabled, with the
 *     reason (apps/docs/content/docs/features/attach-to-session.mdx:47-52).
 */
function TerminalHandoff({ agent }: { agent: AgentRecord }) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const values = { name: agent.name, attach: 'happier attach <session-id>' };

    switch (agent.runtime.localControl.kind) {
        case 'tmux':
            return (
                <P>
                    {rich(PAGE_PROSE.agentDetail.p16, { 1: CODE }, values)}
                    {agent.runtime.terminalPromptInjection
                        ? <> {rich(PAGE_PROSE.agentDetail.p17, undefined, values)}</>
                        : null}
                </P>
            );
        case 'provider-attach':
            return <P>{rich(PAGE_PROSE.agentDetail.p18, { 1: CODE }, values)}</P>;
        case 'none':
            return <P>{rich(PAGE_PROSE.agentDetail.p19, { 1: CODE }, values)}</P>;
    }
}

/**
 * Which credentials this agent can be pointed at, for the five that can be
 * pointed at one.
 *
 * A connected service is keyed by CREDENTIAL, not by agent
 * (packages/protocol/src/connect/connectedServiceBindings.ts), so a Claude
 * subscription you connected for Claude Code is the same object OpenCode and Pi
 * can run on. Eight of the thirteen consume none of them and get no section —
 * an empty "supported credentials: none" row would read as a missing feature
 * rather than as the ordinary case it is.
 */
function RunsOnAccount({ agent }: { agent: AgentRecord }) {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const services = agent.runtime.connectedServices;
    if (services.length === 0) return null;

    const list = joinWithOr(services.map((id) => CONNECTED_SERVICE_LABELS[id]));

    const values = {
        name: agent.name,
        list,
        service: withoutArticle(CONNECTED_SERVICE_LABELS[services[0]]),
    };

    return (
        <Prose
            heading={substitute(PAGE_PROSE.agentDetail.p20, { name: agent.name })}
            data-section="agent-accounts"
        >
            <P>{rich(PAGE_PROSE.agentDetail.p21, undefined, values)}</P>
            <P>
                {rich(
                    PAGE_PROSE.agentDetail.p22,
                    {
                        1: (c: ReactNode) => (
                            <a
                                href={docsHref('/features/connected-services')}
                                target="_blank"
                                rel="noreferrer"
                                className="underline underline-offset-2"
                                style={{ color: 'var(--fg)' }}
                            >
                                {c}
                            </a>
                        ),
                    },
                    values,
                )}
            </P>
        </Prose>
    );
}

/**
 * TAKES A SLUG, NOT A RECORD, AND THAT IS THE WHOLE POINT.
 *
 * It used to take the `AgentRecord` itself, handed in by src/routes.tsx and by
 * src/entries/_agent.tsx — both of which read it from the module-scope
 * `AGENTS_BY_SLUG`, which is the ENGLISH catalogue and which the overlay never
 * touches. So thirteen pages rendered their headline, standfirst, lead prose and
 * FAQ in English in every language, while the chrome around them came through
 * `useSiteData()` and translated correctly. Nothing failed: those strings were
 * extracted, were translated into all nine locales, and were simply never asked
 * for — 163 of them.
 *
 * Resolving the record HERE makes the locale the single input. A caller cannot
 * hand in the wrong-language record, because a caller no longer hands in a
 * record.
 */
export function AgentDetail({ slug }: { slug: string }) {
    const { pageProse: { PAGE_PROSE }, agents: { AGENTS: LOCALISED_AGENTS } } = useSiteData();
    const localeHref = useLocalePath();

    const agent = LOCALISED_AGENTS.find((candidate) => candidate.slug === slug);
    if (!agent) {
        throw new Error(
            `<AgentDetail slug="${slug}"> names an agent that is not in AGENTS (src/data/agents.ts).`,
        );
    }

    const setupLink = setupLinkFor(agent);
    const hasSetupGuide = agent.vendorSetupGuide !== null;
    // Bound to a const because the link below is built inside a rich() slot
    // callback, and TypeScript drops the narrowing from `agent.happierDocsPath ?`
    // once the check and the use sit either side of a closure.
    const happierDocsPath = agent.happierDocsPath;

    return (
        <PageShell>
            <nav aria-label={PAGE_PROSE.agentDetail.p11} className="mx-auto max-w-[1400px] px-6 pt-8 md:px-10">
                <a href={localeHref('/agents')} className="text-[13px] underline underline-offset-2" style={{ color: 'var(--muted)' }}>{rich(PAGE_PROSE.agentDetail.p12)}</a>
            </nav>

            <PageHeader
                eyebrow={`${agent.vendor} · ${agent.binary}`}
                title={agent.h1}
                standfirst={agent.standfirst}
            />

            {/*
              * The lead is the section that makes this page worth arriving at,
              * and the only one written from scratch for this agent. It used to
              * be a single paragraph of 55-120 words; it is now three of
              * 200-350 in total, drawn from what the released tree actually
              * does when it starts this particular binary — the launch, the
              * permission mapping, the sign-in flow, the vendor's own words.
              * See the docblock on `lead` in src/data/agents.ts for why the
              * extra words could not come from anywhere else without turning
              * thirteen pages into a doorway set.
              */}
            <Prose heading={`How Happier runs ${agent.name}`} data-section="agent-lead">
                {agent.lead.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>
                        <Ticks text={paragraph} />
                    </P>
                ))}
            </Prose>

            <Prose
                heading={`What ${agent.name} does, and what Happier adds`}
                data-section="agent-what-it-does"
            >
                {agent.whatItDoes.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>
                        <Ticks text={paragraph} />
                    </P>
                ))}
                <div className="pt-2" data-cta-location="get-started">
                    <div
                        className="inline-flex items-center gap-2.5 rounded-2xl border px-4 py-3 font-mono text-[13px]"
                        style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
                    >
                        <span aria-hidden style={{ color: 'var(--muted)' }}>
                            $
                        </span>
                        <code>happier {agent.id}</code>
                    </div>
                </div>
            </Prose>

            {/*
              * Deliberately short, and deliberately the same on all thirteen.
              *
              * This is the one section that is genuinely identical per agent —
              * the clients do not vary by which CLI is running — so it says the
              * thing once and links out rather than restating the whole product
              * on every page. Thirteen copies of a long paragraph is how a page
              * set ends up 33% identical to itself.
              */}
            <Prose
                /*
                 * NOT "<agent> on your phone, browser and desktop", which was
                 * the first draft: three of the thirteen H1s are already that
                 * sentence — Kimi's, Kilo's and Gemini's — and a page whose H2
                 * restates its own H1 has spent a heading saying nothing new.
                 * The verbs are what this section is actually about: these are
                 * full clients, not read-only mirrors, which is the sentence
                 * the body opens on.
                 */
                heading={`Read, approve and answer ${agent.name} from any device`}
                data-section="agent-devices"
            >
                <P>{rich(PAGE_PROSE.agentDetail.p2, { 1: (c: ReactNode) => <a
                        href={WEB_APP_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> }, { name: agent.name })}</P>
            </Prose>

            {/*
                One heading for thirteen pages read as an instruction to go and
                install it yourself, which is wrong on the majority: eight of the
                thirteen are `happier-managed-*`, where Happier fetches the agent
                into ~/.happier/tools/providers/ when PATH has no copy. It is
                right on the other five — Claude Code among them, which ships as a
                vendor install script Happier refuses to execute unasked. So the
                heading follows installKind, and the pages stop being identical
                here as a side effect.
            */}
            <Prose
                heading={
                    agent.installKind === 'happier-managed-package' ||
                    agent.installKind === 'happier-managed-release'
                        ? `Happier can install ${agent.name} for you`
                        : `Installing ${agent.name} the way ${agent.vendor} documents it`
                }
                data-section="agent-your-computer"
            >
                <P>{rich(PAGE_PROSE.agentDetail.p3, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> }, { id: agent.id, name: agent.name, vendor: agent.vendor })}</P>
                <InstallReality agent={agent} />
                {/*
                    Only call it a guide when the definition carries a real
                    `install.guideUrl`. Five of the thirteen fall back to
                    `docsUrl`, and two of those are not install documentation at
                    all: Auggie's is augmentcode.com, a product homepage with no
                    install steps on it, and Kiro's is kiro.dev/docs/cli/acp/,
                    an ACP protocol page that assumes the CLI is already there —
                    on the one agent Happier cannot install for you. Introducing
                    either as "the install and sign-in guide" is the class of
                    sentence a reader disproves in one click.
                */}
                {setupLink ? (
                    <P>
                        {rich(
                            hasSetupGuide ? PAGE_PROSE.agentDetail.p23 : PAGE_PROSE.agentDetail.p24,
                            {
                                1: (c: ReactNode) => (
                                    <a
                                        href={setupLink}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline underline-offset-2"
                                        style={{ color: 'var(--fg)' }}
                                    >
                                        {c}
                                    </a>
                                ),
                            },
                            {
                                vendor: agent.vendor,
                                name: agent.name,
                                link: setupLink.replace(/^https?:\/\//, ''),
                            },
                        )}
                    </P>
                ) : null}
                {happierDocsPath ? (
                    <P>{rich(PAGE_PROSE.agentDetail.p4, { 1: (c: ReactNode) => <a
                            href={docsHref(happierDocsPath)}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2"
                            style={{ color: 'var(--fg)' }}
                        >{c}</a> }, { name: agent.name })}</P>
                ) : null}
            </Prose>

            <RunsOnAccount agent={agent} />

            <Prose
                heading={`One app for ${agent.name} and ${OTHER_AGENT_COUNT} other agents`}
                data-section="agent-other-agents"
            >
                <P>{rich(PAGE_PROSE.agentDetail.p5, undefined, { name: agent.name, length: AGENTS.length })}</P>
                <P>
                    {agent.runtime.toolsDelivery === 'native-mcp' ? (
                        <>
                            You define an MCP server once and {agent.name} receives it as native MCP
                            inventory, next to whatever MCP servers it already had of its own.
                        </>
                    ) : (
                        <>
                            You define an MCP server once, and because {agent.name} does not consume
                            MCP directly, Happier hands the same tool surface to it through the{' '}
                            <code className="font-mono">happier tools</code> shell bridge instead —
                            the same tools, delivered as commands it can run. The app previews the
                            effective tool surface before a session starts, so which one you got is
                            visible rather than inferred.
                        </>
                    )}
                </P>
                <P>{rich(PAGE_PROSE.agentDetail.p6, { 1: (c: ReactNode) => <a href={localeHref('/agents')} className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>{c}</a> })}</P>
            </Prose>

            <Prose
                heading={`The same ${agent.name} session in your terminal and in the app`}
                data-section="agent-terminal"
            >
                <P>{rich(PAGE_PROSE.agentDetail.p7, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> }, { id: agent.id, name: agent.name })}</P>
                <TerminalHandoff agent={agent} />
                <P>{rich(PAGE_PROSE.agentDetail.p8, { 1: (c: ReactNode) => <a
                        href={docsHref('/features/attach-to-session')}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
            </Prose>

            <section className="relative" data-section="agent-faq">
                <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                    <div className="max-w-[760px]">
                        <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">{rich(PAGE_PROSE.agentDetail.p13, undefined, { name: agent.name })}</h2>
                        <dl className="mt-6 space-y-7">
                            {agent.faq.map((item) => (
                                <div key={item.q}>
                                    <dt className="text-[17px] font-semibold" style={{ color: 'var(--fg)' }}>
                                        {item.q}
                                    </dt>
                                    <dd
                                        className="mt-2 text-[16px] leading-[1.68]"
                                        style={{ color: 'var(--muted)' }}
                                    >
                                        <Ticks text={item.a} />
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </div>
            </section>

            {/*
              * "in two commands" is countable on the page rather than a
              * flourish: the block below is the install one-liner
              * (<InstallCommand /> renders exactly one, per platform) and then
              * `happier <id>` in the repository. If a third step ever appears
              * here, the number in this heading is wrong.
              */}
            <Prose
                heading={`Get ${agent.name} onto your phone in two commands`}
                data-section="agent-cta"
            >
                <P>{rich(PAGE_PROSE.agentDetail.p9, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> }, { id: agent.id })}</P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
                <P>{rich(PAGE_PROSE.agentDetail.p10, { 1: (c: ReactNode) => <a
                        href={GUIDES_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
            </Prose>
        </PageShell>
    );
}
