/**
 * Prose lifted out of the page components by scripts/i18n-lift-jsx.mjs.
 *
 * GENERATED THE FIRST TIME, EDITED BY HAND AFTER THAT. Re-running the codemod
 * over an already-lifted page does nothing, because the prose is no longer in
 * the JSX to find — so this file is normal source from here on. Re-word a
 * sentence here, not in the component.
 *
 * `<1>…</1>` marks a slot: the element that wrapped that run of text in the
 * original markup, whose props live in the component and never reach a
 * translator. `{name}` is an interpolated value. Both are named, so a
 * translation may put them wherever the target language needs them. See
 * src/i18n/rich.tsx.
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
    },
    agentsIndex: {
        p0: "Happier installs on the computer that holds your repository, starts the vendor’s own CLI there as an ordinary subprocess under your own login, and carries the conversation to your other devices end-to-end encrypted. It hosts none of these agents, and puts no model of its own in front of them.",
        p1: "What that means in practice is that you keep every agent you already pay for and stop needing a different remote for each one. Each page below covers one agent in the detail you want before installing something: the command Happier runs and what it hands that binary, how a permission choice made on a phone is expressed to that particular CLI, which sign-in flow the app can start for you, how the binary gets onto your computer, whether the session can move to the agent’s own terminal interface, and the questions people ask about running it this way.",
        p2: "Per-agent limits — which sessions can be forked, resumed, reattached or moved to another computer — live in the Happier documentation rather than here, because the documentation ships with the product and a marketing page does not.",
        p3: "The release ships one more id than this page has cards for. Here it is, with the reason it has no page of its own.",
        p4: "Four more are defined and on the way. None of them is in the build you can install today, and none is counted in the {length} above.",
        p5: "Anything speaking the Agent Client Protocol can be added as a backend of your own without waiting for us. That path has no page here because what it can do is whatever your CLI implements, and writing a page about it would be writing a page about your code.",
        p6: "Install Happier on the computer that holds your code, then start any agent on this page by name — <1>happier claude</1>, <2>happier codex</2>, <3>happier opencode</3>. The agent runs there, under your own subscription or API key. Happier is the transport and the interface, not a middleman for the model call.",
    },
    alternatingFeatures: {
        p0: "Happier is the mobile-native control layer for the AI coding agents you already use. It mirrors your terminal, syncs every session, and gives you back the things a CLI can't: presence, approvals, voice, and one inbox for all of it.",
    },
    callToAction: {
        p0: "Run it on the computer that runs your code. Keep your own subscriptions and keys. Self-host the relay or use ours. MIT licensed, end-to-end encrypted.",
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
    },
    enterprisePage: {
        p0: "The shape is worth getting straight before the list. Sessions run on your developers’ own computers, against the provider CLIs they already have. The relay carries messages between those computers and their phones, browsers and desktops. It is the only piece that has to be reachable from outside, and it is the piece you are being asked to host.",
        p1: "Everything below is server configuration: environment variables on that container, enforced by that container, with no Happier-operated service in the path. The default posture of a fresh server is end-to-end encrypted storage and open signup, on the assumption that most people put it behind Tailscale. If you are reading this page you almost certainly want the opposite of the second half of that sentence.",
        p2: "What that encrypted default means underneath — which key is generated where, what your relay is left holding, and the columns it can read without one — is <1>the encryption architecture</1>, written for the developer rather than for you. It is the page to send anyone who asks what the server can see; this one stays on what you can enforce.",
        p3: "MIT. Not source-available, not open-core with the auth stack behind a commercial tier, not AGPL. Everything on this page is in the same repository as the client, under the same licence, and none of it is gated on a contract with us. If your organisation’s policy is that copyleft does not come inside the building, that policy does not stop here.",
        p4: "None of the controls above sits behind a purchase: there is no enterprise tier to buy and no seat count to negotiate for any of them. Depending on your procurement process that is either the reassuring part of this page or the concerning one. What you get instead is the source, an MIT licence and a container image.",
        p5: "The honest order is: stand the relay up on a throwaway host, point one developer at it, and read <1>GET /v1/features</1> to see exactly what that server is advertising to its clients. That response is the contract, and it is the fastest way to confirm a policy you set is a policy the clients will actually honour.",
        p6: "The <1>Docker deployment guide</1> covers the image, the volume and the Postgres override. The <2>server auth reference</2> covers every variable named above, including the recipes for a public server that requires GitHub or an OIDC provider.",
    },
    footer: {
        p0: "One open-source client for every coding agent — thirteen of them, run on your own computer, with your own subscriptions or API keys, end-to-end encrypted.",
    },
    heroShowcase: {
        p0: "Scroll to explore",
    },
    securityPage: {
        p0: "The variables that set all three, the at-rest options underneath them and the identity controls around them are the operator’s half of this, and they live on <1>the self-hosting page for teams</1>.",
        p1: "The <1>encryption model reference</1> covers the same ground as procedure — what restore asks of you, what each storage mode means for an account, which flow to reach for when a device cannot read a session yet.",
        p2: "Encryption is a claim about content, and a claim about content is only half an answer. Here is the other half, at the same level of detail: the columns a server operating this relay can read without a key.",
    },
    selfHost: {
        p0: "Run the Happier relay server on your own infrastructure. Your data never leaves your network.",
    },
    terminalPage: {
        p0: "Three of the thirteen, and they do not behave the same way. Codex is exclusive — one driver at a time. OpenCode is not, and Claude Code can be either, depending on which runtime you start it under.",
        p1: "The other ten agents Happier runs still start from the terminal with <1>happier <agent></1> and still appear on your phone. What they do not do is let you take the session back into their own TUI half way through.",
        p2: "Nothing on this page needs configuration if you start your sessions from the terminal — that path works the moment the CLI is installed. The settings that do need a decision are tmux integration, the Windows session mode and where the embedded terminal docks, and all three are in the <1>configuration reference</1>.",
    },
    usageLimitsPage: {
        p0: "A provider refuses a turn and Happier shows “Usage limit reached”, with the reset time when the provider supplied one. From there: wait — “Resume when limit resets” keeps the session and picks it up on its own — or “Check limit now” to re-probe, or stop waiting. Waiting is the one that keeps your afternoon: Happier holds the reset time, re-checks it for you, starts the session again if it had exited in the meantime, and sends a prompt to carry on from the interrupted context. Tick “Always wait and resume” once and you stop being asked — every limit after that is handled the same way with nobody watching. A Codex session goes one further and arms the wait by itself once “Continue automatically” is set.",
        p1: "That banner appears for Claude Code, Codex, OpenCode, Gemini and Pi. No other agent in the registry reports usage limits to Happier in a form it can act on, so what you get there is whatever the provider’s own CLI prints.",
        p2: "The defaults a new pool starts with. All of them are editable per pool.",
        p3: "One row per account you can connect. Being able to use a pool and being able to change account inside a running turn are two different capabilities, and the second one is rarer.",
        p4: "Connecting the accounts comes first, and that part has a <1>configuration reference</1>: how each provider’s sign-in works, which agent can consume which credential, and where the quota snapshots come from.",
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
    },
} as const;
