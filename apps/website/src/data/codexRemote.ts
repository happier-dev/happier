import { AGENTS } from './agents';

/**
 * /vs/codex-remote — the Codex half of the comparison pair.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM comparison.ts
 * --------------------------------------------------
 * comparison.ts owns Anthropic's Remote Control and the homepage positioning
 * section. This owns OpenAI's. They are deliberately not merged into one
 * "competitors" file: the two vendors publish different things, the evidence
 * trails are different, and a shared file is how a claim about one vendor ends
 * up being edited to match the shape of a sentence about the other.
 *
 * NAMING — READ THIS BEFORE EDITING ANY STRING BELOW.
 *   • "Codex Remote" is OpenAI's own name. learn.chatgpt.com/docs/remote is
 *     titled "Codex Remote"; the H1 on it is "Remote: Start, guide, and review
 *     coding tasks from your phone". We are citing their label, not minting one.
 *   • There is NO product called "Codex Mobile". OpenAI put Codex inside the
 *     ChatGPT mobile app. Describe it — "Codex reaches your phone through the
 *     ChatGPT app" — never christen it. A capitalised product name we invented
 *     is the single fastest way to lose a reader who uses the thing daily.
 *   • "computer" is the reader's device. "machine" is the Happier UI noun.
 *
 * EVIDENCE RULE — the same one comparison.ts runs under.
 *   • Every Codex statement restates OpenAI's own published documentation:
 *     learn.chatgpt.com/docs/remote, /docs/remote-connections, /docs/cloud,
 *     /docs/cli and /docs/pricing. Fetched and verified August 2026. Nothing is
 *     inferred, benchmarked, or characterised for quality, and nothing here
 *     comes from press coverage of the May 2026 launch — several widely
 *     repeated details in that coverage are not in OpenAI's docs.
 *   • Every Happier statement is traceable to SHIPPED source in remote-dev.
 *     Anchors are named inline. Nothing from the unreleased tree appears on
 *     this page in the present tense.
 *
 * WHAT MUST NOT COME BACK:
 *   • An imperative that sends the reader to the competitor ("use it", "go and
 *     set that up instead"). Conceding accurately is the job; issuing the
 *     instruction is the page arguing itself out of existence. codexRemote.test.ts
 *     fails the build on the imperative forms.
 *   • "No vendor will ship a client for a rival's CLI." False — Zed ships
 *     Claude, Codex, OpenCode, Copilot, Cursor and Pi Coding Agent as external
 *     agents over ACP (zed.dev/docs/ai/external-agents).
 */

const OTHER_AGENTS = AGENTS.length - 1;

export const CODEX_SECTION = {
    /**
     * The concession. Substantive, specific, and quotable straight off OpenAI's
     * documentation — a vague concession is not a concession. It ends by naming
     * the setup Codex Remote fully covers, in the indicative. Not the
     * imperative: this page does not hand out instructions to go elsewhere.
     */
    concession:
        'OpenAI ships a remote for Codex, and it is good. Its own documentation calls it Remote, and describes it in one line: follow progress, approve actions and send instructions from your phone, while Codex runs each task on your connected computer. Setup is a QR scan — open the ChatGPT desktop app on your Mac or Windows PC, go to Settings → Connections → “Control this Mac or PC”, approve remote access, and scan the code with a phone signed in to the same account and workspace. From then on the four things OpenAI lists are all on the phone: start tasks, guide work as it happens, approve requested actions, review the result. Codex itself is included with ChatGPT subscriptions, so for most people none of this is a new bill. If Codex is the whole of your workflow and the computer holding your code is a Mac or a Windows PC, that is a complete answer, and nothing further down this page is an argument that it is not.',
    /** The turn. Names the reader's situation; does not attack the product. */
    turn: `This page is about the rest of it: the conditions OpenAI’s documentation puts on Remote, the part of Codex that runs in OpenAI’s cloud rather than on a computer you own, and the ${OTHER_AGENTS} other agents neither surface was built to reach.`,

    /**
     * What Codex's own remote does well, on the record.
     *
     * Every entry survives a read of the source page, including the one that
     * costs us something: Codex cloud is a real product with a real advantage
     * Happier does not have, and saying so is the reason the rest is credible.
     */
    strengths: [
        {
            id: 'phone',
            title: 'Four verbs, all of them on the phone',
            body: 'OpenAI’s Remote page lists what the phone is for: start tasks, guide work as it happens, approve requested actions, review the result. The work does not move — “Codex runs each task on your connected computer” — so the phone is a control surface rather than a second place your code ends up.',
        },
        {
            id: 'setup',
            title: 'Pairing is a QR scan and a permission prompt',
            body: 'Settings → Connections → “Control this Mac or PC” in the ChatGPT desktop app, approve remote access, scan the code. The phone has to be signed in to the same account and workspace, and OpenAI’s own step list ends with the honest one: keep your computer awake and online.',
        },
        {
            id: 'ssh',
            title: 'It reaches an SSH host, not only the computer in front of you',
            body: 'Per OpenAI’s remote-connections page, Codex reads concrete host aliases from `~/.ssh/config`, resolves them with OpenSSH, and ignores pattern-only hosts. A devbox you already have in your SSH config is discoverable rather than something you have to set up twice.',
        },
        {
            id: 'cloud',
            title: 'Codex cloud does a thing Happier does not do at all',
            body: 'Separately from Remote, Codex runs tasks in isolated cloud environments, in parallel, with per-repository setup steps, dependencies and variables — started from the web, from GitHub, from Linear or from Slack. Happier has no equivalent and is not going to pretend otherwise: every Happier session runs on a computer you own. Work on a repository you have not cloned anywhere is what a cloud environment is for.',
        },
        {
            id: 'plan',
            title: 'It comes with a subscription you may already have',
            body: 'OpenAI’s pricing page states that ChatGPT Work and Codex are included in the Free, Go, Plus, Pro, Business, Edu and Enterprise plans. Two things the same documentation adds: Remote availability depends on rollout and your workspace settings, and inside a managed workspace an admin may need to enable Remote Control access before a phone can connect at all.',
        },
    ],

    /**
     * The documented conditions, each paired with what Happier does instead.
     *
     * These are requirements OpenAI publishes, not limitations found by
     * testing, and the pairing is deliberately not a scoreboard: the third one
     * concedes that Happier has exactly the same problem, because it does. The
     * playbook's hard constraint is explicit — never claim Happier fixes
     * something Happier can also experience.
     */
    conditions: [
        {
            // THIS CONDITION CONTRADICTED THE STRENGTH THREE ITEMS ABOVE IT.
            // It read "The computer holding your code runs Linux", while the
            // `ssh` strength on the same page says Remote reaches an SSH host —
            // which is how a Linux box is reached. OpenAI's own pages settle it:
            // learn.chatgpt.com/docs/remote-connections says "Remote supports
            // hosts running the ChatGPT desktop app on macOS and Windows", and
            // its "Connect to an SSH host" section requires you to "confirm you
            // can SSH to the host from the machine running the app" and that
            // "the `codex` command is available on the remote host's PATH" —
            // the app "starts the remote Codex app server through SSH". So the
            // Linux box is reachable, but only as an SSH target of a Mac or
            // Windows computer that is running the desktop app and is paired to
            // the phone. The constraint is the Mac or PC in the middle, not the
            // Linux box at the end, and that is what this now says.
            id: 'hostOs',
            when: 'There is no Mac or Windows PC in the chain.',
            codex: 'Per OpenAI’s docs, Remote supports hosts running the ChatGPT desktop app on macOS and Windows, and that desktop app is what the phone pairs with. A Linux computer is reachable from it as an SSH target — OpenAI’s remote-connections page asks you to confirm you can SSH to the host from the computer running the app, and that `codex` is on the remote host’s PATH — so the Mac or PC stays in the chain even when the code does not live on it.',
            happier:
                'The Happier CLI installs on macOS, Linux and Windows, and every computer you install it on becomes a machine a session can be started on directly. The Linux box in the corner is a machine in its own right rather than something reached through a laptop that also has to be awake.',
        },
        {
            id: 'setupPath',
            when: 'You live in the terminal and want the session you already started.',
            codex: 'Per OpenAI’s docs, mobile setup starts from the app: “you can’t set it up from the Codex CLI or IDE extension.” Pairing is a desktop-app flow.',
            happier:
                'Start a session with `happier codex` in a repository and it is already reachable from the app, the web and your phone — there is no second pairing step per session, because the pairing is between you and your own machines rather than between two apps.',
        },
        {
            id: 'awake',
            when: 'Your computer is asleep.',
            codex: 'OpenAI’s setup steps say to keep your computer awake and online, and the host must stay signed in to the same account and workspace.',
            happier:
                'Happier does not solve this, and a page that claimed otherwise would be lying to you: a session runs on a real computer, and a sleeping computer runs nothing. What changes is which computer has to be awake. Sessions are created against a machine, so the always-on box can hold the long run while the laptop in your bag is shut.',
        },
        {
            id: 'workspace',
            when: 'You are inside a managed ChatGPT workspace.',
            codex: 'Per OpenAI’s docs: “If you use Codex through a ChatGPT workspace, your admin may need to enable Remote Control access before you can connect from your phone.”',
            happier:
                'The equivalent switch is one your organisation holds rather than one it asks for: `happier relay host install` puts the relay on hardware you own, gated by your GitHub org or OIDC groups, and the transcript is end-to-end encrypted before it reaches it.',
        },
        {
            id: 'cloudHandoff',
            when: 'You want to move a running task into the cloud, or back out of it.',
            codex: 'Per OpenAI’s docs, “Handoff to a Codex cloud environment isn’t supported.” Remote drives the computer you connected; Codex cloud is a separate surface with its own environments.',
            // "…which is how our own docs put it" was the old tail, and it cited
            // our own source material about our own product — the sentence
            // sounded like someone reporting on Happier rather than someone who
            // builds it. The caveat stays; the citation moved here, and it now
            // points at the code rather than the docs page:
            // packages/agents/src/manifest.ts — handoff.vendorStateTransfer is
            // 'supported' for claude (:55) and opencode (:195), 'experimental'
            // for codex (:139).
            happier:
                'Happier has no cloud environments to hand off to. What it moves is a live session between computers you own, keeping the same session id — which works for Claude Code and OpenCode, and is experimental on Codex.',
        },
    ],

    /**
     * THE ARGUMENT. Five things that exist because one client runs every agent.
     *
     * Each is verified in shipped source, and the anchor is named in the comment
     * above it so the next person to edit this can re-check it with one grep
     * instead of trusting the file.
     */
    arguments: [
        {
            id: 'oneApp',
            // "Inbox is the place where the app surfaces things that need your
            // attention, even when they come from different parts of the
            // product" — remote-dev/apps/docs/content/docs/features/inbox-and-approvals.mdx
            // Was "One app, not one per vendor." — the positive is the inbox,
            // which is also what the body describes. Kept identical to the
            // Claude page's version of this card on purpose: it is the same
            // argument, and two wordings of one claim is how one of them drifts.
            title: 'Every agent in one inbox.',
            body: 'Codex reaches your phone through the ChatGPT app. Claude Code’s remote opens in claude.ai/code or the Claude app. Each vendor’s remote lands inside that vendor’s product, which is fine right up until you use two of them and the approval you are waiting on is in the other one. Happier is a single inbox: every session, on every agent, on every computer you have connected, with one place to answer the permission requests they are all blocked on.',
        },
        {
            id: 'mixAndMatch',
            // subagents.plan.start / subagents.delegate.start take
            // `backendTargetKeys`: "Select the agent provider/backend targets to
            // use." Multiselect, required.
            // remote-dev/packages/protocol/src/actions/actionSpecs.ts:1205,1276
            title: 'Mix and match inside one workspace.',
            body: 'A Codex session can hand the review to a delegate run on Claude Code while a third agent reads a stack trace, and you can steer any of them mid-run. Happier’s plan, review and delegate runs take an explicit list of provider targets rather than whichever provider you happen to be sitting in. A remote built by one vendor drives that vendor’s agent; that is what it is for.',
        },
        {
            id: 'accounts',
            // Connected services are keyed by CREDENTIAL, not by agent:
            // ConnectedServiceIdSchema = openai-codex, openai, anthropic,
            // claude-subscription, gemini, github
            // (packages/protocol/src/connect/connectedServiceBindings.ts:3).
            // Codex consumes openai-codex + openai; OpenCode consumes
            // openai-codex, openai, claude-subscription and anthropic
            // (packages/agents/src/manifest.ts). Switching is bounded:
            // maxSwitchesPerTurn default 1, maxSwitchesPerSessionHour default 3
            // (connectedServiceSchemas.ts:519-520). Quota snapshots exist for
            // openai-codex, claude-subscription and gemini, behind the
            // `connectedServices.quotas` gate (docs/features/connected-services.mdx).
            // Was "Your accounts, pooled, with the meters showing." — a caption,
            // not a heading. See the note on the matching card in comparison.ts.
            title: 'Choose the account. See what is left.',
            body: 'Connect more than one profile per service — a personal Codex subscription and a work one, an OpenAI key — and pick which one a session runs on when you start it. Pools are pools of accounts rather than of agents: the same Codex subscription is usable by any agent that runs on it, OpenCode included. Where the quota surface is enabled, Codex, Claude and Gemini profiles carry a usage snapshot in the auth picker, so you can see what is left before committing a long run to it. When a pool does move a running session to another account, it is bounded — at most once a turn and three times a session hour by default — and mid-session switching is Claude Code and Codex only.',
        },
        {
            id: 'terminal',
            // remote-dev/apps/docs/content/docs/providers/codex.mdx: "start the
            // session from the Happier app… later run `happier attach
            // <session-id>` from a terminal on that same machine… switch into
            // local control". Codex local control is exclusive and tmux-backed
            // (packages/agents/src/manifest.ts:140), and a message sent from the
            // app while the TUI owns the session waits in the pending queue.
            title: 'Switch between the terminal and the app, mid-session.',
            body: 'Start a Codex session from your phone, then run `happier attach <session-id>` on that computer and you are in Codex’s own TUI, in the same session, with the history already there. Or start it in the terminal and pick it up in the app. Codex’s local control is exclusive, so while the TUI has the session a message from the app waits in the pending queue until that turn finishes, aborts or exits — Happier will not type into a running turn, because that is how you lose work you wanted.',
        },
        {
            id: 'machines',
            // session.spawn_new takes `machineId`; session handoff moves a live
            // session between machines under the same session id
            // (packages/protocol/src/actions/actionSpecs.ts;
            // docs/features/session-handoff.mdx).
            // Was "Across your computers, not just one of them." The clause
            // after the comma described what the card was not about.
            title: 'Start a session on any computer you own.',
            body: 'Sessions are created against a machine, so a Codex session can start on the VPS while you are on the laptop, and a session on the laptop can message it and wait for it to finish. A live session can also move between computers under the same session id, carrying its provider state and project directory — supported for Claude Code and OpenCode, experimental for Codex.',
        },
    ],
} as const;

/**
 * The scope limit, stated separately from the conditions on purpose.
 *
 * "Remote drives Codex" is not a switch that turns something off; it is the
 * boundary of what the thing is for. Filing it as a sixth condition would be an
 * item that is not the same kind of thing, and anyone who checks would catch it.
 */
export const CODEX_SCOPE_LIMIT = {
    heading: 'And the job it was never meant to do',
    body: `Remote drives Codex, and Codex cloud runs Codex. That is what a vendor remote is: every vendor that ships one ships it for its own agent, and there is nothing strange about that. The cross-vendor case gets built on an open protocol instead — Zed runs Claude, Codex, OpenCode, Copilot, Cursor and Pi Coding Agent in the editor over ACP, and Happier speaks ACP too, across your devices rather than inside one editor. Reaching one vendor’s agent from your phone and running ${AGENTS.length} vendors’ agents out of one inbox are different jobs. Happier is built for the second one.`,
} as const;

export type CodexComparisonRow = {
    id: string;
    /** The fact, phrased neutrally. */
    capability: string;
    /** What OpenAI's public docs say. Never an opinion. */
    codex: string;
    /** What Happier does. Traceable to shipped source. */
    happier: string;
};

/**
 * The reference table. Eight facts that decide whether either thing runs where
 * you work — not a feature scorecard.
 *
 * Three of the eight go to OpenAI (cloud environments, first-party, price),
 * and they stay in. A table where one side sweeps is a table nobody believes,
 * and two of those three are real reasons to pick their surface.
 */
export const CODEX_COMPARISON_ROWS: ReadonlyArray<CodexComparisonRow> = [
    {
        id: 'agents',
        capability: 'Agents it drives',
        codex: 'Codex',
        happier: `${AGENTS.length} agents + any ACP CLI`,
    },
    {
        id: 'hostOs',
        capability: 'Operating systems it runs the work on',
        codex: 'macOS or Windows host app, plus its SSH targets (per OpenAI docs)',
        happier: 'macOS, Windows and Linux, each on its own',
    },
    {
        id: 'setup',
        capability: 'Where the connection is set up',
        codex: 'Desktop app; not the CLI or IDE extension (per OpenAI docs)',
        happier: 'One install per computer, then `happier codex` in a repository',
    },
    {
        id: 'ssh',
        capability: 'Remote SSH hosts',
        codex: 'Discovered from `~/.ssh/config` (per OpenAI docs)',
        happier: 'Install Happier on the host and it becomes a machine like any other',
    },
    {
        id: 'cloud',
        capability: 'Running work with no computer of your own',
        codex: 'Codex cloud: isolated cloud environments (per OpenAI docs)',
        happier: 'Not offered — every session runs on a computer you own',
    },
    {
        id: 'workspace',
        capability: 'Who holds the switch in an organisation',
        codex: 'Workspace admin may need to enable Remote Control access (per OpenAI docs)',
        happier: 'You do, on a relay you can self-host',
    },
    {
        id: 'price',
        capability: 'Price',
        codex: 'Codex included with ChatGPT subscriptions (per OpenAI docs)',
        happier: 'Free and MIT-licensed',
    },
    {
        id: 'firstParty',
        capability: 'Made by the vendor of the agent',
        codex: 'Yes — first-party',
        happier: 'No — independent client',
    },
];
