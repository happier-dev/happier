/**
 * Prose lifted out of the page components by scripts/i18n-lift-jsx.mjs.
 *
 * GENERATED THE FIRST TIME, EDITED BY HAND AFTER THAT. Re-running the codemod
 * over an already-lifted page does nothing, because the prose is no longer in
 * the JSX to find — so this file is normal source from here on. Re-word a
 * sentence here, not in the component. A later run MERGES into what is here
 * rather than replacing it, and continues the numbering, so ids already carrying
 * translations keep pointing at the same sentence.
 *
 * `<1>…</1>` marks a slot: the element that wrapped that run of text in the
 * original markup, whose props live in the component and never reach a
 * translator. An EMPTY slot, `<2></2>`, is an element with nothing in it — an
 * icon, a `<br />` — and it is in the message so a translation can move it.
 * `{name}` is an interpolated value. All three are named, so a translation may
 * put them wherever the target language needs them. See src/i18n/rich.tsx.
 *
 * This is an ordinary data module, so `yarn i18n:extract` picks it up and the
 * overlay in src/i18n/siteData.ts translates it exactly like every other one.
 */
export const PAGE_PROSE = {
    agentDetail: {
        p0: "Happier looks for <1>{binary}</1> on your PATH and runs the copy you installed. {vendor} distributes it with an install script rather than a package; Happier can show you that command, and it will not execute a vendor install script on its own — vendor recipes are refused unless you explicitly allow them.",
        p1: "Happier looks for <1>{binary}</1> on your PATH and runs the copy you installed. There is no install path for it inside Happier at all: install it the way {vendor} documents, and Happier picks it up from there.",
        p2: "The iOS and Android apps, the desktop app for macOS, Windows and Linux, and <1>app.happier.dev</1> are all clients onto the {name} process running on your computer — not read-only mirrors. Answer a permission request, send the next instruction, browse the repository, read the diff. The transcript is end-to-end encrypted before it leaves your computer, so the server carrying it holds ciphertext.",
        p3: "Happier installs on the computer that already holds your repository, and <1>happier {id}</1> starts {name} there as an ordinary subprocess, in the directory you point it at, signed in the way you signed it in. There is no gateway between the agent and {vendor}, and no copy of your source anywhere else.",
        p4: "Configuration reference for the Happier side — <1>{name} in the Happier docs</1>.",
        p5: "{name} is one of {length} command-line coding agents Happier runs, and they share one session list, one permission inbox, one set of keyboard shortcuts and one MCP configuration.",
        p6: "That matters most on the days you are running more than one: sessions from different vendors side by side, and a notification tap opening the session that raised the request rather than the app’s front door. <1>The full list is here</1>.",
        p7: "Typing <1>happier {id}</1> in a terminal starts the session right where you are standing, and the same session is in the app at the same time. What you read in that shell is Happier’s own display of the session — the transcript, the permission prompts, the tool output — rather than {name}’s interface. Nobody has to give up the terminal to get a phone client.",
        p8: "The <1>attach guide</1> lists the cases instead of promising all of them.",
        p9: "One command on the computer that holds your code, then <1>happier {id}</1> in the repository you want to work in.",
        p10: "Walkthroughs are in the <1>guides</1>. All of it is MIT-licensed, and the relay is one you can run yourself.",
        p11: "Breadcrumb",
        p12: "← Every agent Happier runs",
        p13: "Questions about running {name} through Happier",
        p14: "Happier looks for <1>{binary}</1> on your PATH first and runs the copy you installed. If there is not one, it can install <2>{source}</2> into <3>{path}</3> — its own directory, not your global npm prefix. A copy you manage yourself is never replaced or upgraded behind your back.",
        p15: "Happier looks for <1>{binary}</1> on your PATH first and runs the copy you installed. If there is not one, it can download the <2>{source}</2> release binary into <3>{path}</3> and keep it there. Your own install always takes priority.",
        p16: "When you want {name}’s own TUI, <1>{attach}</1> on the computer that owns the session hands it to you inside tmux, with the history already there. On the default runtime that hand-off is exclusive: while the terminal has the session, a message you send from the app waits in the queue rather than being typed underneath you, and it goes through when you hand control back.",
        p17: "The unified terminal runtime is the other arrangement — one {name} process in a shared terminal host, writable from the terminal and the app at the same time.",
        p18: "<1>{attach}</1> opens {name}’s own TUI on that same session through {name}’s attach flow. Both ends stay writable, with no multiplexer involved and nothing to switch on first — type in the TUI and it appears in the app, send from the app and it appears in the TUI.",
        p19: "There is no hand-off to {name}’s own TUI. That exists for Claude Code, Codex and OpenCode, and for {name} the session stays Happier’s on both ends. <1>{attach}</1> lists the sessions on that computer and marks the ones it cannot reattach, rather than failing after you pick one.",
        p20: "Which account {name} runs on",
        p21: "{name} is one of the agents Happier can point at a credential you connected once instead of at whatever that computer is logged into. It accepts {list}.",
        p22: "Connected services are keyed by the credential, not by the agent, so the same {service} is selectable for every agent that can take it, on every computer you have connected — which is also what makes a pool of your own accounts useful across more than one of them. The credential is encrypted and decrypted on your own devices; <1>the docs page</1> carries the per-profile rules, because which kinds of profile each agent accepts is exactly the sort of detail that moves between releases.",
        p23: "{vendor}’s own install and sign-in guide is at <1>{link}</1>. Happier does not mirror it, because a copy of someone else’s install instructions is a copy that goes stale.",
        p24: "{vendor}’s own page for {name} is at <1>{link}</1>. Happier does not mirror it, because a copy of someone else’s install instructions is a copy that goes stale.",
    },
    agentsIndex: {
        p0: "Happier installs on the computer that holds your repository, starts the vendor’s own CLI there as an ordinary subprocess under your own login, and carries the conversation to your other devices end-to-end encrypted. It hosts none of these agents, and puts no model of its own in front of them.",
        p1: "What that means in practice is that you keep every agent you already pay for and stop needing a different remote for each one. Each page below covers one agent in the detail you want before installing something: the command Happier runs and what it hands that binary, how a permission choice made on a phone is expressed to that particular CLI, which sign-in flow the app can start for you, how the binary gets onto your computer, whether the session can move to the agent’s own terminal interface, and the questions people ask about running it this way.",
        p2: "Per-agent limits — which sessions can be forked, resumed, reattached or moved to another computer — live in the Happier documentation rather than here, because the documentation ships with the product and a marketing page does not.",
        p3: "The release ships one more id than this page has cards for. Here it is, with the reason it has no page of its own.",
        p4: "Four more are defined and on the way. None of them is in the build you can install today, and none is counted in the {length} above.",
        p5: "Anything speaking the Agent Client Protocol can be added as a backend of your own without waiting for us. That path has no page here because what it can do is whatever your CLI implements, and writing a page about it would be writing a page about your code.",
        p6: "Install Happier on the computer that holds your code, then start any agent on this page by name — <1>happier claude</1>, <2>happier codex</2>, <3>happier opencode</3>. The agent runs there, under your own subscription or API key. Happier is the transport and the interface, not a middleman for the model call.",
        p7: "Every agent, one app",
        p8: "Every AI coding agent Happier runs",
        p9: "What is not on this list, and why",
        p10: "Coming in the next version",
        p11: "When one of them ships in {UPCOMING_RELEASE} it moves up into the grid and gets a page of its own.",
        p12: "Or bring your own",
        p13: "Running any of them",
    },
    alternatingFeatures: {
        p0: "Happier is the mobile-native control layer for the AI coding agents you already use. It mirrors your terminal, syncs every session, and gives you back the things a CLI can't: presence, approvals, voice, and one inbox for all of it.",
        p1: "What Happier does",
        p2: "One control room\nfor every coding agent.",
    },
    analyticsNotice: {
        p0: "What we measure",
    },
    callToAction: {
        p0: "Run it on the computer that runs your code. Keep your own subscriptions and keys. Self-host the relay or use ours. MIT licensed, end-to-end encrypted.",
        p1: "Already paired? Open the web app<1></1>",
        p2: "Open source. Yours forever.",
    },
    codexRemotePage: {
        p0: "Every claim in this block restates OpenAI’s published documentation, including the part where their cloud does something Happier does not do at all. None of it is hedged, because a vague concession is not a concession.",
        p1: "These are not limitations we found by testing. Each one is a requirement OpenAI publishes, and one of them applies to Happier in exactly the same way — which is said below rather than quietly left out.",
        p2: "This is filed on its own rather than as a sixth entry in the list above, because it is a different kind of statement. The five conditions are requirements: meet them and the thing works. This one is the shape of the product, and no amount of meeting requirements changes it.",
        p3: "The eight facts that decide whether either thing works where you work. Three of them go to OpenAI. Those three are why the other five are worth reading.",
        p4: "None of these are a vendor remote doing its job badly. They are the things that only become possible once the client is not tied to one vendor’s agent.",
        p5: "The other difference is where the conversation lives. A Happier account is end-to-end encrypted by default — the sync server holds ciphertext it cannot read — and <1>happier relay host install</1> puts the relay itself on hardware you own.",
        p6: "Codex has its own page here, with the install path, the auth model and the quirks — <1>Codex in Happier</1>. The same question, asked about Anthropic’s remote, is answered on <2>the Claude Code Remote Control page</2>.",
        p7: "Install on the computer that holds your code. Nothing on your phone matters until that computer is set up, which is why this is the first step rather than an app store badge.",
        p8: "Then <1>happier codex</1> in a repository. The session is on your phone from the moment it starts, and it is still in your terminal — <2>happier attach</2> puts you back in Codex’s own TUI without starting a second one.",
        p9: "Codex Remote",
        p10: "Codex from your phone: Codex Remote and Happier, compared",
        p11: "OpenAI put Codex inside the ChatGPT mobile app and calls the feature Remote: you pair a phone to a Mac or Windows PC and drive the Codex session running on it. Here is what that covers, the conditions OpenAI’s own documentation puts on it, and the workflow it was never built for.",
        p12: "What Codex’s own remote does well, specifically",
        p13: "The five conditions it runs under",
        p14: "Will it run in your setup?",
        p15: "The Codex column restates OpenAI’s published documentation at learn.chatgpt.com/docs/remote, /docs/remote-connections, /docs/cloud and /docs/pricing. Verified August 2026.",
        p16: "Fact",
        p17: "Codex Remote & Codex cloud",
        p18: "Happier",
        p19: "What one client for {length} agents buys you",
        p20: "Trying it",
    },
    discordMembers: {
        p0: "<1><2></2> happier developers</1> on Discord",
    },
    downloadBadges: {
        p0: "Download",
        p1: "Show all desktop download options",
        p2: "Detected",
        p3: "Open the Happier web app",
        p4: "Web app",
        p5: "Download on",
        p6: "Direct download",
        p7: "Desktop",
        p8: "Download for {platform}",
        p9: "Show desktop download options",
        p10: "Show Android download options",
        p11: "Get it on",
    },
    downloadStats: {
        p0: "downloads",
    },
    enterprisePage: {
        p0: "The shape is worth getting straight before the list. Sessions run on your developers’ own computers, against the provider CLIs they already have. The relay carries messages between those computers and their phones, browsers and desktops. It is the only piece that has to be reachable from outside, and it is the piece you are being asked to host.",
        p1: "Everything below is server configuration: environment variables on that container, enforced by that container, with no Happier-operated service in the path. The default posture of a fresh server is end-to-end encrypted storage and open signup, on the assumption that most people put it behind Tailscale. If you are reading this page you almost certainly want the opposite of the second half of that sentence.",
        p2: "What that encrypted default means underneath — which key is generated where, what your relay is left holding, and the columns it can read without one — is <1>the encryption architecture</1>, written for the developer rather than for you. It is the page to send anyone who asks what the server can see; this one stays on what you can enforce.",
        p3: "MIT. Not source-available, not open-core with the auth stack behind a commercial tier, not AGPL. Everything on this page is in the same repository as the client, under the same licence, and none of it is gated on a contract with us. If your organisation’s policy is that copyleft does not come inside the building, that policy does not stop here.",
        p4: "None of the controls above sits behind a purchase: there is no enterprise tier to buy and no seat count to negotiate for any of them. Depending on your procurement process that is either the reassuring part of this page or the concerning one. What you get instead is the source, an MIT licence and a container image.",
        p5: "The honest order is: stand the relay up on a throwaway host, point one developer at it, and read <1>GET /v1/features</1> to see exactly what that server is advertising to its clients. That response is the contract, and it is the fastest way to confirm a policy you set is a policy the clients will actually honour.",
        p6: "The <1>Docker deployment guide</1> covers the image, the volume and the Postgres override. The <2>server auth reference</2> covers every variable named above, including the recipes for a public server that requires GitHub or an OIDC provider.",
        p7: "Self-hosted relay",
        p8: "Self-host the Happier relay: SSO, mTLS and your own database",
        p9: "Happier is MIT-licensed, and the relay every device talks through is a container you can run yourself. This page is the list of controls that come with it — what the server enforces, what it stores, and what it hands your clients at runtime.",
        p10: "SSO: GitHub orgs, OIDC groups and client certificates",
        p11: "Identity is delegated to whatever you already run. Happier’s job is to enforce it on every request rather than only at signup, and to keep asking.",
        p12: "Storage policy, retention and the database you host",
        p13: "The controls an auditor asks about second, once they have finished with authentication.",
        p14: "If your organisation has zero data retention",
        p15: "What procurement gets: an MIT licence and a container image",
        p16: "Stand up a test relay and check what it enforces",
    },
    faq: {
        p0: "Straight answers",
        p1: "The questions\nyou were going to ask.",
    },
    featureGrid: {
        p0: "And there's more",
        p1: "Everything else\nyou didn’t know you needed.",
    },
    footer: {
        p0: "One open-source client for every coding agent — thirteen of them, run on your own computer, with your own subscriptions or API keys, end-to-end encrypted.",
        p1: "© {BUILD_YEAR} Happier. Open source. Made with care.",
    },
    getStarted: {
        p0: "Get started",
        p1: "Scan from<1></1>your terminal",
        p2: "Up and running\nin under a minute.",
    },
    handoffToComputer: {
        p0: "Happier runs where your code runs.",
        p1: "Start on the computer with your repos on it — then this phone becomes a screen for it. Send yourself the one-line setup command.",
        p2: "<1></1>Send to my computer",
        p3: "Email it to myself",
    },
    happierMark: {
        p0: "Happier home",
        p1: "happier",
    },
    heroShowcase: {
        p0: "Scroll to explore",
        p1: "Happier desktop app",
        p2: "Happier desktop app screenshot — scroll to explore",
        p3: "Happier desktop app — scroll horizontally to explore",
        p4: "Happier mobile app",
    },
    mobileThemePreview: {
        p0: "Preview the next Happier mobile theme",
        p1: "Mobile theme previews",
    },
    nav: {
        p0: "Star on GitHub",
        p1: "GitHub",
        p2: "Agents",
        p3: "Enterprise",
        p4: "Docs",
        p5: "Install Happier",
    },
    primaryCta: {
        p0: "Already set up? Open the app<1></1>",
    },
    proofStrip: {
        p0: "Project at a glance",
    },
    providerMarkRow: {
        p0: "Supported AI coding agents",
    },
    securityPage: {
        p0: "The variables that set all three, the at-rest options underneath them and the identity controls around them are the operator’s half of this, and they live on <1>the self-hosting page for teams</1>.",
        p1: "The <1>encryption model reference</1> covers the same ground as procedure — what restore asks of you, what each storage mode means for an account, which flow to reach for when a device cannot read a session yet.",
        p2: "Encryption is a claim about content, and a claim about content is only half an answer. Here is the other half, at the same level of detail: the columns a server operating this relay can read without a key.",
        p3: "Security",
        p4: "End-to-end encryption, with the keys on your own devices",
        p5: "Happier keeps one coding session in sync between the computer it runs on and every device you watch it from, and a relay server sits in the middle of that. This page is the architecture under that sentence: which key is made where, what the relay actually holds, what it can still see, and what changes on a server configured to turn encryption off.",
        p6: "Your encryption keys are created on your own device",
        p7: "Linking a new device, and how your keys reach it",
        p8: "Storage policy: end-to-end encryption is the default",
        p9: "Push notifications are sent by your own computer",
        p10: "Self-hosted relay: the metadata stays on your hardware too",
        p11: "Read the encryption code yourself",
        p12: "How a message is encrypted between your phone and your computer",
        p13: "What the relay server stores",
        p14: "It holds",
        p15: "It does not hold",
    },
    selfHost: {
        p0: "Run the Happier relay server on your own infrastructure. Your data never leaves your network.",
        p1: "Self-host",
        p2: "Copy commands",
        p3: "Own the stack.\nStay independent.",
    },
    tabbedExplorer: {
        p0: "See it in action",
        p1: "Every tool.\nOne interface.",
    },
    terminalPage: {
        p0: "Three of the thirteen, and they do not behave the same way. Codex is exclusive — one driver at a time. OpenCode is not, and Claude Code can be either, depending on which runtime you start it under.",
        p1: "The other ten agents Happier runs still start from the terminal with <1>happier <agent></1> and still appear on your phone. What they do not do is let you take the session back into their own TUI half way through.",
        p2: "Nothing on this page needs configuration if you start your sessions from the terminal — that path works the moment the CLI is installed. The settings that do need a decision are tmux integration, the Windows session mode and where the embedded terminal docks, and all three are in the <1>configuration reference</1>.",
        p3: "Feature",
        p4: "Keep your Claude Code, Codex and OpenCode terminals, or work from the app",
        p5: "Happier runs them as the same session you would have started yourself — so you can drive it from their own TUI, from your phone, or from both, without the session noticing.",
        p6: "Start in the terminal or in the app, and move between them",
        p7: "Which agents move a session between the terminal and the app",
        p8: "Agent",
        p9: "Terminal and app together",
        p10: "Reattaches through",
        p11: "What that means in practice",
        p12: "What attaching needs: tmux, the same computer, a running daemon",
        p13: "tmux, the Windows session mode, and where the terminal docks",
    },
    usageLimitsPage: {
        p0: "A provider refuses a turn and Happier shows “Usage limit reached”, with the reset time when the provider supplied one. From there: wait — “Resume when limit resets” keeps the session and picks it up on its own — or “Check limit now” to re-probe, or stop waiting. Waiting is the one that keeps your afternoon: Happier holds the reset time, re-checks it for you, starts the session again if it had exited in the meantime, and sends a prompt to carry on from the interrupted context. Tick “Always wait and resume” once and you stop being asked — every limit after that is handled the same way with nobody watching. A Codex session goes one further and arms the wait by itself once “Continue automatically” is set.",
        p1: "That banner appears for Claude Code, Codex, OpenCode, Gemini and Pi. No other agent in the registry reports usage limits to Happier in a form it can act on, so what you get there is whatever the provider’s own CLI prints.",
        p2: "The defaults a new pool starts with. All of them are editable per pool.",
        p3: "One row per account you can connect. Being able to use a pool and being able to change account inside a running turn are two different capabilities, and the second one is rarer.",
        p4: "Connecting the accounts comes first, and that part has a <1>configuration reference</1>: how each provider’s sign-in works, which agent can consume which credential, and where the quota snapshots come from.",
        p5: "Feature",
        p6: "A usage limit should not end your session.",
        p7: "Every provider stops you eventually, and Happier cannot change that. What it can do is hold the session at the limit, show you when it resets, and start the work again from where it stopped. Turn on “Always wait and resume” and it does the whole thing unattended — one setting, and you come back to a session that carried on instead of one that stopped. That is on one account. Own several subscriptions and there is a better answer below: pool them, and a session that runs one dry moves to the next.",
        p8: "With one account, Happier waits out the reset and resumes the session",
        p9: "Pool the subscriptions you own, and the session carries on across them",
        p10: "How a pool falls back: the account it picks, and how often",
        p11: "Setting",
        p12: "Default",
        p13: "Why",
        p14: "Which accounts you can pool, and which agents can use them",
        p15: "Account you connect",
        p16: "Agents that can use it",
        p17: "Switches mid-session",
        p18: "Quota meter",
        p19: "Your own accounts, and what your provider’s terms allow",
        p20: "Build a pool in the app, start a session on it from the CLI",
    },
    verifyInstaller: {
        p0: "Signed releases — verify before you run it",
        p1: "The installer does not trust its own download. It fetches the release archive and the published <1>checksums.txt</1>, checks the archive’s SHA-256 against it, then verifies that checksums file with <2>minisign</2> against a key that ships inside the script. Either check failing aborts the install before anything is written to disk.",
        p2: "Signing key {RELEASE_PUBKEY_ID}:",
        p3: "It is also served at <1>happier.dev/happier-release.pub</1>. The two should be identical — if they are not, do not install.",
        p4: "Prefer not to pipe anything into a shell? Don’t:",
        p5: "<1>Read the script</1> · <2>Security model</2>",
    },
    vsRemoteControl: {
        p0: "Already using Claude Code Remote Control? <1>Compare it with Happier.</1>",
    },
    vsRemoteControlPage: {
        p0: "Every claim in this block is from Anthropic’s own Remote Control documentation, including the flag defaults. None of it is hedged, because a vague concession is not a concession.",
        p1: "These are not limitations we found by testing. They are documented behaviour: in each case Remote Control is disabled or unavailable by design, and Anthropic says so.",
        p2: "This is filed on its own rather than as a sixth entry in the list above, because it is a different kind of statement. The five conditions are switches: satisfy one and a feature you had stops working. This is the shape of the product.",
        p3: "The eight facts that decide whether either thing works where you work. Two of them Anthropic wins outright. Those two are why the other six are worth reading.",
        p4: "None of these are Remote Control doing its job badly. They are the things that only become possible once the client is not tied to one vendor’s agent.",
        p5: "The other difference is where your conversation lives. Remote Control stores the session transcript on Anthropic servers while it is connected, per its documentation, and organisations under Zero Data Retention rules cannot enable it at all. Happier encrypts the transcript end to end by default, and <1>happier relay host install</1> puts the relay on hardware you own.",
        p6: "Each of the {length} agents has its own page — <1>start here</1>.",
        p7: "Install on the computer that holds your code. Nothing on your phone matters until that computer is set up, which is why this is the first step rather than an app store badge.",
        p8: "Claude Code Remote Control",
        p9: "Claude Code from your phone: Remote Control and Happier, compared",
        p10: "Anthropic ships a remote for its own agent, it is free with a subscription you probably already pay for, and it is good. Here is exactly what it does, the situations its own documentation says it will not run in, and the workflow it was never built for.",
        p11: "What Remote Control does well, specifically",
        p12: "The five situations where Remote Control turns itself off",
        p13: "Will it run in your setup?",
        p14: "The Remote Control column restates Anthropic’s published documentation at code.claude.com/docs/en/remote-control. Verified August 2026.",
        p15: "Capability",
        p16: "Claude Code Remote Control",
        p17: "Happier",
        p18: "What one client for {length} agents buys you",
        p19: "Trying it",
    },
} as const;

/**
 * Copy that used to sit in a module-scope `const` inside a section component.
 *
 * THE COMPONENT IS THE ONE PLACE THE OVERLAY CANNOT REACH. `yarn i18n:extract`
 * reads src/data/*.ts and nothing else, so a label table declared next to the
 * JSX that renders it is invisible to extraction, to translation and to the
 * coverage report at once — the failure is silent in all three directions. The
 * homepage shipped its four setup steps, its three self-host cards and its four
 * explorer tabs in English in every language for exactly that reason.
 *
 * These are records rather than flat `pN` strings because each one has a shape
 * the page depends on, and an `id` gives walkStrings a natural key: reorder the
 * steps and the translations follow their step instead of sliding onto the
 * neighbour they now share an index with. The interactive halves — the CTA of a
 * step, the icon of a card, the screenshot behind a tab — stay in the component,
 * keyed by the same id. Copy here, JSX there.
 */
export const GET_STARTED_STEPS = [
    {
        id: 'install',
        title: 'Install on the computer with your code',
        description: 'One command. macOS, Linux, and Windows. Signed and checksum-verified.',
    },
    {
        id: 'setup',
        title: 'Run setup',
        description:
            'Signs you in and installs the background service that keeps this machine reachable while you are away from it.',
    },
    {
        id: 'pair',
        title: 'Pair a device',
        description:
            'happier auth login prints a QR code. Scan it with the app, or open the URL it prints in any browser.',
    },
    {
        id: 'session',
        title: 'Start a session',
        description:
            'Launch any of the 13 agents through Happier and it is live on every signed-in device at once.',
    },
] as const;

/** The three cards under the self-host heading. */
export const SELF_HOST_HIGHLIGHTS = [
    {
        id: 'install',
        title: 'One-command install',
        description: 'Install the relay server with a single command. Docker or bare metal.',
    },
    {
        id: 'operation',
        title: 'Daily operation',
        description:
            'A managed service you start, stop and check with happier relay host status. Nothing on the host updates itself — you update by rerunning the install command, when you decide to.',
    },
    {
        id: 'access',
        title: 'Remote access',
        description: 'Access your sessions from anywhere. SSH tunnels, Tailscale, or direct HTTPS.',
    },
] as const;

/**
 * The three layers a self-hoster owns, top to bottom. Read as a column they are
 * literally the stack the headline refers to, and the repeated "Your" is the
 * whole argument — there is no fourth node, because nothing else is in the path.
 */
export const SELF_HOST_STACK_NODES = [
    {
        id: 'device',
        label: 'Your device',
        detail: 'iOS, Android, desktop, web',
    },
    {
        id: 'relay',
        label: 'Your relay',
        detail: 'Docker or bare metal',
    },
    {
        id: 'machine',
        label: 'Your machine',
        detail: 'Claude Code, Codex, OpenCode',
    },
] as const;

/**
 * The tab strip on the feature explorer.
 *
 * `screenshot` names an entry in ./generatedImages.ts and is not copy — it is a
 * lowercase identifier, which is the shape looksTranslatable() rejects, so it
 * stays out of the catalogue without needing a rule of its own.
 */
export const EXPLORER_TABS = [
    { id: 'chat', label: 'Chat', screenshot: 'showcaseDesktop' },
    { id: 'editor', label: 'Editor', screenshot: 'showcaseDesktop' },
    { id: 'git', label: 'Git', screenshot: 'showcaseDesktop' },
    { id: 'terminal', label: 'Terminal', screenshot: 'showcaseDesktop' },
] as const;

/**
 * The hero: the H1's three lines, its aside, and the subhead under it.
 *
 * MOVED OUT OF src/i18n/messages/en.ts, WHICH IS WHY IT IS NOW TRANSLATED. That
 * catalogue is the site's first i18n mechanism and it has exactly two locales in
 * it — `en` and a partial `zh-Hans` — because every locale added there has to be
 * hand-written as a typed module. The overlay catalogue has all ten, generated
 * and validated. As long as the most prominent copy on the site lived in the
 * first one, the H1 and the sentence under it rendered in English on nine of ten
 * homepages while everything around them translated.
 *
 * `~~~` in the subhead is a RevealText no-break marker, not copy: it binds
 * "End-to-end" to "encrypted" so the pair never straddles a line break. It has
 * to survive translation — see src/components/RevealText.tsx.
 */
export const HERO = {
    headlineLineOne: 'Claude Code, Codex',
    headlineLineTwo: 'OpenCode, Pi',
    headlineLineTwoAside: '& 9 more',
    /**
     * Does the aside count the REMAINDER or the TOTAL?
     *
     * English says "& 9 more" — 4 named + 9 = 13. Chinese enumerations
     * idiomatically state the total after 等 ("等 13 种"), which asserts the
     * same fact by different arithmetic. Without this field the count guard
     * checks 4 + 13 = 13 against the Chinese and either fails on correct
     * copy or, as it did until now, never looks at anything but English.
     */
    headlineLineTwoAsideCounts: 'remainder' as 'remainder' | 'total',
    // "work" narrowed the promise to the working day and carried the wrong
    // connotation with it — a lot of this audience codes for pleasure. "go"
    // frames Happier as the thing you take with you, which is the claim the
    // rest of the page actually supports.
    headlineLineThree: 'Everywhere you go.',
    // "computer", never "machine": the reader's own laptop or desktop. In
    // Happier "machine" is a UI noun (the thing you pick in the machine
    // selector), and using it for both makes the sentence ambiguous.
    subhead:
        'Run them on your own computer, with your own subscriptions or API keys.\nOpen-source. End-to-end ~~~ encrypted. Self-hostable.',
} as const;
