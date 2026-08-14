/**
 * FAQ copy.
 *
 * Two jobs: kill the objections that stop a developer installing, and rank for
 * the question queries in the Semrush set — "is claude code free" (2,900),
 * "is claude code open source" (590), "how to make claude code stop asking for
 * permission" (480), "how to check claude code usage" (320).
 *
 * ("what can claude code do that cursor cant (5,400)" used to be on that list.
 * It is not in the verified Semrush set — it was the one invented number in the
 * repository, and it is removed rather than re-cited.)
 *
 * HOUSE RULE: an answer that needs a caveat gets the caveat in the same
 * paragraph, never in a footnote. A visitor who finds the caveat later on their
 * own has been sold to; a visitor who finds it here has been told.
 *
 * WORD CHOICE: "computer" is the reader's own laptop or desktop. "machine" is
 * the Happier UI noun — the thing you pick in the machine selector, which may be
 * a VPS you have never touched. They are paired once, on first use, in the
 * `sleep` answer, and never used interchangeably after that.
 *
 * NO FAQPage JSON-LD. Google deprecated FAQ rich results for non-government,
 * non-health sites on 2026-05-07, so the markup buys a developer tool nothing
 * and still carries spam risk. See the structured-data comment in index.html.
 *
 * SOURCE OF TRUTH: for Happier's own behaviour it is the SHIPPED CODE, never a
 * docs page. Our docs lag the product — Claude's unified terminal ships and
 * appears in none of the 225 pages, and providers/claude.mdx predates the third
 * runtime mode — so a docs anchor may support a claim but may never be the only
 * thing holding it up. For a VENDOR's behaviour (Anthropic, OpenAI) their own
 * documentation is the source of truth and is quoted with attribution.
 *
 * And the evidence lives HERE, in the comments, not in the sentence. A claim on
 * the page is stated in the product's voice; the file, the line and the quote
 * that make it true belong in a docblock beside it. An answer that cites our own
 * source material reads as though the writer had to look Happier up.
 *
 * Verification anchors (paths relative to happier-dev/happier @ v0.2 unless
 * marked otherwise; docs paths are apps/docs/content/docs/):
 *   MIT licence              LICENCE (repo root)
 *   nothing is paid          apps/ui/app.config.js:460-462 — RevenueCat keys are
 *                              read from EXPO_PUBLIC_* only;
 *                            apps/ui/sources/sync/engine/purchases/
 *                              syncPurchases.ts:32-34 — no key, no configure();
 *                            apps/ui/sources/components/settings/
 *                              SettingsView.tsx:57-58,92,389 — `isPro` is used
 *                              nowhere but the supporter row, which is itself
 *                              behind `devModeEnabled`
 *   prompt personalization   packages/protocol/src/prompts/systemPromptBaseV1.ts
 *                              + prompts/codingPromptBehaviorV1.ts;
 *                            apps/ui/sources/app/(app)/settings/session.tsx.
 *                            Full working in the comment on the `tokens` entry.
 *   E2EE default             packages/protocol/src/features/payload/capabilities/
 *                              encryptionCapabilities.ts (defaultAccountMode 'e2ee')
 *   storage modes            docs security/index.mdx
 *   self-host relay          apps/cli/src/cli/commands/relay/host.ts
 *   background service       docs clients/daemon.mdx
 *   resume / offline machine docs features/session-resume.mdx
 *   attach + tmux            docs features/attach-to-session.mdx
 *   permission modes         packages/agents/src/types.ts:24-32
 *                              (PERMISSION_INTENTS) + docs features/permissions.mdx:19-33
 *   per-agent default mode   apps/ui/sources/app/(app)/settings/providers/
 *                              [providerId].tsx:163-171
 *                              (sessionDefaultPermissionModeByTargetKey)
 *   quota snapshots          docs features/connected-services.mdx:228-238
 *   model switching          docs features/model-and-engine-selection.mdx
 *   subagent backends        docs features/subagents.mdx:158-163
 *   session sharing          packages/protocol/src/updates.ts:250,259 —
 *                              `accessLevel: z.enum(['view','edit','admin'])`.
 *                              NOT docs features/session-sharing.mdx: that page
 *                              exists only in the unreleased tree, and an anchor
 *                              a checker cannot open is worse than none.
 *   Windows session hosts    docs platforms/windows.mdx
 *   iPad                     apps/ui/app.config.js:294 (supportsTablet: true)
 *   download surfaces        src/data/downloads.ts (this repo)
 *   Remote Control limits    code.claude.com/docs/en/remote-control, fetched
 *                              2026-08-11 — quoted, never paraphrased
 */

export type FaqItem = {
    id: string;
    q: string;
    /** Paragraphs. Rendered as separate <p> so a caveat gets its own beat. */
    a: ReadonlyArray<string>;
};

export const FAQ_ITEMS: ReadonlyArray<FaqItem> = [
    {
        id: 'free',
        q: 'Is Happier free?',
        a: [
            'Yes. Completely. The CLI, the mobile apps, the desktop app, the web app and the relay are free and MIT-licensed — no seat count, no trial, no feature gate.',
            // The sentence that used to open this paragraph — "The catch, such
            // as it is, is that Happier does not sell you model access…" — is
            // gone. In an answer titled "Is Happier free?" the word "catch"
            // does the damage on its own, whatever follows it: the reader stops
            // reading the sentence and starts looking for the trap. The two
            // sentences that remain make the same point as a positive.
            'It runs the CLI you already have — Claude Code, Codex, OpenCode — on your own computer, against the Claude or ChatGPT subscription or the API key you are already paying for. That invoice stays exactly where it was, and it is the only one in the picture.',
        ],
    },
    {
        id: 'openSource',
        q: 'Is it open source?',
        a: [
            // One paragraph on purpose. The second one used to answer a
            // question nobody asked here — "what happens if you stop working on
            // it" — and raising a shutdown inside the open-source answer turns
            // the licence from a strength into a contingency plan. The reader
            // who wants that question answered has their own entry below
            // (`shutdown`), where it is theirs to raise rather than ours.
            'Yes — MIT licensed, the whole thing: the CLI, the apps and the relay server. github.com/happier-dev/happier.',
        ],
    },
    {
        id: 'tokens',
        q: 'Does Happier use extra tokens?',
        /*
         * The answer is "no", and the old one never got round to saying it. It
         * spent its second paragraph on voice and memory search — two features
         * that speak to a model of their own — which turned a clean no into a
         * hedge, and framed voice as a token-costing exception when voice costs
         * what it costs in any other client running the same thing.
         *
         * What Happier actually adds to a coding prompt, and the settings that
         * remove it, verified in the shipped tree at
         * happier-dev/remote-dev @ cdb9408c0:
         *
         *   packages/protocol/src/prompts/systemPromptBaseV1.ts:65-84 —
         *     buildHappierBaseSystemPromptV1() assembles at most four blocks:
         *     SESSION_TITLE (initial or ongoing), OPTIONS, ATTACHMENTS and
         *     LINKED_WORKSPACE_FILES. The first two are conditional; the last
         *     two always ship, and they are ~90 words between them.
         *   packages/protocol/src/prompts/codingPromptBehaviorV1.ts:5-23 —
         *     the setting is `codingPromptBehaviorV1`, with
         *     `sessionTitleUpdates: 'disabled' | 'initial' | 'ongoing'`
         *     (default 'ongoing') and `responseOptions: 'agent' | 'disabled'`
         *     (default 'agent'). Those two keys are the whole switchable
         *     surface — there is no third toggle to name.
         *   apps/ui/sources/app/(app)/settings/session.tsx:36,95-130 — both are
         *     edited on the Sessions settings screen; the title control is a
         *     three-way picker, response options is a switch.
         *   apps/ui/sources/text/translations/en.ts:7750-7765 — the shipped
         *     labels, quoted here so the page and the app agree: the group is
         *     "Prompt personalization", the picker is "Session title updates"
         *     with "Never" / "At session start" / "When the task changes", and
         *     the switch is "Ask the agent to suggest reply options".
         *   apps/ui/sources/components/settings/SettingsBelowFoldSections.tsx:226-231
         *     + translations en.ts:1692,1698 — the route to it is
         *     Settings → Sessions & Behavior → Sessions.
         *
         * NAME ONLY THOSE TWO. Anything else in the base prompt is not
         * switchable, and a setting the reader cannot find is worse than no
         * setting at all.
         */
        a: [
            'No. Your agent talks straight to its own provider: Claude Code, Codex, Gemini and the rest run on your computer, with their own auth and their own harness, exactly as they do in your terminal. Happier is the client around that, so a prompt costs what it cost before.',
            'Happier does add a small amount of instruction of its own, and two pieces of it are yours to switch off under Settings → Sessions → Prompt personalization. “Session title updates” asks the agent to name the session, and you can set it to never, to session start only, or to update again when the task changes. “Ask the agent to suggest reply options” asks it to offer tappable answers when it puts a question to you, and it is a single switch. Turn both off and what is left is two short paragraphs telling the agent how file attachments and `@path` references arrive.',
        ],
    },
    {
        id: 'tos',
        q: 'Could using Happier get my provider account banned?',
        a: [
            'When Happier runs a session it launches the provider’s own CLI on your own computer, signed in the way you signed it in. From Anthropic’s or OpenAI’s side that is the same CLI, on the same computer, on your own account — the ordinary supported use of the tool. What changes is who typed the launch command: `claude`, `codex` or `opencode`, started by Happier instead of by you.',
            'We’re not lawyers, we give no guarantee, and provider terms change. Read them. If your organisation has an agreement with a provider, check it before you connect a work account.',
        ],
    },
    {
        id: 'code',
        q: 'Is my code sent anywhere?',
        a: [
            'Your code stays on your computer. The agent reads and writes files locally; what syncs is the conversation and the session state needed to show you the same session on another device.',
            'That sync is end-to-end encrypted by default: content is encrypted on your device and the server stores ciphertext it cannot read. Message ids, timestamps, device ids and session ids are metadata and are not encrypted. There is also an explicit plaintext mode for people who want server-readable content — it is opt-in, it is labelled, and it is not the default.',
            'If you want none of it on someone else’s hardware, `happier relay host install` puts the relay on a computer you own, and the whole path becomes your device → your relay → your computer.',
        ],
    },
    {
        id: 'others',
        q: 'Can anyone else see my sessions?',
        a: [
            'Not unless you hand them the link. In the default end-to-end encrypted mode the relay holds ciphertext it has no key for; what it can see is the routing metadata — account ids, timestamps, message sizes — and nothing of what you or the agent said.',
            'Sharing is a deliberate act with three shapes: share a session with a friend as view-only, share it as can-edit so they can type into the same transcript, or publish a read-only public link. Nothing is shared because a session exists, and shared sessions show up in their own group in the list rather than blending into yours.',
        ],
    },
    {
        id: 'shutdown',
        q: 'What if the project stops?',
        a: [
            'The licence is MIT and the relay is self-hostable, so the failure mode is “you run it yourself”, not “you lose your work”. Your sessions live on your own computer either way — Happier is a client over them.',
        ],
    },
    {
        id: 'server',
        q: 'Do I need a server?',
        a: [
            'No. Install the CLI on the computer that runs your code, pair a device by QR, and you are done — Happier’s hosted relay does the rest at no cost.',
            'Running your own relay is an option, not a requirement. `happier relay host install` sets it up as a managed service; there is also a Docker image and a runner. Bind it to localhost, your LAN, or the open internet, and reach it over Tailscale, an SSH tunnel or direct HTTPS.',
        ],
    },
    {
        id: 'agents',
        q: 'Which agents does Happier support?',
        a: [
            'Thirteen ship as built-ins: Claude Code, Codex, OpenCode, Cursor, Gemini, Copilot, Qwen, Kimi, Auggie, Kilo, Kiro, Pi and Grok. Beyond those, the Custom ACP backend takes any CLI that speaks the Agent Client Protocol, and once you have defined it, it appears in the agent picker next to the built-ins.',
            'Happier does not bundle the agent CLIs. It detects what is installed on the computer you selected and shows you the rest — each agent’s settings page reports detection status and can run a best-effort installer on that computer if you want it to. Not every agent supports every Happier feature, either; session handoff, for one, is Claude and OpenCode today and experimental on Codex.',
        ],
    },
    {
        id: 'plan',
        q: 'Does it work with my Claude or Codex subscription?',
        a: [
            'Yes. Happier uses the login your CLI already has, so a Claude Pro or Max subscription, a ChatGPT subscription through the Codex CLI, or a Gemini login keeps working exactly as it does now. No second bill, no key re-entry, no proxy in the middle.',
            'API keys work too, and so do alternative endpoints — DeepSeek, Z.AI, MiniMax, Azure OpenAI, Vertex AI, or your own gateway, chosen per session with a backend profile. Anthropic’s own Remote Control documentation rules that path out on its side: “API keys are not supported”, and as of Claude Code v2.1.196 Remote Control is “disabled when `ANTHROPIC_BASE_URL` points at a host other than `api.anthropic.com`, such as an LLM gateway or proxy”.',
        ],
    },
    {
        id: 'claudeCodeFromPhone',
        q: 'Can I actually run Claude Code from my phone?',
        a: [
            'Yes, and the distinction that matters is where it runs: Claude Code runs on your computer, and your phone is the window. Install the CLI once, leave the background service running, and you can start a session from the app — the runtime on your computer receives the request and launches `claude` locally, in your repo, with your MCP servers and your config.',
            'A session you already started in your terminal is reachable too. Direct sessions let you browse and follow the Claude Code, Codex and OpenCode sessions that already exist on that computer without importing them first, and you can take one over from the phone when you want to steer it.',
        ],
    },
    {
        id: 'multiDevice',
        q: 'Can I have the same session open on more than one device?',
        a: [
            'Yes. A Happier session is not owned by whichever client opened it — it lives on the computer running the agent, and the transcript syncs to every device signed into the same account. Laptop, phone and a browser tab can all be on the same session, and a message sent from one appears on the others.',
            // Three agents, and only three, carry a real attach strategy:
            // packages/agents/src/manifest.ts:56 (claude, 'tmux'), :140 (codex,
            // 'tmux') and :196 (opencode, 'provider_attach'). Every other entry
            // is 'unsupported' or absent. The sentence used to carry that
            // provenance out loud — "the three the shipped manifest gives a real
            // attach strategy" — which cited our own source material at a reader
            // who has no way to open it. The names are the claim; the file is
            // the proof, and the proof belongs here.
            'The other direction works too: `happier attach <session-id>` drops you back into a session you started from the app, on the computer that owns it. For Claude Code, Codex and OpenCode that hand-off puts you in the agent’s own TUI; for the rest, the terminal shows Happier’s view of the session rather than the vendor’s.',
        ],
    },
    {
        id: 'multipleAgents',
        q: 'Can I run several agents at once?',
        a: [
            'Yes, and it is the normal way to use it. Run as many sessions as your computer and your quota will carry, across different agents at the same time. Sessions waiting on a decision rise into a “Needs attention” group at the top of the list and everything still running gathers under “Working”, which is what makes a dozen at once readable rather than chaotic.',
            'Inside a single session you can also launch subagents and choose the backend for each one — a built-in agent or a Custom ACP backend. Selecting several different backends starts one run per backend, so a review can go to Codex while a plan run goes to Claude.',
        ],
    },
    {
        id: 'models',
        q: 'Can I change the model without starting over?',
        a: [
            'Usually. A running session has a model picker in its input settings, listing the agent’s own models plus the models from every Provider connection you have enabled and that the agent can actually use. There is also a “Use CLI settings” option, which tells Happier to set no override at all and let the CLI decide from its own config.',
            'Whether the change lands mid-session is up to the agent runtime: some apply it to the next prompt, others need a restart or a fork. Happier tells you which and never silently swaps you to a different connection or falls back to a native model behind your back.',
        ],
    },
    {
        id: 'permissions',
        q: 'Do I have to approve every permission prompt?',
        a: [
            'Only as much as you want to. There are four permission modes: Default, which leaves the provider’s normal ask-when-needed behaviour alone; Read-only, where the agent can inspect but write-like actions are denied; Safe YOLO, which auto-allows reads and still asks before writes; and YOLO, which skips approvals as far as the provider allows. Set it per session, change it while one is running, or set a default per agent under Settings → Providers so new Claude sessions start read-only and new Codex sessions do not.',
            'Two things worth knowing. Not every provider supports every mode — where one does not, Happier falls back to the closest supported behaviour and shows you the Effective policy rather than pretending. And Plan is a session mode, not a permission mode: being in Plan does not mean auto-approve, and you can still get prompts.',
            'When a session does need you, it moves into the “Needs attention” group and pushes a notification you can answer from the alert, so approving is a tap rather than a trip back to the laptop.',
        ],
    },
    {
        id: 'usage',
        q: 'Can I see how much of my quota I have used?',
        a: [
            'Yes, for the providers that publish it — today that is Codex, Claude subscription and Gemini accounts connected through Connected services. Each profile shows a quota meter and reset time, the meters appear again in the new-session auth picker, and the composer carries a usage badge while you work, so you can see a limit coming instead of discovering it mid-turn.',
            'Where a provider publishes no usage endpoint, Happier shows nothing rather than guessing.',
        ],
    },
    {
        id: 'sleep',
        q: 'What happens if my laptop sleeps or the Wi-Fi drops?',
        a: [
            'The honest answer is that the session stops making progress, because the agent is a process on your computer and Happier does not pretend otherwise. When the computer running a session goes offline, the app marks that machine — the Happier word for a computer you have connected — as unreachable and disables input on its sessions until it is back.',
            // Was: "…If a session cannot be resumed, Happier says so instead of
            // quietly opening a fresh one and letting you find out later." A
            // failure mode nobody asked about, described in the words of the
            // product that would hide it — the reader now has "quietly opening a
            // fresh one" in their head, which is the one thing we wanted them
            // never to picture. The recovery is the answer; state it.
            'What Happier does do is make the recovery cheap. The transcript stays intact while the session sits idle, and when the computer comes back you pick the session up where you were, from whichever device is in your hand.',
            'If you want work to survive the lid closing, run it somewhere that stays awake — a desktop, a VPS, a box that stays plugged in — and install the background service so that computer is ready to start sessions without a terminal open.',
        ],
    },
    {
        id: 'closingApp',
        q: 'What happens when I close the app?',
        a: [
            'Nothing stops. The agent runs on your computer under the background service, not inside the phone app, so quitting the app is closing a window onto the session rather than ending it. Reopen it later — or open it somewhere else — and you get the same transcript from where it got to.',
            'You do not have to keep checking, either. Happier pushes a notification when a turn finishes, when a permission is needed, and when an action wants a human answer, and the notification routes straight back into the session that raised it.',
        ],
    },
    {
        id: 'sshTmux',
        q: 'Why not just SSH in and use tmux?',
        a: [
            'If tmux is working for you, keep it — Happier does not take it away. Start a session from the app and `happier attach` reattaches you to the live tmux session in your own terminal, with the provider’s native TUI, and you can go back to the app afterwards on the same session.',
            'The difference is what happens when you are not at a keyboard. SSH gives you a terminal on a phone screen; Happier gives you a push notification when a permission is waiting, a tap to approve it, a readable diff of what the agent changed, file and Git surfaces, and one list covering every session on every computer you have connected. On a laptop the two are close. On a phone at a bus stop they are not.',
        ],
    },
    {
        id: 'platforms',
        q: 'Does it work on Windows and Linux?',
        a: [
            'Yes. The CLI installs on macOS, Linux and Windows — `curl -fsSL https://happier.dev/install | bash`, or `iwr https://happier.dev/install.ps1 -useb | iex` on Windows. There are native iOS and Android apps, a desktop app, and a web app at app.happier.dev.',
            'Windows gets its own session-hosting model: a session started from the app can run hidden, in Windows Terminal, or in a console host, and `happier attach` brings that host back to the foreground. Some agent CLIs are better supported on Unix than on Windows — that is the CLI vendor’s coverage, not Happier’s, and the app tells you which ones are available on the computer you selected.',
        ],
    },
    {
        id: 'mobileApp',
        q: 'Do I need the mobile app?',
        a: [
            'No. app.happier.dev is the full app in a browser tab, and there is a desktop build for macOS, Windows and Linux if you would rather it was a window than a tab. Plenty of people run Happier entirely on the same computer their sessions run on, for the diff review and the session list rather than for the mobility.',
            'If you do want it on a phone: iOS is on the App Store. Android is a direct APK download from the GitHub releases — there is no public Play listing yet, only a closed testing track you have to be opted into, and we would rather say that than link you at a 404.',
        ],
    },
    {
        id: 'ipad',
        q: 'Does it work on an iPad?',
        a: [
            'Yes. The iOS app is built with tablet support, so it installs from the same App Store listing and runs as a native iPad app rather than a stretched phone one. The web app in Safari works too if you would rather not install anything.',
            'The tablet layout is the useful part: the embedded terminal defaults to a docked bottom panel on tablet-sized screens, the way it does on the web, instead of the single-focus presentation phones get. An iPad and a keyboard is a genuinely reasonable place to review a diff and steer a session.',
        ],
    },
    {
        id: 'workComputer',
        q: 'Can I use it on a work computer?',
        a: [
            'Technically, easily: it is MIT-licensed source you can read before you run it, session content is end-to-end encrypted by default, and `happier relay host install` puts the relay inside your own network so no session content transits infrastructure you do not control. That covers most of what a security review asks.',
            'Organisationally, ask first. Your employer may have rules about what runs on the endpoint, and your provider agreement may have rules about connecting a work account to third-party tooling. Neither of those is a question a marketing page can answer for you — check them before you connect a work account, not after.',
        ],
    },
];
