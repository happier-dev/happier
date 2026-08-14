/**
 * "Where Happier fits" — the positioning section, and the /vs page it feeds.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This section used to be a feature-level comparison against Claude Code Remote
 * Control. Two problems with that shape, and they are the reason it was rebuilt:
 *
 *   1. It argued on the competitor's ground. Every row invited the reader to
 *      score two products on Anthropic's axes, which is a contest a third-party
 *      client cannot win and should not enter.
 *   2. It was where the factual errors lived. Four separate claims about Remote
 *      Control were wrong — pairing was "a QR code and nothing else" (the docs
 *      list three routes), 32 was "the limit" (it is `--capacity`'s default),
 *      `--spawn` was said to give every session a worktree (it defaults to
 *      `same-dir`, and `worktree` isolates on-demand sessions only), and the
 *      price line omitted that Remote Control is a research preview that is off
 *      by default on Team and Enterprise.
 *
 * The new frame is positional rather than competitive: vendor remotes exist, they
 * are good at the thing they were built for, and each of them reaches exactly one
 * vendor's agent. Happier's argument is the set of things that only make sense
 * when one client runs all thirteen.
 *
 * EVIDENCE RULE — unchanged and non-negotiable.
 *   • Every Remote Control statement is a restatement of Anthropic's own page,
 *     code.claude.com/docs/en/remote-control. Nothing is inferred, benchmarked,
 *     or characterised for quality. Verified August 2026.
 *   • Every Happier statement is traceable to shipped source in remote-dev: the
 *     action specs in packages/protocol/src/actions/actionSpecs.ts, the connected
 *     services schemas in packages/protocol/src/connect, and the feature docs at
 *     docs.happier.dev. Anchors are named inline where a claim is specific.
 */

export const RC_SECTION = {
    eyebrow: 'Where Happier fits',
    /**
     * Three sentences, three lines. "Codex has mobile" is DESCRIPTIVE — OpenAI
     * put Codex inside the ChatGPT mobile app, and there is no product called
     * "Codex Mobile". Never capitalise it as one. Anthropic's is "Claude Code
     * Remote Control", a Claude Code feature.
     */
    title: 'Claude Code has a remote.\nCodex has mobile.\nHappier runs both, and eleven more.',
    subline:
        'One app for Claude Code, Codex, OpenCode, Pi and nine more — on your own computers, with your own accounts.',
    /**
     * The concession, for the /vs page. Accurate and unhedged, because a vague
     * concession is not a concession — and because every specific in it is
     * quotable straight off Anthropic's own documentation.
     *
     * IT ENDS IN THE INDICATIVE, AND THAT IS LOAD-BEARING. It used to end
     * "…use it — it is first-party, and installing a second tool to reach the
     * same outcome is work you do not need to do." Stating that Remote Control
     * covers a setup is a concession; instructing the reader to go and use it
     * is a different act, and it is the one the /vs/codex-remote guard has
     * banned since it shipped there. copyClaims.test.ts now bans the imperative
     * forms across every rendered page, so the two guards agree.
     */
    concession:
        'Anthropic ships Remote Control for Claude Code, and it is good. It is a research preview, available on Pro, Max, Team and Enterprise. You reach a running session three ways: open the session URL in any browser, scan the QR code, or find the session by name in the list at claude.ai/code. Claude keeps running on your own computer the whole time, the session reconnects on its own after your laptop sleeps or the network drops, and it pushes to your phone when it needs a decision from you. If Claude Code is the whole of your workflow and none of the conditions below describe your setup, Remote Control already covers it, and it is first-party.',
    /** The turn. Names the reader's situation rather than attacking the product. */
    turn: 'This page is about the rest of it: the setups Anthropic’s own documentation says Remote Control will not run in, and the twelve other agents it was never meant to cover.',
    /**
     * THE ARGUMENT. Five things that only exist because one client runs every
     * agent — not five ways Happier scores higher on somebody else's axes.
     *
     * Each one is verified in the shipped product (remote-dev), and the anchor is
     * named in the comment above it so the next person to edit the copy can
     * re-check it in one grep rather than trusting this file.
     */
    arguments: [
        {
            id: 'oneApp',
            // "Inbox" is a shipped UI noun, not a metaphor this page invented:
            // remote-dev/apps/ui/sources/app/(app)/inbox/index.tsx is the route,
            // InboxView renders it, and settings/appearance.tsx:94 has the
            // tab-bar badge switch for it. The README describes it as "a global
            // attention center for permission requests, user-action prompts,
            // approval-gated actions, and unread sessions — across all sessions
            // and machines at once."
            //
            // "One app, not one per vendor." was the old title, and it made the
            // reader picture the shelf of vendor apps before it made them
            // picture ours. State the positive: the inbox is the thing being
            // sold, and it is what the body goes on to describe.
            title: 'Every agent in one inbox.',
            body: 'Claude Code’s remote opens in claude.ai/code or the Claude app. Codex reaches your phone through the ChatGPT app. Each vendor’s remote lands inside that vendor’s product, which is fine until you use two of them. Happier is one inbox instead: every session, on every agent, on every computer you have connected, in one list — with one place to answer the permission prompts they are all waiting on.',
        },
        {
            id: 'mixAndMatch',
            // subagents.delegate.start / subagents.review.start take
            // `backendTargetKeys`: "Select the agent provider/backend targets to
            // use." Multiselect over execution.backends.enabled.
            // packages/protocol/src/actions/actionSpecs.ts
            title: 'Mix and match inside one workspace.',
            body: 'A Codex session can hand the UI work to a delegate run on Claude while a Pi session digs through a stack trace, and you can steer any of them mid-run. Happier’s review, plan and delegate runs take a list of provider targets — not whichever provider you happen to be sitting in. A remote built by one vendor drives that vendor’s agent; Remote Control is a Claude Code feature, by its own documentation.',
        },
        {
            id: 'accounts',
            // Multiple profiles per service, default per service, override at
            // session start, quota snapshots for openai-codex /
            // claude-subscription / gemini.
            //
            // ON THE DEFAULT, WHICH THIS LINE USED TO GET BACKWARDS. The copy
            // said "pools rotate only if you turn auto-switching on; it is off
            // by default", cited from `autoSwitch: z.boolean().default(false)`
            // in connectedServiceSchemas.ts:503. That zod default never reaches
            // a pool the app creates: the CREATE ROUTE fills the field in
            // first —
            //   apps/server/sources/app/api/routes/connect/connectedServicesV3/
            //     registerConnectedServiceAuthGroupRoutesV3.ts:264-267
            //   const autoSwitchCreateDefault =
            //       fallbackEnabled() && runtimeFallbackSupportedForService(serviceId);
            //   autoSwitch: policyPatch?.autoSwitch ?? autoSwitchCreateDefault
            // `fallbackEnabled()` reads a server flag that defaults to TRUE
            // (readFeatureEnv.ts:247), and `runtimeFallbackSupported` is true
            // for the four credentials Claude Code or Codex can change account
            // inside a live session on — claude-subscription, anthropic,
            // openai-codex, openai — and false for gemini and github
            // (packages/agents/src/connectedServices/runtimeFallbackCapability.ts
            // evaluated over manifest.ts). The server's own integration test is
            // named "defaults autoSwitch to true at create when the
            // account-fallback feature is enabled". Cite the ROUTE, not the
            // schema; /features/usage-limits says the same thing.
            // "Your accounts, pooled, with the meters showing." was the old
            // title: a noun phrase with a participial clause hung off it, which
            // reads as a caption under a screenshot rather than as a heading.
            // The rest of the site's headings take a verb — "Pool your
            // accounts. Keep the session going.", "Review the diff. Send
            // notes." — and this one now does too. It does not reuse the
            // features.ts opener, because both render on the homepage.
            title: 'Choose the account. See what is left.',
            body: 'Connect more than one profile per service — a personal Codex subscription and a work one, a Claude setup-token, an Anthropic API key — and choose which one a session runs on at the moment you start it. Quota snapshots for Codex, Claude and Gemini profiles show as badges in the auth picker, so you can see what is left before you commit a long run to it. Nothing switches until you build a pool on purpose; once you have, it starts with automatic fallback on for the accounts a running session can actually move between, and there is a toggle on the pool if you would rather switch by hand.',
        },
        {
            id: 'terminal',
            // docs.happier.dev/features/attach-to-session: "switching the same
            // session between remote control and local control"; "`happier
            // attach` reconnects to the existing session. It does not start a
            // new one."
            // Was "Terminal or UI, your call, switchable mid-session." — three
            // fragments and no verb between them. Same fact, said as a heading.
            title: 'Switch between the terminal and the app, mid-session.',
            body: 'Start a session in the app from your phone, then run `happier attach` on that computer and you are in that same session in a shell, with the history already there — for Claude Code and Codex inside tmux, for OpenCode through its own attach, and in all three you are in the agent’s real TUI. Or start it in the terminal and pick it up in the app. It reconnects to the session that exists rather than creating a second one, so nobody has to choose a side at the start of a task.',
        },
        {
            id: 'machines',
            // session.spawn_new takes `machineId`, sourced from
            // sessions.spawn.machines.available; session.message.send is exposed
            // on the `session_agent` surface with a `wait` for idle; session
            // handoff moves a live session between machines under the same id.
            //
            // THE HANDOFF CAVEAT IS NOT OPTIONAL. features/feature-matrix.mdx:23
            // — "Claude and OpenCode are supported; Codex is experimental" —
            // and features/session-handoff.mdx:60 says the same. This sentence
            // sat uncaveated next to a Codex example, which is precisely the
            // reader who would try it first. The Codex page and the FAQ both
            // carry the caveat; so does this one.
            // Was "Across your computers, not just one of them." The second
            // half told the reader what the sentence was not about.
            //
            // "documented as experimental for Codex" was also cut from the body:
            // the code is the source of truth, and it says the same thing —
            // packages/agents/src/manifest.ts, handoff.vendorStateTransfer is
            // 'supported' for claude (:55) and opencode (:195) and
            // 'experimental' for codex (:139). The caveat itself is not
            // optional; only the citation moved.
            title: 'Start a session on any computer you own.',
            body: 'Sessions are created against a machine, so a Codex session can start on the VPS while you are on the laptop, and a Claude session on the laptop can message it and wait for it to finish. A live session can also move between machines — same session id, different computer — carrying its provider state and project directory with it, which works for Claude Code and OpenCode, and is experimental on Codex.',
        },
    ],
    /**
     * The documented conditions under which Remote Control is unavailable, each
     * paired with what Happier does instead. These are quoted from Anthropic's
     * requirements list, not found by testing.
     */
    cases: [
        {
            id: 'apiKeys',
            when: 'You authenticate with an API key.',
            rc: 'Anthropic’s docs state plainly that API keys are not supported for Remote Control, and that tokens created with setup-token or CLAUDE_CODE_OAUTH_TOKEN cannot establish a Remote Control connection.',
            happier:
                'Happier treats API keys as a first-class auth path, not a downgrade. Store one as a connected service, bind it to a backend profile, and every device you own drives that session.',
        },
        {
            id: 'gateway',
            when: 'Your traffic goes through a gateway or proxy.',
            rc: 'Remote Control is disabled whenever ANTHROPIC_BASE_URL points anywhere other than api.anthropic.com — which is exactly what every LLM gateway, proxy and internal routing layer does.',
            happier:
                'Backend profiles exist to set ANTHROPIC_BASE_URL. Happier ships profiles for DeepSeek, Z.AI and MiniMax, and a custom profile can point Claude Code at your own gateway with your own variables.',
        },
        {
            id: 'clouds',
            // Anthropic's named list is exactly these three. Vertex is NOT on it:
            // a Vertex session is turned away by the api.anthropic.com rule
            // above, which is a different mechanism — and Happier ships a
            // first-party Gemini Vertex profile, so lumping it in here would be
            // wrong twice over.
            when: 'You run on Bedrock, Google Cloud’s Agent Platform, or Microsoft Foundry.',
            rc: 'Anthropic’s docs list Remote Control as not available on Amazon Bedrock, Google Cloud’s Agent Platform, or Microsoft Foundry.',
            happier:
                'Be precise about this one: Happier ships NO first-party Bedrock or Microsoft Foundry support, and claiming otherwise would be the same kind of overreach this page is arguing against. What it ships is a custom backend profile that sets whatever environment variables your deployment needs — including the Bedrock and Foundry selectors — which you configure yourself and we do not test. Google Cloud is the exception: Gemini ships a Vertex AI profile out of the box.',
        },
        {
            id: 'telemetry',
            when: 'Your org turns telemetry off.',
            rc: 'Per Anthropic’s docs, DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and DISABLE_GROWTHBOOK each disable the feature-flag evaluation Remote Control availability depends on.',
            happier:
                'Happier has no equivalent kill switch, because it is not reading those variables to decide whether you are allowed to connect. Self-host the relay and the question does not arise.',
        },
        {
            id: 'zdr',
            when: 'You are under Zero Data Retention or similar rules.',
            rc: 'Anthropic’s docs say organizations with compliance requirements such as Zero Data Retention can’t enable Remote Control, and that while it is connected the session transcript is stored on Anthropic servers.',
            happier:
                'Happier accounts are end-to-end encrypted by default — the sync server holds ciphertext it cannot read. Run `happier relay host install` and the transcript never leaves hardware you control.',
        },
        {
            id: 'otherAgents',
            when: 'You do not only use Claude Code.',
            rc: 'Remote Control is a Claude Code feature. It does not extend to Codex, Cursor, Gemini, Copilot, OpenCode, Qwen, Kimi, Kilo, Kiro, Auggie, Pi or Grok.',
            happier:
                'Thirteen agents, one client, one transcript, one set of permissions and shortcuts — plus any ACP-compatible CLI you add yourself. A Codex delegate run can review what Claude Code just wrote.',
        },
    ],
} as const;

export type ComparisonRow = {
    id: string;
    /** The capability, phrased neutrally. */
    capability: string;
    /** What Anthropic's public docs say. Never an opinion. */
    rc: string;
    /** What Happier does. Traceable to shipped source. */
    happier: string;
};

/**
 * The reference table, and it lives on /vs only — never on the homepage.
 *
 * These rows are not a feature scorecard; they are the "will it run in my
 * setup?" facts, which is the question the /vs page exists to answer. Two of the
 * eight rows are wins for Anthropic and stay in, because a table where one side
 * sweeps is a table nobody believes.
 */
export const COMPARISON_ROWS: ReadonlyArray<ComparisonRow> = [
    {
        id: 'agents',
        capability: 'Agents supported',
        rc: 'Claude Code',
        happier: '13 agents + any ACP CLI',
    },
    {
        id: 'auth',
        capability: 'API-key auth',
        rc: 'Not supported (per Anthropic docs)',
        happier: 'Supported',
    },
    {
        id: 'baseUrl',
        capability: 'Custom endpoint / LLM gateway',
        rc: 'Disables Remote Control (per Anthropic docs)',
        happier: 'Supported via backend profiles',
    },
    {
        id: 'clouds',
        capability: 'Bedrock / Google Agent Platform / Foundry',
        rc: 'Not available (per Anthropic docs)',
        // This cell used to read "Configurable per profile", which overstated
        // it: there is no first-party Bedrock or Foundry integration in Happier,
        // only a generic custom profile that sets environment variables and is
        // not tested against those clouds. Vertex is different — Gemini ships a
        // real profile for it. A comparison page that shades one cell in its own
        // favour has spent the credibility it needs for the other seven.
        happier: 'No first-party support; custom env profile, or Vertex via Gemini',
    },
    {
        id: 'zdr',
        capability: 'Zero Data Retention orgs',
        rc: 'Can’t enable (per Anthropic docs)',
        happier: 'E2EE by default; self-hostable relay',
    },
    {
        id: 'transcript',
        capability: 'Where the transcript is stored',
        rc: 'Anthropic servers while connected (per Anthropic docs)',
        happier: 'Encrypted on Happier sync, or your own relay',
    },
    {
        id: 'price',
        capability: 'Price',
        rc: 'Included with Pro, Max, Team, Enterprise',
        happier: 'Free and MIT-licensed',
    },
    {
        id: 'firstParty',
        capability: 'Made by the vendor of the agent',
        rc: 'Yes — first-party',
        happier: 'No — independent client',
    },
];

/**
 * What Remote Control does well, on the record.
 *
 * SHORT ON PURPOSE, and every entry now survives a read of the source page. The
 * four that did not are gone or rewritten:
 *   • "Pairing is a QR code and nothing else" → there are three connect routes,
 *     the server-mode QR is behind a spacebar press, and VS Code shows no QR.
 *   • "Up to 32 sessions" → 32 is `--capacity`'s DEFAULT, not a ceiling.
 *   • "`--spawn` gives each session its own git worktree" → `--spawn` defaults
 *     to `same-dir`; `worktree` isolates on-demand sessions, and the session
 *     pre-created at startup stays in the current directory.
 *   • "Included in a subscription you may already have" → true, with the two
 *     caveats the same page carries: research preview, and off by default on
 *     Team and Enterprise until an Owner enables it.
 */
export const RC_STRENGTHS: ReadonlyArray<{ id: string; title: string; body: string }> = [
    {
        id: 'connect',
        title: 'Three ways into a running session',
        body: 'Open the session URL in any browser, scan the QR code, or open claude.ai/code and find the session by name — Remote Control sessions show a computer icon with a green dot when they are online. With `claude remote-control` the QR is behind a spacebar press, and the VS Code command shows no QR at all; it posts the session URL into the conversation instead.',
    },
    {
        id: 'adopt',
        title: '`/rc` adopts the session you are already in',
        body: 'You do not have to decide in advance. Type /rc inside a running Claude Code session and it becomes remotely controllable, carrying over the conversation history — no restart, no losing the context you have built up over the last hour.',
    },
    {
        id: 'reconnect',
        title: 'It survives a sleeping laptop, and it pushes',
        body: 'If your computer sleeps or the network drops, Claude Code reconnects when it comes back online, and queues subagent and workflow status updates while the connection rebuilds so you get them once it recovers. Push notifications arrive when Claude decides one is warranted, or when it needs a decision from you to continue.',
    },
    {
        id: 'server',
        title: 'Server mode runs a pool of sessions from one process',
        body: '`claude remote-control` stays running and serves sessions on demand. `--capacity <N>` caps how many run at once — the documented default is 32, which is a default rather than a ceiling. `--spawn` decides where they land: `same-dir` by default, so sessions share the working directory, or `worktree`, which gives each on-demand session its own git worktree while the session pre-created at startup stays put.',
    },
    {
        id: 'price',
        title: 'It comes with a subscription you may already have',
        body: 'Remote Control is available on Pro, Max, Team and Enterprise. Two things the same page adds: it is a research preview, and on Team and Enterprise it is off until an Owner turns on the Remote Control toggle in Claude Code admin settings. API keys are not supported at all.',
    },
];

/**
 * The scope limit, stated separately from the disable conditions on purpose.
 *
 * "Remote Control is Claude Code only" is not a condition that switches it off;
 * it is the boundary of what it was built for. Filing it under "conditions that
 * disable it" would be an item that is not the same kind of thing, and anyone
 * who checks the source would catch it.
 *
 * NOTE FOR FUTURE EDITS: this block used to end with "no vendor is going to ship
 * a client for a rival's CLI". That is false — Zed ships Claude, Codex,
 * OpenCode, Copilot, Cursor and Pi as external agents over ACP
 * (zed.dev/docs/ai/external-agents). Do not put it back.
 */
export const RC_SCOPE_LIMIT = {
    heading: 'And one thing it was never built for',
    body: 'Remote Control is a Claude Code feature. It does not extend to Codex, Cursor, Gemini, Copilot, OpenCode, Qwen, Kimi, Kilo, Kiro, Auggie, Pi or Grok — some of those have a remote of their own, most have none, and none of them share an inbox with the others. Reaching one vendor’s agent from your phone and running thirteen vendors’ agents from one place are different jobs. Happier is built for the second one.',
} as const;
