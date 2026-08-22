/**
 * The per-agent public record: one entry per coding agent happier.dev markets.
 *
 * WHAT THESE PAGES ARE NOW, AND WHAT THEY DELIBERATELY STOPPED BEING
 * ------------------------------------------------------------------
 * They used to be a capability reference: nine columns per agent — resume,
 * session listing, forking, rewind, handoff, tool delivery, attach, steering —
 * asserted against the agent registry in packages/agents.
 *
 * That job is deleted, for two reasons.
 *
 * 1. The registry this repository builds against is ahead of the released
 *    build. On 2026-08-11 the two disagreed about Grok on five cells:
 *    remote-dev/packages/agents/src/manifest.ts:479-491 declares
 *    `vendorResume: 'experimental'`, `sessionFork: unsupported/unsupported`,
 *    `sessionRollback: unsupported` and `localControl.supported: true`, while
 *    this repository's generated definition declares resume, both forks and
 *    rollback SUPPORTED and localControl absent. The shipped answer is also the
 *    one in our own documentation (apps/docs/.../providers/grok.mdx:68:
 *    "Session listing, fork, rollback, output media, and vendor-state handoff
 *    are not currently supported"). A page generated from the unreleased
 *    registry publishes four capabilities the product does not have.
 * 2. Every superlative the audit found — "the only agent that…", "the strongest
 *    …of any agent", "seven of the nine columns" — existed only because the
 *    pages were trying to rank thirteen vendors against each other. Nobody
 *    arriving from "remote claude code app" wants a ranking. They want to know
 *    whether this runs their agent, on their computer, from their phone.
 *
 * WHAT IS AUTHORED VS WHAT IS ASSERTED
 * ------------------------------------
 *   asserted against the registry   binary, vendorDocs, vendorSetupGuide,
 *                                   installKind, managedSource, and that
 *                                   `happier <id>` is a real subcommand
 *   asserted against the docs repo  happierDocsPath resolves to a real .mdx
 *   authored, shape-checked only    h1, standfirst, whatItDoes, faq
 *
 * The asserted set is deliberately small and deliberately boring: an install
 * command and a setup link do not rot between releases, and both were checked
 * to be byte-identical in the released build
 * (remote-dev/packages/agents/src/providers/providerCliRuntime.ts:84-345) and
 * in this one. Nothing on an agent page claims a session capability, because a
 * session capability is exactly the kind of fact that moves under a page.
 *
 * NO COMPARATIVES. agents.test.ts fails the build on a superlative or a
 * cross-agent ranking in any authored string here. If a sentence is only
 * interesting because it beats another vendor, it is the wrong sentence.
 *
 * ON THE COUNT, AND ON WHICH REGISTRY DECIDES IT
 * ----------------------------------------------
 * The shipped registry is SHIPPED_AGENT_IDS in ./availability.ts, transcribed
 * from the released tree and cross-checked against it by availability.test.ts.
 * It is NOT this repository's generated agentIds, which is what the old guard
 * read and why four unreleased agents ended up published as though they ran.
 *
 * Every shipped id is either one of the thirteen with a page, or an entry in
 * UNLISTED_AGENTS with the reason it has none. Every id that exists only in
 * this repository is an entry in UPCOMING_AGENTS, which renders behind the
 * not-yet-available label and is counted in nothing.
 *
 * WHAT MAKES THESE THIRTEEN PAGES DIFFERENT FROM EACH OTHER
 * ---------------------------------------------------------
 * Thirteen pages carrying the same argument with the nouns swapped is the
 * doorway pattern, and rewording them would make it worse rather than better —
 * spun copy is still duplicate copy. So the difference is carried by facts that
 * genuinely vary per agent, each read off the shipped manifest and each
 * changing what the reader can actually do:
 *
 *   localControl      whether a vendor TUI exists to hand the session to at
 *                     all. manifest.ts declares a usable attach strategy for
 *                     three of the thirteen — claude, codex, opencode — and for
 *                     the other ten the answer is no, which is a fact about the
 *                     vendor rather than a shortfall of ours.
 *   connectedServices which credential the agent runs on. Five agents can run
 *                     on a profile you connected once; eight run on whatever
 *                     that computer is signed in with.
 *   terminalPromptInjection
 *                     whether a prompt can be typed into a live vendor terminal
 *                     rather than handed to a runner. `runtimeInput` in the
 *                     shipped manifest declares it for claude alone (:57-60),
 *                     and pi declares the inverse pair (:412-415), which is
 *                     already what pi's lead is about. It is the fact under the
 *                     Claude Unified section on /agents/claude-code.
 *   toolsDelivery     native MCP or the `happier tools` shell bridge.
 *
 * TWO AXES WERE TRIED AND ARE REJECTED
 *
 *   installKind       every agent here can be installed through Happier or
 *                     found on your PATH, so which of the four shapes it takes
 *                     changes a paragraph, not a page. Still asserted against
 *                     the registry; just not an identity.
 *   topology          `exclusive` vs `shared` is a detail INSIDE local control,
 *                     and leading a page with it was misleading. Claude's
 *                     manifest topology is `exclusive`, but that describes the
 *                     default runtime only: under the unified terminal runtime
 *                     the same agent publishes `shared` with the app writable
 *                     (remote-dev/apps/cli/src/backends/claude/localControl/
 *                     buildClaudeAgentState.ts:31-48). A page-level claim built
 *                     on it would be true of a setting, not of an agent.
 *
 * ACP is not an axis either. Most backends in the shipped tree carry an ACP
 * runtime path — auggie, copilot, cursor, kilo, kimi, qwen, opencode and grok
 * all have one — so "ACP or native" would split thirteen pages on something
 * nearly every entry has. Where it is genuinely load-bearing (kiro, launched as
 * `kiro-cli acp` from the built-in ACP catalog at
 * remote-dev/packages/agents/src/acp.ts:36-47) it is an authored quirk in that
 * page's lead, which is the right weight for it.
 *
 * `lead` is the authored consequence of those facts — the first thing the page
 * says, written to be true of one agent and not of the other twelve.
 *
 * THE FOUR AXES ADDED WHEN THE LEADS GREW, AND THE COLLAPSE THAT DID NOT HAPPEN
 * -----------------------------------------------------------------------------
 * The four structural axes above are binary, and thirteen entries divided by a
 * handful of binaries leaves collisions: six pages — cursor, kimi,
 * github-copilot, kilo, qwen, auggie — branch identically on all of them, and
 * they were measured at 29-34% rendered similarity, the top of the table.
 *
 * When the leads had to get longer, that was the trap. Padding those six with
 * more of the shared argument would have pushed them together, and the honest
 * response to that would have been to collapse some into rows on /agents.
 *
 * The padding came from four new axes instead, none of them binary and none of
 * them shared by any two agents:
 *
 *   the launch          what Happier passes the binary. `qwen --acp
 *                       --approval-mode <mode>`, `kimi --work-dir <dir> … acp`,
 *                       `auggie --acp` plus a `--permission <tool>:<policy>`
 *                       pair per published tool, `kilo acp` with an
 *                       OPENCODE_PERMISSION object in the environment,
 *                       `copilot --acp`, `cursor-agent acp`, and for grok an
 *                       update-safe stdio mode. Read from
 *                       remote-dev/apps/cli/src/backends/<id>/acp/backend.ts.
 *   the permission mode how Read-only, Safe YOLO and YOLO are expressed to THAT
 *                       agent — a vendor approval-mode flag for qwen, a
 *                       generated Kimi agent file that removes the shell and
 *                       write tools, per-tool rules for auggie, a JSON policy
 *                       object for kilo. Six agents, six mechanisms.
 *   the sign-in flow    AGENT_LOCAL_CLI_CONFIG (packages/agents/src/localCli.ts)
 *                       gives each one its own: `codex login`, `opencode auth
 *                       login`, `gemini auth`, `kiro-cli login`, a `/login`,
 *                       `/auth`, `/setup` or `/connect` typed into the running
 *                       CLI, grok's device-code variant, and for pi nothing at
 *                       all, because pi exposes no interactive login.
 *   the vendor's words  what the vendor says the CLI is for, quoted from the
 *                       vendor's own documentation rather than paraphrased.
 *
 * Measured after: rendered similarity fell from 26.4% mean / 34.0% max to
 * 21.4% / 26.8%, every pair among the six dropped 7-8 points, and each page now
 * carries 230-356 words of lead of which 94-98% of the five-word runs appear on
 * no other agent page. So nothing collapsed, and the reason it did not is a
 * measurement rather than an opinion. agents.test.ts holds both numbers as
 * ceilings and a floor, so the next agent has to earn its URL the same way.
 */

/** How the agent's CLI gets onto your computer, read from its definition. */
export type InstallKind =
    /** Happier can install an npm package into its own directory. */
    | 'happier-managed-package'
    /** Happier can download a GitHub release binary into its own directory. */
    | 'happier-managed-release'
    /** The vendor ships an install script. Happier will not run it unattended. */
    | 'vendor-script'
    /** No install path inside Happier at all; you install it, Happier finds it. */
    | 'you-install-it';

export type AgentFaqItem = {
    q: string;
    a: string;
};

/**
 * Whether a session can move between your terminal and the app, read from
 * `localControl` in the shipped manifest (packages/agents/src/manifest.ts).
 *
 * Three entries declare an attach strategy that exists — claude and codex over
 * tmux, opencode over its own attach. Three more (kiro, cursor, grok) declare
 * `localControl.supported` with `attachStrategy: 'unsupported'`, which is not a
 * hand-off anyone can perform, and the remaining seven declare nothing at all.
 * Both of those collapse to 'none' here, because a page that distinguished them
 * would be publishing a difference the reader cannot use.
 *
 * `topology` is transcribed and asserted, but it is a detail of this record and
 * not a page-level differentiator: it describes the DEFAULT runtime for that
 * agent, and for Claude Code the unified terminal runtime publishes a different
 * one. See the rejected-axes note at the top of this file.
 */
export type LocalControl =
    /** `happier attach` hands you the vendor TUI inside tmux; the app queues meanwhile. */
    | { kind: 'tmux'; topology: 'exclusive' }
    /** The vendor's own attach; terminal and app both stay writable. */
    | { kind: 'provider-attach'; topology: 'shared' }
    /** No hand-off to the vendor's interface. Happier draws the session itself. */
    | { kind: 'none' };

/**
 * How Happier-managed MCP tools reach the agent.
 *
 * Shipped: apps/docs/content/docs/features/happier-tools.mdx:41-72 names the
 * two delivery modes and which providers are on each.
 */
export type ToolsDelivery = 'native-mcp' | 'shell-bridge';

/**
 * Connected-service ids the agent can consume, from `connectedServices
 * .supportedServiceIds` in the shipped manifest and the compatibility table at
 * apps/docs/content/docs/features/connected-services.mdx:140-152.
 *
 * A connected service is a CREDENTIAL, not an agent — which is why this is a
 * list and why two of these agents can run on an account you connected for a
 * different one.
 *
 * The protocol declares six ids
 * (remote-dev/packages/protocol/src/connect/connectedServiceBindings.ts:3-10):
 * the five below plus `github`. No agent with a page consumes `github` in the
 * released manifest, so it is not in this union — a label for a credential no
 * page can offer is a label that would eventually be rendered by accident.
 */
export type ConnectedServiceId =
    | 'openai-codex'
    | 'openai'
    | 'claude-subscription'
    | 'anthropic'
    | 'gemini';

export type AgentRuntimeFacts = {
    localControl: LocalControl;
    toolsDelivery: ToolsDelivery;
    /** Empty where the agent runs only on that computer's own login. */
    connectedServices: ReadonlyArray<ConnectedServiceId>;
    /**
     * Whether a prompt can be typed into a live vendor terminal running this
     * agent, from `runtimeInput.terminalPromptInjectionSupported` in the shipped
     * manifest. True for claude and for nothing else; pi declares it false
     * beside `inFlightSteerSupported: true`, which is the pair its lead names.
     *
     * agents.test.ts uses this to gate the Claude Unified copy: a page may only
     * describe typing into the vendor's own terminal if its own record says the
     * release supports it.
     */
    terminalPromptInjection: boolean;
};

export type AgentRecord = {
    /**
     * Every record on this list is in the released build. The literal type is
     * the point: an unreleased agent cannot be added here without changing the
     * type, and UPCOMING_AGENTS is where it goes instead.
     */
    availability: 'shipped';
    /** Canonical id in packages/agents — also the CLI subcommand. */
    id: string;
    /** URL slug under /agents/. Kebab-case, brand-shaped, never the raw id. */
    slug: string;
    /** How people write the product's name. */
    name: string;
    vendor: string;
    /** Binary Happier looks for on PATH. Asserted against the registry. */
    binary: string;
    /** `install.docsUrl` from the definition. Often a product homepage. */
    vendorDocs: string | null;
    /** `install.guideUrl` from the definition — the real setup page when it exists. */
    vendorSetupGuide: string | null;
    /** Path under docs.happier.dev, or null where no page exists yet. */
    happierDocsPath: string | null;
    /** Asserted against `install.managed` / `install.manual.kind`. */
    installKind: InstallKind;
    /** npm package or GitHub repo Happier installs, when it installs one. */
    managedSource: string | null;
    /** Shipped-manifest facts that make this page different from the other twelve. */
    runtime: AgentRuntimeFacts;
    /** The H1. Varied per agent on purpose — see AGENT_META. */
    h1: string;
    /** The line under the H1. */
    standfirst: string;
    /**
     * The opening section: what is different about running THIS agent through
     * Happier. Written from `runtime` and from the quirks of having implemented
     * it, and true of one agent only — agents.test.ts checks the leads share no
     * sentence and that each names something the record actually declares.
     *
     * THREE PARAGRAPHS, NOT ONE, AND WHY THE LENGTH IS THE POINT
     * ----------------------------------------------------------
     * This was a single 55-120 word paragraph. What changed it is that the
     * pages had stopped saying enough to be worth arriving at: one paragraph of
     * difference, then five sections of shared product argument.
     *
     * The obvious way to make it longer is the wrong one. Padding thirteen
     * pages with reworded versions of the same argument is the doorway pattern,
     * and the previous pass had measured six of them — cursor, kimi,
     * github-copilot, kilo, qwen, auggie — branching identically on every
     * structural axis and rendering 29-34% alike, the top of the table.
     *
     * So the extra words come from the four places those six genuinely differ,
     * each read off the released tree:
     *
     *   the launch          what Happier actually passes that binary.
     *                       `qwen --acp --approval-mode <mode>`,
     *                       `kimi --work-dir <dir> … acp`, `auggie --acp` plus
     *                       a `--permission tool:policy` pair per tool,
     *                       `kilo acp` with an OPENCODE_PERMISSION env object,
     *                       `copilot --acp`, `cursor-agent acp`.
     *   the permission mode how read-only, plan and yolo are expressed to THAT
     *                       agent, which is a different mechanism on all six.
     *   the sign-in flow    AGENT_LOCAL_CLI_CONFIG in packages/agents/src/
     *                       localCli.ts gives every agent its own: a subcommand
     *                       for some, a slash command typed into the running
     *                       CLI for others, and nothing at all for Pi.
     *   the vendor's words  what the vendor says the CLI is for, quoted from
     *                       the vendor's own documentation.
     *
     * All four are checkable, none of them is shared, and each changes what the
     * reader does. The result went the right way — see the note on the rendered
     * similarity gate in agents.test.ts for the before and after.
     */
    lead: ReadonlyArray<string>;
    /** The "What <agent> does, and what Happier adds" section. */
    whatItDoes: string[];
    /** Four to six questions someone actually asks about this agent. */
    faq: ReadonlyArray<AgentFaqItem>;
};

/**
 * The vendor page to send someone to for install and sign-in.
 *
 * `install.guideUrl` is the setup page; `install.docsUrl` is frequently just the
 * product homepage — claude.ai, x.ai, augmentcode.com. The old page rendered
 * docsUrl and sent people to a marketing site when a setup guide existed one
 * field away.
 */
export function setupLinkFor(agent: AgentRecord): string | null {
    return agent.vendorSetupGuide ?? agent.vendorDocs;
}

/**
 * SHIPPED ids that deliberately have no marketing page, and why.
 *
 * agents.test.ts fails if a shipped id appears in neither this map nor AGENTS.
 * That is the anti-rot gate: a fifteenth coding agent cannot ship without
 * someone deciding, in this file, whether it gets a page.
 *
 * This used to hold four ids that are not in the released build at all. They
 * moved to UPCOMING_AGENTS. `customAcp` — which IS in the released build and
 * was in neither list — took their place.
 */
export const UNLISTED_AGENTS: Record<string, string> = {
    customAcp:
        'Custom ACP is not a vendor integration, it is the door for the ones we have not built: any CLI that speaks the Agent Client Protocol can be added as a backend of your own. There is no page because what it can do is whatever your CLI implements, and a page about that would be a page about your code. The Happier docs cover the configuration.',
};

/**
 * Agents that exist in the unreleased tree and NOT in the released build.
 *
 * They are named because pretending they are not being worked on would be its
 * own small dishonesty. They are labelled because a reader who installs today
 * gets none of them. Everything renders behind UPCOMING_LABEL, and
 * availability.test.ts fails the build if one of them turns up in AGENTS, in
 * AGENT_META, in the route table, or in any of the counted sets.
 *
 * Each `note` is written in the future tense on purpose. If you find yourself
 * writing "Happier runs X" about an entry here, it belongs in AGENTS instead —
 * which means it belongs in a release first.
 */
export type UpcomingAgent = {
    availability: 'upcoming';
    /** Id in this repository's registry. Verified absent from the shipped set. */
    id: string;
    name: string;
    vendor: string;
    /** Binary the unreleased definition declares. */
    binary: string;
    note: string;
};

export const UPCOMING_AGENTS: ReadonlyArray<UpcomingAgent> = [
    {
        availability: 'upcoming',
        id: 'antigravity',
        name: 'Antigravity CLI',
        vendor: 'Google',
        binary: 'agy',
        // Coming in the next version, and the anchor for that is the registry
        // in THIS repository rather than the released one: the definition sits
        // in packages/agents/src/generated/agentIds and declares the `agy`
        // binary on a Gemini credential. It is absent from the released
        // AGENT_IDS (see SHIPPED_AGENT_IDS in ./availability.ts), which is what
        // makes it upcoming rather than shipped.
        // The trailing clause here used to read "and we would rather say that
        // than let a search result imply otherwise" — our editorial reasoning,
        // addressed to the reader. The fact stands on its own.
        note: 'Google’s Antigravity CLI is coming in the next version — a terminal-hosted backend that will run on a Gemini credential. It is not in the build you can install today.',
    },
    {
        availability: 'upcoming',
        id: 'ohMyPi',
        name: 'oh-my-pi CLI',
        vendor: 'can1357',
        binary: 'omp',
        // Its own registry entry, not a flavour alias of `pi`: the definition
        // in this repository carries the `omp` binary and its own install
        // source, and `pi` in the released manifest declares flavorAliases
        // ['pi-coding-agent'] with no mention of it
        // (remote-dev/packages/agents/src/manifest.ts:370-374).
        note: 'oh-my-pi is a separate CLI from Pi, with its own binary and its own release repository. It arrives in the next version as an agent in its own right. Until that ships, the Pi page is about the pi binary, and nothing on this site runs omp.',
    },
    {
        availability: 'upcoming',
        id: 'coderabbit',
        name: 'CodeRabbit',
        vendor: 'CodeRabbit',
        binary: 'coderabbit',
        // Dropped: "That is why it would not get a page like the thirteen
        // above." — our URL-minting policy, which is not the reader's question.
        note: 'CodeRabbit is a review tool rather than a conversational coding agent, so even when it lands there is no session to open on your phone — it would be a tool run inside one.',
    },
    {
        availability: 'upcoming',
        id: 'deepsec',
        name: 'DeepSec',
        vendor: 'DeepSec',
        binary: 'deepsec',
        note: 'DeepSec is a security-scanning tool run, on the same footing as CodeRabbit: no conversation, no session to carry between your devices. Named here for completeness, not as something you can use.',
    },
];

/**
 * The thirteen.
 *
 * Ordering is by how many people arrive looking for them, not alphabetical and
 * not by how much we like the integration.
 */
export const AGENTS: ReadonlyArray<AgentRecord> = [
    {
        availability: 'shipped',
        id: 'claude',
        slug: 'claude-code',
        name: 'Claude Code',
        vendor: 'Anthropic',
        binary: 'claude',
        vendorDocs: 'https://claude.ai',
        vendorSetupGuide: 'https://code.claude.com/docs/en/setup',
        happierDocsPath: '/agents/claude',
        installKind: 'vendor-script',
        managedSource: null,
        runtime: {
            localControl: { kind: 'tmux', topology: 'exclusive' },
            toolsDelivery: 'native-mcp',
            connectedServices: ['claude-subscription', 'anthropic'],
            terminalPromptInjection: true,
        },
        h1: 'Open-source app for Claude Code',
        standfirst:
            'Claude Code keeps running on your own computer, signed in with your own Anthropic account. Happier gives it a phone, a browser tab and a desktop window.',
        lead: [
            'Claude Code is the agent Happier can run inside its own terminal interface rather than in front of it. Turn on the unified terminal runtime and Happier starts the real `claude` TUI in a shared terminal host, streams that session to your devices, and types what you send from the app straight into it — so a correction can land in the turn that is already running instead of waiting for the end of it. Anthropic’s own terminal is the thing accepting the correction, and Happier is holding the keyboard for you; that is a different arrangement from talking to a runner about a session, and it is the reason this page exists.',
            'The default runtime is the Agent SDK one, and for most sessions it is the right one. It resumes a conversation, it lists the Claude Code sessions on that computer, it can carry vendor state to a second computer, and when a usage limit stops you it can go and ask whether the limit has actually cleared instead of leaving you to guess. What it does not do is take a message into a turn that is already running: Anthropic documents the Agent SDK’s streaming input as queued messages that process sequentially, with the ability to interrupt. Choosing between the two runtimes changes that one behaviour and nothing about where your code lives.',
            'Signing in stays Anthropic’s flow, started from wherever you happen to be. The Claude Code provider page runs `claude` on the computer you picked and sends it `/login`, so the browser step happens on the computer that will hold the credential rather than on the phone in your hand. Happier looks for the binary where Anthropic’s installer puts it — `~/.local/bin`, the versioned directory under `~/.local/share/claude`, a Homebrew prefix, `~/.claude/local/cli.js` — before it offers to show you an install command, because on most computers it is already there.',
        ],
        whatItDoes: [
            'Claude Code is Anthropic’s terminal coding agent: you run `claude` in a repository and it reads files, edits them and runs commands. Happier does not change any of that. `happier claude` starts the same binary, in the same directory, under the same login, and mirrors the conversation to every device you are signed in on.',
            'What it buys you is the walk away. Start a refactor at your desk, read the diff on your phone on the way to lunch, answer the permission request it stopped on, and pick the session back up in your terminal when you sit down again. The repository stays on the computer it was already on.',
            'Steering and interrupting are not the same move, and Claude Unified is about the first one. Interrupting stops the turn and starts another; steering adds to the turn that is running. Anthropic documents the Agent SDK’s streaming input as queued messages that process sequentially, with the option to interrupt — which is the default runtime here, and it is the right one for most sessions. Claude Code’s own terminal takes the other kind: type while it is working and the instruction joins the work in progress. Unified drives that terminal, so the app can do it from a phone.',
            'It is one Claude Code process either way. In unified mode the terminal and the app are both live at once — you can be typing in the TUI on the computer while the session is answered from a phone, and neither of you is locked out. That is what “unified” means here: one process, one transcript, two places you can type into it.',
        ],
        faq: [
            {
                q: 'Do I need Claude Code installed first?',
                a: 'Yes. Happier runs the `claude` already on your PATH and prefers that copy over anything else. Anthropic distributes it with an install script; Happier can show you that command, and it will not execute a vendor install script on its own — vendor recipes are disabled unless you explicitly allow them.',
            },
            {
                q: 'Which Anthropic account gets billed?',
                a: 'The one `claude` is signed in with on that computer. Happier launches the CLI as a subprocess and does not sit between it and Anthropic, so your subscription or API key is used exactly as it is when you run `claude` yourself.',
            },
            {
                q: 'How do I turn the unified terminal runtime on?',
                a: 'It is a Claude Code provider setting in the app — Settings, Providers, Claude Code, “Use unified terminal runtime” — and it is off until you turn it on, because the Agent SDK runtime is the default. It needs a terminal host to put the TUI in: tmux if you have it, otherwise the zellij Happier bundles. That means macOS and Linux today; on Windows the CLI points you at WSL2. Either way `happier attach <session-id>` puts you back at that session in a terminal, and going to your phone afterwards does not start a second one.',
            },
            {
                q: 'What happens if I send a message while Claude is working?',
                a: 'On the default runtime it is queued or it interrupts, and the app tells you which before you commit to it. With the unified terminal runtime the message is typed into Claude Code’s own composer, so it can join the turn already in flight; when the screen is in a state where that would be unsafe — a dialog is open, or you are mid-draft in the terminal yourself — Happier holds it rather than typing over you.',
            },
            {
                q: 'Does my CLAUDE.md still apply?',
                a: 'Claude Code is reading your repository from the same working directory it always was, so `CLAUDE.md`, your project settings and your hooks apply unchanged. MCP servers you define once in Happier are handed to it in addition to the ones it already has.',
            },
            {
                q: 'What does Happier cost?',
                a: 'Nothing. The CLI, the mobile apps, the desktop app, the web app and the relay are MIT-licensed and free. You keep paying Anthropic for Claude Code exactly as you do now.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'codex',
        slug: 'codex',
        name: 'Codex CLI',
        vendor: 'OpenAI',
        binary: 'codex',
        vendorDocs: 'https://github.com/openai/codex',
        vendorSetupGuide: null,
        happierDocsPath: '/agents/codex',
        installKind: 'happier-managed-release',
        managedSource: 'openai/codex',
        runtime: {
            localControl: { kind: 'tmux', topology: 'exclusive' },
            toolsDelivery: 'native-mcp',
            connectedServices: ['openai-codex', 'openai'],
            terminalPromptInjection: false,
        },
        h1: 'Codex on your phone, from an open-source app',
        standfirst:
            'The openai/codex CLI runs on hardware you own, under your own ChatGPT subscription or API key. Happier is the window onto it from wherever you happen to be.',
        lead: [
            'Codex is the agent Happier launches in App Server mode by default, and the useful consequence is a refusal: if that mode is unavailable for a new session the launch fails instead of dropping quietly to something weaker, so ACP or MCP are choices you make on purpose rather than fallbacks that happen to you behind a session that then behaves differently from the last one.',
            'What is at stake in that choice is written down rather than felt. On the default runtime a Codex conversation can be forked, rolled back to an earlier point, and asked whether a usage limit has cleared yet; pick the MCP or ACP runtime instead and the release drops all three, which is exactly why a quiet downgrade would be the wrong kindness. Codex also keeps a vendor TUI you can be handed back — `happier attach` gives you the real Codex interface on the session already running, and while that terminal holds it, anything you send from the app waits in the queue instead of arriving underneath your cursor.',
            'It is also one of the two agents whose account can change mid-session. Connect a Codex subscription or an OpenAI key once, and a session that runs into a limit on one of them can be carried onto another profile in the same group instead of being abandoned — at most once a turn, and three times in a session hour, so it is a recovery rather than a rotation. The sign-in itself stays the vendor’s: the provider page runs `codex login` on the computer you chose, and the credential it writes stays there.',
        ],
        whatItDoes: [
            'Codex CLI is OpenAI’s terminal coding agent, shipped as a release binary from the openai/codex repository. `happier codex` starts that binary in the repository you point it at — same approval prompts, same working directory, same account as running it yourself.',
            'What changes is where you can read it from. The transcript, the file diffs and the approval requests appear in the Happier app on a phone, in a browser tab, or in the desktop app, end-to-end encrypted before they leave your computer.',
        ],
        faq: [
            {
                q: 'Do I have to install Codex myself?',
                a: 'Only if you want to. If `codex` is on your PATH, Happier uses it. If it is not, Happier can fetch the release binary from openai/codex and keep it under `~/.happier/tools/providers/codex/` — a copy you installed yourself always takes priority.',
            },
            {
                q: 'Is this the Codex inside the ChatGPT app?',
                a: 'No, and it is worth being precise: OpenAI put Codex into the ChatGPT mobile app, which is OpenAI’s own remote for it. Happier is a separate open-source app that runs the `codex` CLI on your computer and shows it to you alongside the other twelve agents in the same session list.',
            },
            {
                q: 'Which account does it use?',
                a: 'Whichever one `codex` is already signed in with on that computer — a ChatGPT subscription or an API key. Happier does not proxy the model call and never stores those credentials on a server.',
            },
            {
                q: 'Can I run Codex and another agent at the same time?',
                a: 'Yes. Each agent is its own process; Happier lists their sessions side by side, collects their permission requests in one inbox, and routes a notification tap to the session that raised it.',
            },
            {
                q: 'Where do I configure it?',
                a: 'Codex’s own configuration stays where Codex keeps it. Everything Happier adds — engine and mode selection, permission defaults, MCP servers, connected services — is documented on the Codex page in the Happier docs.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'opencode',
        slug: 'opencode',
        name: 'OpenCode',
        vendor: 'SST',
        binary: 'opencode',
        vendorDocs: 'https://opencode.ai',
        vendorSetupGuide: 'https://opencode.ai/docs',
        happierDocsPath: '/agents/opencode',
        installKind: 'happier-managed-package',
        managedSource: 'opencode-ai',
        runtime: {
            localControl: { kind: 'provider-attach', topology: 'shared' },
            toolsDelivery: 'native-mcp',
            connectedServices: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
            terminalPromptInjection: false,
        },
        h1: 'Open-source app for OpenCode',
        standfirst:
            'OpenCode is open source. Happier is open source, MIT-licensed and self-hostable. Neither of them needs a server you do not control.',
        lead: [
            'OpenCode reaches its own interface through its own attach flow, with no multiplexer in the picture and nothing to enable first — the session Happier started is the session `opencode` reattaches to, and the app keeps taking messages while a terminal is sitting on it.',
            'The other half of the story is credentials: OpenCode brings a provider layer of its own, so Codex, OpenAI, Claude-subscription and Anthropic profiles you connected once are all selectable at session start, and a pool assembled for a different agent turns out to be useful here. The Claude subscription entry accepts both shapes the release brokers — a browser login and a setup token — while the Anthropic one stays an API key, and which of them you are running under is chosen when the session starts rather than inherited from whatever that computer was last signed into.',
            'Forking is where the release gives this one room. An OpenCode conversation can be forked whole, and it can be forked from a particular message — the difference between “try that again differently” and “go back to before the third tool call, then try that again differently”. Skills and slash commands you keep in `.opencode/skills` and `.opencode/commands`, or under `~/.config/opencode`, are read as prompt assets and travel with the session, so what you taught the CLI at your desk is still there when the session is being answered from a phone.',
        ],
        whatItDoes: [
            'OpenCode is SST’s terminal coding agent, and it brings its own provider layer: you point it at a model you already have access to and it drives that model against your repository. `happier opencode` runs the same binary with the same `opencode auth` credentials, in the same directory.',
            'Happier supplies the devices. A session you started in a terminal in one room is readable and answerable from a phone in another, and the transcript is encrypted on your computer before it goes anywhere.',
        ],
        faq: [
            {
                q: 'Do I need OpenCode installed already?',
                a: 'Not necessarily. Happier prefers the `opencode` on your PATH, and can install the `opencode-ai` package into its own directory if there is not one. Your own install is never replaced or upgraded behind your back.',
            },
            {
                q: 'Does Happier change which provider OpenCode talks to?',
                a: 'No. OpenCode keeps its own provider configuration and its own credentials; Happier starts it and reads the conversation. If you have several providers set up in `opencode auth`, that is still what decides where the request goes.',
            },
            {
                q: 'Can I self-host the part that carries my sessions?',
                a: 'Yes. The relay is in the same MIT-licensed repository and ships as a Docker image with PostgreSQL, SQLite or MySQL behind it. Point your clients at your own server and no traffic touches ours.',
            },
            {
                q: 'Does my code get uploaded anywhere?',
                a: 'No. OpenCode runs on your computer and reads your working directory there. What crosses the network is the session transcript, encrypted on your device before it leaves — the relay stores ciphertext it cannot read.',
            },
            {
                q: 'Which devices can open a session?',
                a: 'iOS, Android, the desktop app on macOS, Windows and Linux, and app.happier.dev in a browser. They all sign in to the same account and see the same session list.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'cursor',
        slug: 'cursor',
        name: 'Cursor Agent CLI',
        vendor: 'Anysphere',
        binary: 'cursor-agent',
        vendorDocs: 'https://cursor.com/docs/cli',
        vendorSetupGuide: 'https://cursor.com/docs/cli/installation',
        happierDocsPath: null,
        installKind: 'vendor-script',
        managedSource: null,
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'Run Cursor Agent CLI from your phone',
        standfirst:
            'Cursor ships a headless agent that does not need the editor window. Happier runs it on your computer and puts the conversation on your phone.',
        lead: [
            'The thing to know about Cursor before anything else is that the binary is not the one you installed for the editor. Happier looks for `cursor-agent`, the headless CLI, and deliberately never for `cursor`, which on most computers launches an editor window — no use on a computer nobody is sitting at. Cursor’s own CLI documentation writes the command as `agent`, so Happier will take a binary by that name too, but only after asking it `about --format json` and reading a Cursor version back: a stray `agent` on your PATH does not get to become your coding agent by accident.',
            'Anysphere describes the CLI as a way to “interact with AI agents directly from your terminal to write, review, and modify code”, and puts an interactive interface and print automation for scripts and CI pipelines on the same footing. That second half is the reason this page exists — the thing runs perfectly well with nobody watching it, which makes the question of where you read it from a real question. Happier can also answer whether Cursor is signed in on that computer rather than shrugging: the same `about` call reports the account, and a `CURSOR_API_KEY` in the environment is honoured if that is how the box is set up.',
            'Two Cursor behaviours needed work of their own on the Happier side. It generates images, and they arrive in the transcript as session media instead of a file path you have to go and find. And it asks structured questions — with choices, multiple selection and a freeform box — which the app draws as a question rather than as a wall of text you have to answer in prose; its plan step comes through as a plan you approve or send back. Model choice is read off your own CLI, and a model that advertises variants arrives as one entry with a reasoning-effort control and a fast toggle. Resume is the one place Happier is deliberately pessimistic: the release marks it experimental, checks it against the binary you have before offering it, and a resume that fails fails, rather than quietly opening a fresh conversation under the old title.',
        ],
        whatItDoes: [
            'Cursor’s command-line agent is a separate binary from the editor: `cursor-agent`, which drives a repository from a terminal and therefore runs perfectly well on a box with no GUI. `happier cursor` starts it under your own Cursor account.',
            'If the reason you are here is "I pay for Cursor and I am not at my desk", that is the whole feature. The agent runs where your repository is; you read it, approve it and steer it from whichever device you are holding.',
        ],
        faq: [
            {
                q: 'Why is the binary called something else?',
                a: 'Because it is a different program. Happier looks for `cursor-agent`, not `cursor` — on most computers `cursor` is the editor launcher, and starting that on a machine nobody is sitting at opens a window into the void. You still type `happier cursor`, because that is what people call it.',
            },
            {
                q: 'Do I need the Cursor editor installed?',
                a: 'No. The CLI installs on its own with Cursor’s install script, which is also what you would run on a server. Happier can show you that command and will not run a vendor install script unattended.',
            },
            {
                q: 'Does it use my Cursor subscription?',
                a: 'It uses whatever `cursor-agent` is signed in with on that computer. Happier starts the process and reads its output; it does not hold Cursor credentials or route requests through anything of ours.',
            },
            {
                q: 'Is there a Happier docs page for Cursor?',
                a: 'Not yet — Cursor is the one agent on this list without its own page in the Happier docs. The shared pages on agent authentication, permissions and model selection all apply to it, and the CLI’s own installation guide is linked above.',
            },
            {
                q: 'Can I use Cursor and Claude Code from the same app?',
                a: 'Yes. They are separate processes on your computer and separate sessions in Happier, in one list, with one set of keyboard shortcuts and one inbox for their permission requests.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'gemini',
        slug: 'gemini',
        name: 'Gemini CLI',
        vendor: 'Google',
        binary: 'gemini',
        vendorDocs: 'https://goo.gle/gemini-cli-auth-docs',
        vendorSetupGuide: null,
        happierDocsPath: '/agents/gemini',
        installKind: 'happier-managed-package',
        managedSource: '@google/gemini-cli',
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'native-mcp',
            connectedServices: ['gemini'],
            terminalPromptInjection: false,
        },
        h1: 'Gemini CLI on every device you use',
        standfirst:
            'Google’s open-source terminal agent, running against your own Google Cloud project if that is how your organisation works, readable from a phone.',
        lead: [
            'Gemini is the agent most likely to be running inside somebody else’s billing boundary rather than on a consumer login — a Google Cloud project and a location, read out of the shell environment of the process Happier starts. That is the part this page exists to say does not change.',
            'It is also the one Google credential Happier stores. Connect a Gemini profile once and it is selectable at session start on any of your computers; the OAuth code is exchanged on the server and comes back as an encrypted bundle, so no Google OAuth secret is shipped inside the app you installed. Two ways in, depending on what you are holding: paste the redirect URL, or let the native apps open an in-app browser. On the web client it is the paste flow. When you would rather not connect anything, Happier reads the local signal instead — Gemini’s own environment variables, its config files, and a supported Google application-default credentials file — and the provider page will start `gemini auth` for you on the computer you picked.',
            'Underneath that, Gemini takes MCP servers natively, so a server you defined once in Happier arrives as inventory rather than as a shell command it has to be told about. What the release does not offer for this one is a list of the Gemini sessions already on that computer, or a way to move vendor state to a second computer; a session you started through Happier resumes, and one you started in a bare terminal is not something the page will pretend to find. Skills you keep in `.gemini/skills` are picked up and travel with the session.',
        ],
        whatItDoes: [
            'Gemini CLI is Google’s open-source terminal coding agent. `happier gemini` starts it in your repository with the environment your shell already has — which, in a lot of organisations, means a Google Cloud project and a location rather than a consumer login.',
            'That deployment is the reason this page tends to matter. The agent runs inside your own billing and data boundary, and Happier only adds the transport: an encrypted session you can read on a phone, in a browser or on a second computer.',
        ],
        faq: [
            {
                q: 'Do I have to install the Gemini CLI first?',
                a: 'Happier uses the `gemini` on your PATH if there is one, and can otherwise install the `@google/gemini-cli` package into `~/.happier/tools/providers/gemini/`. It never upgrades or replaces a copy you manage yourself.',
            },
            {
                q: 'Does it work with a Vertex AI project?',
                a: 'The CLI reads its Google Cloud configuration from the environment of the process Happier starts, so a project and location that work in your shell work here. Happier does not add a gateway of its own between the agent and Google.',
            },
            {
                q: 'Where does my source code go?',
                a: 'Nowhere new. Gemini CLI reads your working directory on your computer and talks to Google the way it always does. Happier carries the conversation, encrypted end to end, and the relay it travels over can be one you host.',
            },
            {
                q: 'Can I use it next to an agent from another vendor?',
                a: 'Yes — that is the point of one app rather than one app per vendor. A Gemini session and a session from any of the other twelve show up in the same list on the same phone.',
            },
            {
                q: 'What does the Happier side cost?',
                a: 'Nothing, and there is no seat count. Everything — CLI, apps, relay — is MIT-licensed. Google bills you for Gemini exactly as it would without us.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'copilot',
        slug: 'github-copilot',
        name: 'GitHub Copilot CLI',
        vendor: 'GitHub',
        binary: 'copilot',
        vendorDocs: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
        vendorSetupGuide: null,
        happierDocsPath: '/agents/copilot',
        installKind: 'happier-managed-package',
        managedSource: '@github/copilot',
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'GitHub Copilot CLI, driven from your phone',
        standfirst:
            'The Copilot command-line agent, running on your own computer or your own build box, with the session in your pocket.',
        lead: [
            'Copilot is the agent where the identity question is worth asking before you start, and it is a question about the computer rather than about Happier. The CLI resolves whichever GitHub identity that box already has — a `gh auth login` someone did months ago, or a token exported for CI — and that is the identity the agent acts as when it touches a repository. Happier does not hold a GitHub identity of its own for it and does not substitute one.',
            'That is not a guess, it is how the check is implemented. Happier reads `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, and if none of them is set it asks the GitHub CLI for a token — so the answer on the provider page is the answer Copilot will get. It is deliberately per-computer, and GitHub’s own documentation is the reason: signing in on your laptop does not sign you in on the build box, and the page says which one it is talking about. GitHub also puts an active Copilot subscription in the prerequisites for the CLI, so if the agent stops with a subscription error, that is the vendor’s gate and not ours.',
            'The thing that is easy to miss, and the thing worth having on a phone: your skills come with it. SKILL.md bundles under `.github/skills` in the repository and `~/.copilot/skills` on that computer are discovered as prompt assets, so the instructions you wrote for Copilot at your desk are in force in a session you started from a train. Tools go the other way — Copilot does not take MCP servers directly, so the ones you defined in Happier reach it through the `happier tools` shell bridge, as commands rather than as inventory, and the app shows you which surface a session got before it starts.',
        ],
        whatItDoes: [
            'GitHub ships a Copilot agent for the command line that works against a repository the way the other CLIs here do, on the Copilot entitlement you already have. `happier copilot` runs that binary under your GitHub identity.',
            'Because it is a terminal program, the computer it runs on does not have to be the one you are looking at. Happier keeps the session readable and answerable from a phone, a browser tab or the desktop app while the repository stays put.',
        ],
        faq: [
            {
                q: 'Does Happier install Copilot CLI for me?',
                a: 'It can. If `copilot` is not on your PATH, Happier installs the `@github/copilot` package into its own directory under `~/.happier/`. If it is on your PATH, that copy wins and Happier leaves it alone.',
            },
            {
                q: 'Which GitHub identity does it act as?',
                a: 'Whichever one the CLI resolves on that computer. On a server that already ran `gh auth login`, or that exports a GitHub token for CI, that is the identity the agent acts as — worth checking before you point it at a production repository.',
            },
            {
                q: 'Can I run it on a server and use it from my laptop?',
                a: 'Yes. Install the Happier CLI on the computer that holds the repository, start the session there, and open it from any signed-in device. Nothing needs a GUI on the remote end.',
            },
            {
                q: 'Do I need the mobile app?',
                a: 'No. app.happier.dev is a full client in a browser, and the desktop app covers macOS, Windows and Linux. The mobile apps are for when the browser is not the thing in your hand.',
            },
            {
                q: 'Is Happier a GitHub product?',
                a: 'No. Happier is an independent, MIT-licensed open-source project that runs GitHub’s CLI as a subprocess on your computer. It is not affiliated with GitHub and does not resell Copilot.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'qwen',
        slug: 'qwen',
        name: 'Qwen Code',
        vendor: 'Alibaba',
        binary: 'qwen',
        vendorDocs: null,
        vendorSetupGuide: 'https://qwenlm.github.io/qwen-code-docs/',
        happierDocsPath: '/agents/qwen',
        installKind: 'happier-managed-package',
        managedSource: '@qwen-code/qwen-code',
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'Open-source app for Qwen Code',
        standfirst:
            'Qwen Code on your own computer, with the session on your phone. Both halves are open source and neither needs an account with us to be useful.',
        lead: [
            'Qwen Code calls itself “the open-source AI coding agent that lives in your terminal”, and its own repository is candid about where it came from: it started as a fork of Google’s Gemini CLI at v0.8.2 and has developed separately since. Knowing that saves you a guess later: a lot of what the CLI does will look familiar if you have used the other one, and the flags are the place it shows.',
            'Qwen carries a single approval mode of its own, and Happier translates into it at launch rather than layering a policy of its own on top. The command is `qwen --acp --approval-mode`, and the value is `plan` when you chose Read-only or a plan mode, `auto-edit` for Safe YOLO, `yolo` when you have decided you do not want to be asked, and `default` the rest of the time. Change the setting in the app and that flag is what changes, so what the CLI enforces and what the app shows you cannot drift apart.',
            'Sign-in is the same shape: Qwen keeps its authentication behind a slash command, so the provider page starts `qwen` on the computer you picked and types `/auth` into it for you. What Happier will not do is go rummaging afterwards to work out whether it took — some of these commands print credentials to a terminal, so the status probe is left off and the page says Unknown rather than reading something it should not. Tools reach it through the `happier tools` shell bridge instead of native MCP: the same surface, handed over as commands it can run.',
        ],
        whatItDoes: [
            'Qwen Code is Alibaba’s terminal coding agent, distributed as an npm package. `happier qwen` starts it in your repository with the credentials the CLI already has, and does not put a model of its own in the path.',
            'If you are on Qwen because of where your models are hosted rather than because of an editor preference, the useful part here is that nothing about that changes. The agent runs where your code is; Happier only makes the conversation portable.',
        ],
        faq: [
            {
                q: 'How does Qwen Code get installed?',
                a: 'From the `@qwen-code/qwen-code` package. Happier can install it into `~/.happier/tools/providers/qwen/` if you do not already have `qwen` on your PATH, and will use your own copy first when you do.',
            },
            {
                q: 'Where is the official documentation?',
                a: 'Alibaba publishes the Qwen Code docs itself and the link is above; Happier does not mirror them, because a copy of someone else’s install instructions is a copy that goes stale. The Happier-side settings are documented separately.',
            },
            {
                q: 'Does Happier see my prompts?',
                a: 'The transcript is encrypted on your device before it is sent, and the relay stores what it cannot read. If that is still one server too many, the relay is in the same repository and you can run it yourself.',
            },
            {
                q: 'Can I start a session from my phone?',
                a: 'Yes, as long as the Happier CLI is running on the computer that holds the repository. You pick the machine, the directory and the agent from the app, and the process starts over there.',
            },
            {
                q: 'What happens to a session if I close the app?',
                a: 'It keeps going. The agent is a process on your computer, not something the app is hosting — closing the phone app is closing a window onto it, and reopening it puts you back where the session got to.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'kimi',
        slug: 'kimi',
        name: 'Kimi CLI',
        vendor: 'Moonshot AI',
        binary: 'kimi',
        vendorDocs: 'https://code.kimi.com',
        vendorSetupGuide: 'https://kimi.moonshot.cn/docs/cli',
        happierDocsPath: '/agents/kimi',
        installKind: 'vendor-script',
        managedSource: null,
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'Kimi CLI from your phone, browser or desktop',
        standfirst:
            'Moonshot’s terminal agent stays on your computer. The conversation goes wherever you go, encrypted on the way.',
        lead: [
            'Kimi is the one Happier will not upgrade for you, and that is worth knowing on day one rather than on the day a release goes out. Moonshot distributes it with an install script rather than a package, so there is no managed copy under `~/.happier/` for Happier to bump — the version on your PATH is the version you last installed, and getting a newer one means running Moonshot’s installer again yourself.',
            'The second thing that is particular to this one is how a read-only session is made read-only. Kimi has no flag for it, so Happier writes a small Kimi agent definition of its own — one that extends Kimi’s default agent and removes its shell, write-file and string-replace tools — and starts the CLI with that file. The launch is `kimi --work-dir` pointed at the directory you chose, then `acp`, with `--yolo` added when you have turned approvals off. So Read-only here is enforced by the agent’s own tool list rather than by something outside it deciding what to veto.',
            'Signing in is a slash command: the provider page starts `kimi` on the computer you picked and sends it `/setup`. Afterwards Happier does not go looking for confirmation — some of these status commands print tokens to a terminal, so the probe is left off and the page shows Unknown rather than reading something it has no business reading. If the session does hit an authentication error, that is where you find out: a 401 on the way out of the CLI is turned into a plain instruction to run `kimi login` and try again, instead of a stack trace in a log you were not watching.',
        ],
        whatItDoes: [
            'Kimi CLI is Moonshot AI’s terminal coding agent, driving Kimi models against your repository. `happier kimi` runs the binary you already installed, in the directory you point it at, with your own Kimi account.',
            'The part Happier adds is unglamorous and is the whole reason people install it: the session does not end when you leave the desk. Read it on a phone, answer a permission request, send the next instruction, and let it keep working on the computer that has the code.',
        ],
        faq: [
            {
                q: 'How do I install Kimi CLI?',
                a: 'Moonshot distributes it with an install script rather than through a package manager, so the version you have is the version you last installed. Happier detects the binary on your PATH and will not run a vendor install script on its own.',
            },
            {
                q: 'Will Happier update it for me?',
                a: 'No. There is no Happier-managed package for Kimi, so upgrades are re-running Moonshot’s installer when you want a newer build. Happier does not pin a version or shim one in front of yours.',
            },
            {
                q: 'Does the session survive my laptop restarting?',
                a: 'Happier can resume sessions after a restart when the agent supports it, and archives the ones it cannot. What it will not do is pretend the process kept running — if the computer went away, the session was not running while it was gone.',
            },
            {
                q: 'Can I add my own MCP servers?',
                a: 'Yes. MCP servers are defined once in Happier and reused across agents, machines and sessions, with a preview of the effective tool surface before a session starts.',
            },
            {
                q: 'Is any of this behind a paywall?',
                a: 'No. Every Happier client and the relay are MIT-licensed and free, with no seat count and no feature gate. The only bill is the one Moonshot already sends you.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'kilo',
        slug: 'kilo',
        name: 'Kilo CLI',
        vendor: 'Kilo',
        binary: 'kilo',
        vendorDocs: 'https://kilo.ai/docs/cli',
        vendorSetupGuide: null,
        happierDocsPath: '/agents/kilo',
        installKind: 'happier-managed-package',
        managedSource: '@kilocode/cli',
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'Kilo CLI on your phone, laptop and browser',
        standfirst:
            'One open-source app for Kilo and the twelve other command-line coding agents you might have installed.',
        // "Experimental" is the shipped PRODUCT's own word for this provider,
        // not a docs page's: the backend picker renders the row as "Kilo CLI
        // (experimental)" (remote-dev/apps/ui/sources/text/translations/
        // en.ts:9816, used by apps/ui/sources/agents/providers/kilo/core.ts),
        // and the released manifest declares `tools: { delivery:
        // 'shell_bridge', support: 'experimental' }`
        // (remote-dev/packages/agents/src/manifest.ts:317).
        lead: [
            'Kilo is an experimental provider in Happier, and this page says so up front rather than at the bottom. What that means in practice is narrow: the install is an ordinary npm package, the session is an ordinary subprocess, and the parts people install Happier for — transcript, diffs, approvals on every device — are the ordinary ones. It does mean the provider sits behind the experimental rollout in the app’s provider settings, so it is a switch you turn on rather than a row that is already there.',
            'Kilo’s own pitch is orchestration — “plan, debug, and code fast with keyboard-first navigation on the command line”, with Architect, Ask, Debug and Orchestrator modes and its own gateway to a large model catalogue. Happier does not put a model in front of any of that; what it does is speak the same permission dialect Kilo already understands. Approvals arrive as an `OPENCODE_PERMISSION` object in the environment of the process, the same one the OpenCode family reads, so a Read-only or Safe YOLO choice made on a phone is enforced by the CLI’s own policy rather than by something guessing on its behalf.',
            'One approval detail is worth knowing before it surprises you. When you allow a Kilo tool call, Happier picks the “allow for this session” option rather than “allow once”, because the once-only choice was observed to leave the tool call hanging. The other thing to expect is the first start: Kilo can install plugins and fetch model metadata the first time it comes up over the protocol, so the launch is given ninety seconds before it is called a failure, and if the plugin step is what failed you are told to run `kilo` once in a terminal instead of being shown its stderr. Its login is a slash command too — the provider page opens Kilo and sends `/connect`.',
        ],
        whatItDoes: [
            'Kilo CLI is a terminal coding agent installed as an npm package. `happier kilo` runs it in your repository under your own Kilo account, as a plain subprocess on your computer.',
            'From there it behaves like everything else in Happier: the transcript, the diffs and the approval requests are on every device you are signed in on, and the code never leaves the computer the agent is running on.',
        ],
        faq: [
            {
                q: 'How does Kilo get onto my computer?',
                a: 'From the `@kilocode/cli` package. If `kilo` is already on your PATH, Happier runs that; if it is not, Happier can install the package into `~/.happier/tools/providers/kilo/` and keep it out of your global npm prefix.',
            },
            {
                q: 'Does Happier replace Kilo’s own settings?',
                a: 'No. Kilo keeps its configuration where Kilo keeps it. What Happier owns is the session layer around it — permission defaults, MCP servers, engine selection — and those are documented on the Kilo page in the Happier docs.',
            },
            {
                q: 'Can I use Kilo from a browser?',
                a: 'Yes. app.happier.dev is a full client, including the file browser and the diff view, so a locked-down laptop with nothing installed on it can still read and steer a session running elsewhere.',
            },
            {
                q: 'How is this different from SSH into a tmux session?',
                a: 'It is not trying to replace it. tmux over SSH is fine when you have SSH and a keyboard. This is for the times you have a phone and a five-minute gap: a touch UI for approvals, diffs and follow-up instructions rather than a terminal you pinch to zoom.',
            },
            {
                q: 'Who can see my sessions?',
                a: 'You, on your own signed-in devices, plus anyone you deliberately share a session with. The transcript is end-to-end encrypted, so the server carrying it — ours or your own — is holding ciphertext.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'kiro',
        slug: 'kiro',
        name: 'Kiro CLI',
        vendor: 'AWS',
        binary: 'kiro-cli',
        vendorDocs: 'https://kiro.dev/docs/cli/acp/',
        // The released registry carries no `installGuideUrl` for kiro, and the
        // `docsUrl` it does carry is the ACP protocol page — the right page for
        // how Happier talks to it, the wrong one for a reader who has to install
        // it. Kiro is the ONE agent with installKind 'you-install-it', so this
        // link is the only install instruction the page gives. AWS's own
        // installation page is where the CLI install lives: `curl -fsSL
        // https://cli.kiro.dev/install | bash`, the CLI platform list ("macOS,
        // Windows 11 (PowerShell), or Linux (glibc 2.34+ or musl variant)"),
        // then `kiro-cli login` and `kiro-cli doctor`. Verified August 2026 —
        // kiro.dev/docs/cli/installation/ redirects here, and kiro.dev/docs/cli/
        // setup/ links here for the install step.
        vendorSetupGuide: 'https://kiro.dev/docs/getting-started/installation/',
        happierDocsPath: '/agents/kiro',
        installKind: 'you-install-it',
        managedSource: null,
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'native-mcp',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'Run Kiro CLI from anywhere you are',
        standfirst:
            'AWS’s agentic CLI, running under your own AWS identity on your own computer, with an app in front of it.',
        lead: [
            'Kiro is the one agent on this list Happier has no install path for at all. There is no managed package, no release binary and no vendor recipe it can offer to run — you install `kiro-cli` the way AWS documents and Happier picks it up from your PATH afterwards.',
            'It is also a built-in Agent Client Protocol provider, launched as `kiro-cli acp` on a transport profile written for it. That distinction matters more than it sounds: Happier has a generic door for any CLI that speaks the protocol, and Kiro does not go through it. The built-in entry declares up front that this CLI can load an existing session, that it advertises real modes and models, and that it will take images in a prompt — so the app renders those controls because the integration says they exist, not because it hopes. Kiro turns up in the ACP backends screen for the same reason, and you can safely leave it alone there; the provider page is the one to use.',
            'Everything about identity stays with AWS. Happier holds no AWS credential for this one, launches the CLI as a subprocess, and lets it resolve your identity exactly as it does when you run it yourself; the provider page can start `kiro-cli login` on the computer you picked, which is a convenience rather than a broker. MCP servers you defined in Happier reach it as native tools rather than through the shell bridge, and resume is offered as experimental — a session identity Happier stored and can ask the CLI to pick up again, rather than a promise that it always will.',
        ],
        whatItDoes: [
            'Kiro is AWS’s agentic development CLI, and its documentation is explicitly about the Agent Client Protocol — convenient, because that is the protocol Happier speaks to it over. `happier kiro` runs the `kiro-cli` binary in the repository you point it at.',
            'Everything about your AWS identity stays where it already was. Happier starts the process on your own computer, carries the conversation to your other devices encrypted, and gets out of the way. There is no gateway between the CLI and AWS, and nothing about your account is copied anywhere.',
            'The computer running it does not have to be the one in front of you. A development box, an EC2 instance or a machine in a cupboard is fine — install the Happier CLI there, start the session, and read it from a phone.',
        ],
        faq: [
            {
                q: 'Does Happier install Kiro for me?',
                a: 'No — Kiro is the one agent here with no install path inside Happier at all. Install `kiro-cli` the way AWS documents, and Happier finds it on your PATH afterwards.',
            },
            {
                q: 'The binary is kiro-cli, not kiro — does that matter?',
                a: 'Only for detection. Happier looks for `kiro-cli` on your PATH, because that is the name AWS ships. The subcommand you type stays `happier kiro`.',
            },
            {
                q: 'Can I run it on an EC2 box and use it from my phone?',
                a: 'Yes. Install the Happier CLI on that box, start the session there, and open it from any signed-in device. Nothing on the remote end needs a display.',
            },
            {
                q: 'Does Happier need AWS credentials?',
                a: 'No. Happier launches `kiro-cli` as a subprocess and the CLI resolves your AWS identity itself, exactly as it does when you run it directly. Nothing about that reaches a Happier server.',
            },
            {
                q: 'What if my organisation will not allow a third-party relay?',
                a: 'Run your own. The relay is in the same MIT-licensed repository, deploys with Docker against PostgreSQL, SQLite or MySQL, and can be locked to your organisation with GitHub OAuth org gating, OIDC or mTLS.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'auggie',
        slug: 'auggie',
        name: 'Auggie',
        vendor: 'Augment Code',
        binary: 'auggie',
        vendorDocs: 'https://augmentcode.com',
        // `docsUrl` in the released registry is the marketing homepage, which is
        // the exact defect setupLinkFor() exists to route around. Augment Code's
        // own install page documents the package Happier manages
        // (`npm install -g @augmentcode/auggie`), the Node floor, the supported
        // platforms (macOS, Windows WSL, Linux) and the shells, then `auggie
        // login`. Verified August 2026.
        vendorSetupGuide: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
        happierDocsPath: '/agents/augment',
        installKind: 'happier-managed-package',
        managedSource: '@augmentcode/auggie',
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        h1: 'Auggie, on your phone and your desktop',
        standfirst:
            'Augment Code’s CLI, running on your own computer under your own Augment entitlement, with the conversation on every device you own.',
        lead: [
            'Auggie is the agent whose two names catch people out. The CLI is Auggie; the vendor is Augment Code; the Happier documentation page is filed at `/providers/augment` and is the same page. Underneath the naming it is an npm install of `@augmentcode/auggie`, run under whichever Augment entitlement that computer is signed in with. Augment Code’s own framing is that it puts agentic coding “in your terminal, on your server, or anywhere your code runs”, which is the half of the product Happier is here for.',
            'Indexing is the setting to know about. Auggie can index a repository, and Happier does not turn that on for you: the flag is added only when `HAPPIER_AUGGIE_ALLOW_INDEXING` is set in the environment of the session, so a repository you have not decided about is one it has not indexed. It is opt-in per environment rather than a global preference, which is the right shape for the case where one of your computers holds work code and another does not.',
            'Permissions are the other thing this integration does its own way, because Auggie wants them tool by tool. Happier expands a single choice into a `--permission` rule for every tool the CLI publishes — its editing and file tools, its process tools, web search and fetch, its task list, and its named sub-agents for reviewing code, building components, designing databases and writing tests. Read-only adds Auggie’s own ask mode and then denies the editing and process tools by name on top of it, rather than trusting one flag to cover both. Tools going the other way arrive through the `happier tools` shell bridge, since Auggie takes no MCP inventory directly.',
        ],
        whatItDoes: [
            'Auggie is Augment Code’s command-line agent. `happier auggie` runs it against your repository from an npm-installed binary, with the account the CLI is already signed in with.',
            'What you get for putting Happier in front of it is portability and one place for the interruptions: the transcript on a phone, the diff on a tablet, and the permission requests from every agent you run collected in a single inbox instead of scattered across terminal windows.',
        ],
        faq: [
            {
                q: 'How is Auggie installed?',
                a: 'From the `@augmentcode/auggie` package. Happier prefers the `auggie` on your PATH and can install the package into its own directory under `~/.happier/` when there is not one.',
            },
            {
                q: 'Why does the Happier docs page say Augment?',
                a: 'Because the docs page is named after the vendor and the CLI is named after the agent. Same thing: `/providers/augment` in the Happier docs is the Auggie page.',
            },
            {
                q: 'Does Augment Code see anything extra because I use Happier?',
                a: 'No. The CLI makes the same calls to Augment it makes when you run it in a terminal yourself. Happier reads the process output on your computer and encrypts it before it goes to any device of yours.',
            },
            {
                q: 'Can I move a session to a different computer?',
                a: 'You can always read and answer a session from any device. Moving the live session onto a different computer is a per-agent capability, and the Happier docs page on session handoff is the accurate place to check which agents have it today.',
            },
            {
                q: 'Do I need an account with Happier?',
                a: 'You need a Happier account to sync sessions between devices, and that account can live on a server you run. The CLI, the apps and the server are all in one MIT-licensed repository.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'pi',
        slug: 'pi',
        name: 'Pi Coding Agent',
        vendor: 'Pi',
        binary: 'pi',
        vendorDocs: null,
        vendorSetupGuide: 'https://github.com/badlogic/pi-mono',
        happierDocsPath: '/agents/pi',
        installKind: 'happier-managed-package',
        managedSource: '@earendil-works/pi-coding-agent',
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'shell-bridge',
            connectedServices: ['openai-codex', 'openai', 'claude-subscription', 'anthropic'],
            terminalPromptInjection: false,
        },
        h1: 'Open-source app for the Pi Coding Agent',
        standfirst:
            'Pi brings its own keys and no model of its own. Happier brings the phone, the browser and the desktop app, and no server in the middle.',
        // Same anchor as Kilo for the experimental label — the app's backend
        // picker renders "Pi CLI (experimental)"
        // (remote-dev/apps/ui/sources/text/translations/en.ts:9820, used by
        // apps/ui/sources/agents/providers/pi/core.ts). Stated as a fact about
        // the provider rather than as a citation of our docs.
        lead: [
            'Pi ships no model, which turns out to be the interesting fact about running it here: every agent credential Happier holds is one Pi will take. Claude-subscription profiles, Anthropic keys, Codex logins and OpenAI keys all work, so the accounts you pooled because you use Claude Code can drive this too — chosen when the session starts rather than decided by whatever that computer was last logged into.',
            'The mechanism is worth a sentence because it explains what does and does not move. Before launch Happier writes the profile you picked into Pi’s own isolated credentials file, in the shape Pi expects: a subscription login becomes an OAuth credential, a setup token or an API key becomes a key. Pi then reads its own file and talks to the provider directly, with no request of yours routed through anything of ours. If several of your profiles fit, the app asks which one rather than picking for you.',
            'There is no sign-in button for this one, and that is Pi rather than an omission: it exposes no interactive login for Happier to drive, so the provider page reports the environment-backed credentials that computer already carries and stops there. Steering does work — a message sent into a turn that is already running is taken by the agent instead of waiting behind it — while typing into a vendor terminal is not something this agent offers. Pi is an experimental provider in Happier, which is the state to read it in.',
        ],
        whatItDoes: [
            'Pi is a bring-your-own-key terminal coding agent: it does not ship a model, it drives whichever provider you have credentials for. `happier pi` runs it in your repository with the environment your shell already has.',
            'That fits the way Happier works, because Happier does not hold those keys either. The agent process reads them on your computer, talks to the provider directly, and the only thing that crosses the network is an encrypted transcript going to your own devices.',
            'So the shape of a Pi session is: your keys, your computer, your repository, and a phone in your pocket that can read the conversation and answer it. Nothing in that list is rented from us, and the relay in the middle is one you can run yourself if you would rather not use ours.',
        ],
        faq: [
            {
                q: 'How do I install Pi?',
                a: 'From the `@earendil-works/pi-coding-agent` package. Happier will use a `pi` already on your PATH first and can otherwise install the package into `~/.happier/tools/providers/pi/`.',
            },
            {
                q: 'Where do my API keys live?',
                a: 'In your own environment on your own computer, which is where Pi reads them. Happier starts the process and does not copy, store or forward provider keys.',
            },
            {
                q: 'Is this the same as oh-my-pi?',
                a: 'No — different project, different binary. oh-my-pi ships as `omp` from its own repository, and Happier does not run it in the version you can install today. It is coming in the next version, so it is something we are working on rather than something we support; this page is about `pi`.',
            },
            {
                q: 'Can I switch models mid-session?',
                a: 'Happier exposes the models the agent reports and asks it to switch rather than shipping a list of its own. Whether a change lands on the current turn or the next one is the agent’s behaviour, and the app tells you which it is before you commit to it.',
            },
            {
                q: 'Does it work on an iPad?',
                a: 'Yes — the iOS app runs on iPad, and app.happier.dev works in Safari if you would rather not install anything. Both are clients onto the session running on your computer.',
            },
        ],
    },
    {
        availability: 'shipped',
        id: 'grok',
        slug: 'grok',
        name: 'Grok Build',
        vendor: 'xAI',
        binary: 'grok',
        vendorDocs: 'https://x.ai',
        vendorSetupGuide: 'https://x.ai/cli',
        happierDocsPath: '/agents/grok',
        installKind: 'vendor-script',
        managedSource: null,
        runtime: {
            localControl: { kind: 'none' },
            toolsDelivery: 'native-mcp',
            connectedServices: [],
            terminalPromptInjection: false,
        },
        // Experimental is the product's own word here too: the backend picker
        // row is "Grok Build CLI (experimental)"
        // (remote-dev/apps/ui/sources/text/translations/en.ts:9819), and the
        // released manifest declares `tools: { delivery: 'native_mcp', support:
        // 'experimental' }` with `resume.vendorResume: 'experimental'` under a
        // `runtime_checked` policy (packages/agents/src/manifest.ts:479-492).
        // The four unsupported capabilities the copy names are the
        // `sessionCapabilities` / `handoff` blocks at :485-490.
        h1: 'Grok Build CLI from your phone or your desk',
        standfirst:
            'xAI’s coding CLI, running on your own computer with your own xAI account. The Happier integration is experimental, and this page says so before you install anything.',
        lead: [
            'Grok Build carries the longest list of things Happier cannot do with it, and the list is specific rather than vague: no session listing, no forking, no rollback, no vendor-state handoff. Happier launches `grok` in an update-safe Agent Client Protocol mode — the CLI’s auto-update is switched off for the session, so a release landing mid-conversation cannot change the program you are talking to — and hands it MCP servers natively, though that path is marked experimental too.',
            'The quirk that looks alarming and is not: Grok gives Happier no reliable non-interactive way to check a cached login, so the provider page shows “Unknown” for it. That is a missing signal, not a verdict — the protocol handshake validates the account for every session independently, so a session that starts is a session that authenticated. There is also a second way in for a computer you cannot open a browser on: alongside the ordinary login, the provider page can run the device-code flow, which is the difference between signing in to a headless box and giving up on it. An `XAI_API_KEY` in the environment is honoured too, and Happier keeps the value out of session metadata and logs.',
            'Two more places the integration is deliberately literal. Models are only the ones the running session advertises: a reasoning-effort control appears for a model that says it has one, no fallback model id is invented when the CLI offers no inventory, and a switch the CLI rejects is reported as a rejection rather than shown as success. And Grok’s structured questions are drawn as questions — a prompt with no advertised choices takes free text, one with choices can still take an answer of your own, and commas and newlines survive the trip. Happier looks for the binary on your PATH and in `~/.grok/bin`, which is where xAI’s installer puts it.',
        ],
        whatItDoes: [
            'Grok Build is xAI’s coding CLI. `happier grok` runs the `grok` binary in your repository over the Agent Client Protocol, under whichever xAI credentials that computer already has.',
            'This integration is experimental, and these are the limits: session listing, forking, rewind and vendor-state handoff are not supported for Grok today. The Happier docs page linked below is the one to read before you plan a workflow around it.',
        ],
        faq: [
            {
                q: 'What does "experimental" mean here?',
                a: 'It means the integration is shipped and used, and that some of what Happier does with other agents is not wired up for this one. The Happier docs page for Grok Build lists the current limits explicitly rather than leaving you to discover them.',
            },
            {
                q: 'Can Happier fork or rewind a Grok conversation?',
                a: 'No. Session listing, forking, rollback and vendor-state handoff are not supported for Grok Build in the shipped build, and Happier does not fake them by replaying a transcript into a new session — a reconstruction would quietly lose whatever the agent knew and had not said.',
            },
            {
                q: 'How do I install the CLI?',
                a: 'xAI distributes it with an install script, linked above. Happier looks for `grok` on your PATH, including `~/.grok/bin`, and will not execute a vendor install script unattended.',
            },
            {
                q: 'Which xAI account does it use?',
                a: 'Whichever one the `grok` CLI is signed in with on that computer, or the API key in that process’s environment. Happier does not hold xAI credentials and does not proxy the model call.',
            },
            {
                q: 'Should I use this or one of the other twelve?',
                a: 'Depends entirely on which model you want and what you already pay for. Happier runs all thirteen from the same app, so trying Grok Build does not mean giving up the session list you already have.',
            },
        ],
    },
];

/** Slug → record, for the route table and the page components. */
export const AGENTS_BY_SLUG: ReadonlyMap<string, AgentRecord> = new Map(
    AGENTS.map((agent) => [agent.slug, agent]),
);

/**
 * Per-agent <title> and meta description.
 *
 * Kept beside the records rather than generated from a template because a
 * template is exactly what a search engine reads as a doorway set: thirteen
 * titles differing by one noun. `routes.test.ts` asserts the titles fit and
 * that no two routes share one.
 *
 * There is no per-provider search-volume data behind these — the Semrush plan
 * this site had lost its MCP access, and inventing a number to justify a title
 * would be worse than having none. They are chosen by INTENT SHAPE instead, and
 * the shapes are deliberately mixed rather than templated:
 *
 *   "open-source app for X"   claude-code, opencode, qwen, pi
 *   "X on/from my phone"      codex, kimi, auggie, kilo, grok
 *   "run X from …"            cursor, kiro
 *   "X on every device"       gemini, github-copilot
 */
export const AGENT_META: Record<string, { title: string; description: string }> = {
    'claude-code': {
        title: 'Open-source app for Claude Code — Happier',
        description:
            'Run Claude Code on your own computer and drive it from your phone, browser or desktop. Open-source, end-to-end encrypted, self-hostable, MIT-licensed.',
    },
    codex: {
        title: 'Codex CLI on your phone — open-source Happier',
        description:
            'The openai/codex CLI runs on your computer under your own ChatGPT subscription or API key. Read, approve and steer it from any device. Free, open-source.',
    },
    opencode: {
        title: 'Open-source app for OpenCode — phone and desktop',
        description:
            'OpenCode runs on hardware you control, with your own opencode auth credentials. Happier adds phone, browser and desktop clients over a self-hostable relay.',
    },
    cursor: {
        title: 'Run Cursor Agent CLI from your phone — Happier',
        description:
            'The headless cursor-agent binary on your own computer or server, with the conversation, diffs and approvals on your phone. Open-source and MIT-licensed.',
    },
    gemini: {
        title: 'Gemini CLI on every device — Happier',
        description:
            'Google’s open-source terminal agent runs in your own environment, including your own Cloud project. Happier carries the session to your phone, encrypted.',
    },
    'github-copilot': {
        title: 'GitHub Copilot CLI from your phone — Happier',
        description:
            'Run the Copilot command-line agent on your computer or build box and drive it from anywhere. Independent open-source client, not a GitHub product.',
    },
    qwen: {
        title: 'Open-source app for Qwen Code — Happier',
        description:
            'Qwen Code runs on your own computer with your own account. Happier puts the session on your phone, browser and desktop over an encrypted relay you can run.',
    },
    kimi: {
        title: 'Kimi CLI from your phone, browser or desktop',
        description:
            'Moonshot’s terminal coding agent stays on your computer while you read and steer it from anywhere. Free, MIT-licensed and end-to-end encrypted.',
    },
    kilo: {
        title: 'Kilo CLI on your phone, laptop and browser',
        description:
            'One open-source app for Kilo CLI and twelve other command-line coding agents, on your own computers with your own accounts. No seats, no feature gate.',
    },
    kiro: {
        title: 'Run Kiro CLI from anywhere — Happier',
        description:
            'AWS’s agentic CLI on your own computer or EC2 box, under your own AWS identity, with the session readable from a phone. Open-source, self-hostable relay.',
    },
    auggie: {
        title: 'Auggie on your phone and desktop — Happier',
        description:
            'Augment Code’s CLI runs on your own computer under your own entitlement. Happier collects its transcript and approvals alongside your other agents.',
    },
    pi: {
        title: 'Open-source app for the Pi Coding Agent',
        description:
            'Pi brings your own API keys; Happier brings the phone, browser and desktop clients. Neither holds your keys on a server. MIT-licensed and self-hostable.',
    },
    grok: {
        title: 'Grok Build CLI from your phone — Happier',
        description:
            'xAI’s coding CLI on your own computer, driven from any device. The integration is experimental and this page names what it does not support yet.',
    },
};
