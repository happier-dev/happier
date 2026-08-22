import type { ImageId } from './generatedImages';

export type FeatureImage = {
    /** Typed key into the build-generated responsive image manifest. */
    id: ImageId;
    /**
     * The asset already carries its own shadow, so CSS must not cast a second
     * one.
     *
     * `.fpanel__art img` applies `--fp-art-shadow` because the panel art is
     * normally a flat transparent cut-out with no plate of its own. Art that was
     * composed with a shadow baked in gets both, which reads as a doubled,
     * offset smear rather than as depth. Set this on those assets only.
     */
    ownShadow?: boolean;
};

/**
 * SHIPPED or UPCOMING, required on every feature.
 *
 * WHY THIS FIELD EXISTS. The agent pages were not the only place the unreleased
 * tree leaked onto the site: the FAQ named two voice modes — "OpenAI Realtime"
 * and "Codex Live" — that exist only in this repository's voice lab, in a
 * dev-only screen, while the released build offers four entirely different
 * ones. The leak was possible because nothing in the data said which release a
 * claim belonged to, so nobody was ever asked.
 *
 * Now everything is asked. There is no default: a new feature does not compile
 * until someone decides, and features.test.ts fails if anything marked
 * 'upcoming' renders without the not-yet-available label.
 *
 * THE CURRENT SET. All thirty entries below were checked against the RELEASED
 * tree on 2026-08-11, and the two added on 2026-08-14 ('machines', 'surfaces')
 * were checked the same way — every one of them is in it. The riskiest four
 * were the ones with no shipped docs page, and all four have shipped
 * implementations:
 *
 *   themes        apps/ui/sources/theme/profiles/themeProfileImportExport.ts
 *   automations   apps/ui/sources/sync/domains/automations/automationTypes
 *   agentActions  apps/docs/content/docs/clients/mcp.mdx (the actions spec)
 *   editor        apps/ui/sources/components/sessions/transcript/…
 *
 * A feature whose only evidence is in this repository is UPCOMING, whatever it
 * looks like in a screenshot.
 */
export type Availability = 'shipped' | 'upcoming';

export type Feature = {
    id: string;
    /** Required. See the Availability docblock — there is deliberately no default. */
    availability: Availability;
    eyebrow: string;
    title: string;
    body: string;
    visual: 'mobile' | 'desktop' | 'mobileAndDesktop';
    /** Each accent samples 1-2 adjacent bands of the hero planet so the
     *  feature glows feel like slices of the same image as the visitor scrolls. */
    accent: 'sun' | 'coral' | 'rose' | 'magenta' | 'blue' | 'indigo';
    /** Optional feature-specific image that replaces the generic device visual.
     *  Falls back to the device mockup if the file is absent (see FeatureImage). */
    image?: FeatureImage;
    /**
     * Optional shell transcript rendered under the body, one array entry per line.
     *
     * EVERY LINE MUST BE A COMMAND THAT RUNS. The renderer prints these verbatim
     * in a monospace block, which reads to a developer as a promise that they can
     * paste it — so an invented flag here is a worse defect than an invented
     * adjective anywhere else on the page. Each line below is checked against the
     * released CLI's own usage strings; the citations sit beside the strings.
     */
    code?: ReadonlyArray<string>;
};

export type GridFeature = {
    id: string;
    /** Required. See the Availability docblock — there is deliberately no default. */
    availability: Availability;
    title: string;
    body: string;
};

/**
 * Primary features shown in the alternating left/right layout.
 *
 * Order follows a deliberate narrative arc:
 *   promise -> adopt-nothing -> keep your terminal -> mobile power ->
 *   multi-agent -> control -> manage many -> review -> voice ->
 *   where it runs -> what drives it -> power-user wins -> cost ->
 *   reliability -> customization -> trust (closer).
 *
 * 'machines' and 'surfaces' are one row (5 + 7) and belong together: the first
 * answers "which computer executes this", the second "what can tell it to". They
 * sit immediately before 'mcp' on purpose, so the two MCP sentences on the page
 * are neighbours and read as the pair they are — Happier CONSUMING your MCP
 * servers, then Happier BEING one.
 *
 * Copy is grounded in the shipped implementation; terminology is checked
 * against real product strings (e.g. the "Needs attention" / "Working"
 * session groups, the cockpit tab set, cross-backend subagent runs).
 */
export const PRIMARY_FEATURES: ReadonlyArray<Feature> = [
    {
        id: 'anywhere',
        availability: 'shipped',
        eyebrow: 'Every device',
        title: 'Start coding anywhere. Continue everywhere.',
        body: 'Launch a session on your laptop. Follow it live, send messages, and approve permissions from your phone, tablet, browser, or desktop — without losing context.',
        visual: 'mobileAndDesktop',
        accent: 'sun',
        image: {
            id: 'feature_anywhere',
            ownShadow: true,
        },
    },
    {
        id: 'existingSessions',
        availability: 'shipped',
        eyebrow: 'Adoption-free',
        title: 'Your existing sessions? Already there.',
        body: 'Open any Claude Code, Codex, or OpenCode session running on your machine — live, from any device. Nothing to migrate, nothing to learn.',
        visual: 'mobileAndDesktop',
        accent: 'indigo',
        image: {
            id: 'feature_existing_sessions',
        },
    },
    {
        id: 'terminalTuis',
        availability: 'shipped',
        eyebrow: 'Stay in the terminal',
        title: 'You love the terminal? We do too.',
        body: 'Keep running Claude Code, Codex, or OpenCode in their native TUI. Happier mirrors them to every device, so you can follow along, send messages, and approve permissions from anywhere — and switch between the terminal and Happier whenever you like.',
        visual: 'desktop',
        accent: 'coral',
        image: {
            id: 'feature_terminal',
        },
    },
    {
        id: 'cockpit',
        availability: 'shipped',
        eyebrow: 'Mobile cockpit',
        // "Everything you need" was the old title, and it named nothing: it is
        // the same sentence a project-management tool or a note-taking app would
        // write, so it carried no information and no search term. The three
        // nouns below are the things a developer actually types into a search
        // box, and each one is a real tab: SessionMobileSurface is
        // 'chat' | 'browse' | 'git' | 'navigation' | 'tabs' | 'terminal'
        // (apps/ui/sources/components/workspaceCockpit/session/sessionCockpitState.ts:3).
        //
        // ONE HONEST GAP, and it is why the body says what it says. There is no
        // tab called "editor" — the editor opens from the `browse` tab when you
        // pick a file, and it is a real editor (Monaco on web, CodeMirror in a
        // WebView on native) that saves: SessionFileDetailsView passes
        // `saveFileEdits` to `onSaveEditingFile`
        // (apps/ui/sources/components/sessions/files/views/SessionFileDetailsView.tsx:368,604).
        // So the title names the capability and the body names the route to it.
        title: 'Editor. Git. Terminal. One tap away.',
        body: 'Chat, files, Git, and a live terminal, each its own tab. Open a file to read or edit it, review the diff, manage branches, and open a pull request — from your pocket.',
        visual: 'mobile',
        accent: 'blue',
        image: {
            id: 'feature_one_tap_away',
        },
    },
    {
        id: 'sessionTeam',
        availability: 'shipped',
        eyebrow: 'Multi-agent',
        // WHY THIS STOPPED BEING A SUBAGENT CARD. "One session. A whole team of
        // agents." described the smaller half of what ships. Subagents are a
        // feature every agent CLI has some version of; sessions that create,
        // message and read EACH OTHER are the differentiated claim, and all
        // three are shipped actions carrying `session_agent: true`, which is the
        // flag that says a running session may call them
        // (packages/protocol/src/actions/actionSpecs.ts):
        //
        //   session.spawn_new       ui_button/voice/session_agent/mcp/cli all true
        //   session.message.send    "Send a user message to the AI coding
        //                            assistant inside the specified session."
        //   session.transcript.get  "Read the semantic transcript for a session
        //                            as clean user/assistant messages…"
        //
        // The agent choice on a spawn is real too: session.spawn_new takes
        // `agentId` and `backendTargetKey` in its inputHints, which is what makes
        // "a Claude session and a Codex session" a thing you can set up rather
        // than a thing that happens to you. Subagents stay in the second half of
        // the body because they are still true — subagents.delegate.start and
        // subagents.plan.start take `backendTargetKeys` against
        // `execution.backends.enabled`.
        title: 'Your sessions work as a team.',
        body: 'A session can start another session, send it messages, and read its transcript — so a Claude session and a Codex session can split the work between them. Each one still runs its own subagents, on whichever backend you choose: Claude, Codex, or any ACP-compatible CLI.',
        visual: 'mobileAndDesktop',
        accent: 'magenta',
        image: {
            id: 'feature_sessions_team',
        },
    },
    {
        id: 'queue',
        availability: 'shipped',
        eyebrow: 'Stay in control',
        title: 'Queue it. Steer it. Fork it.',
        body: 'Queue messages while the agent works — reorder, edit, or send them now. Steer a running turn without interrupting it, or roll back to any earlier message and take a different path.',
        visual: 'mobile',
        accent: 'rose',
    },
    {
        id: 'attention',
        availability: 'shipped',
        eyebrow: 'Stay on top',
        title: 'Always know what needs you.',
        body: 'Sessions waiting on a decision rise to a “Needs attention” group at the top of your list; everything actively running gathers under “Working.” Run a dozen agents at once and never lose the thread.',
        visual: 'mobile',
        accent: 'sun',
        image: {
            id: 'feature_what_needs_you',
        },
    },
    {
        id: 'review',
        availability: 'shipped',
        eyebrow: 'Code review',
        title: 'Review the diff. Send notes to your agents.',
        body: 'Browse your agent’s changes. Mark the exact lines you want to address. Choose which notes to send, and hand them straight back — same session, or a new one.',
        visual: 'desktop',
        accent: 'coral',
        image: {
            id: 'feature_review',
        },
    },
    {
        /**
         * `sessions.agentSwitching` — server-gated, like `sessions.handoff`.
         *
         * TWO MECHANISMS, and the body describes the harder one. A session can
         * be forked into a different agent (a NEW session seeded with the
         * conversation), but the claim worth making is the in-place one: arming
         * another engine in the composer's agent chip continues the SAME
         * session, which the transcript marks with "Continued this Session from
         * X to Y" (apps/ui .../en.ts `session.agentContinuation.dividerTitle`).
         *
         * WHY "where it keeps one" IS NOT HEDGING. The handoff carries the
         * departing agent's own native log — Claude from its persisted
         * `claudeTranscriptPath`, Codex derived from the vendor resume id — but
         * only for agents that keep such a file
         * (apps/cli/src/session/agentTransition/buildSessionAgentTransitionActivationBrief.ts).
         * Without the qualifier this promises something several agents cannot do.
         *
         * THE LAST SENTENCE IS THE STRONGEST CLAIM ON THE PAGE, so it is the one
         * to keep exact. Returning to an agent that already ran this session is
         * a NATIVE RETURN: it resumes its own conversation and is sent only the
         * delta since it last saw the session, not the whole history again. An
         * agent that never ran it gets the full (bounded) tail instead. Same
         * file, `returningAgentLastSeenSeq`.
         */
        id: 'agentSwitching',
        availability: 'shipped',
        eyebrow: 'Never locked in',
        title: 'Start in Codex. Finish in Claude.',
        body: 'Change the engine mid-conversation and the same session keeps going. Your recent conversation carries over, and the new agent gets tools to read the rest — plus the previous agent’s own transcript, where it keeps one. Switch back later and it resumes its own thread, receiving only what it missed.',
        visual: 'mobileAndDesktop',
        accent: 'blue',
        /**
         * Carries BOTH mechanisms the body describes, which is why this asset
         * and not a cleaner single-surface one: the phone shows the in-place
         * "Continue with …" button the composer grows once another engine is
         * armed, and the sheet behind it shows the three fork routes.
         *
         * No `ownShadow`. The source is a hard cut-out — 0.7% of its pixels are
         * partially transparent, which is antialiasing, not a baked halo (the
         * one asset that does carry its own shadow, `anywhere`, measures 10%).
         * So CSS still owns the shadow here, as it does for every sibling.
         */
        image: {
            id: 'feature_agent_switching',
        },
    },
    {
        /**
         * Two inputs, one job, so one card: the phone gesture and the keyboard
         * are the same feature seen from two devices.
         *
         * "Teleport" is the mechanic, not decoration. The swipe is not
         * next/previous — the picker it opens reaches
         * SESSION_LATERAL_PICKER_REACH_ROWS + 1 = 19 sessions in a single
         * gesture, each named as it passes
         * (apps/ui .../lateralSwipe/sessionLateralPickerState.ts).
         *
         * WHY `Ctrl+Tab` AND NOT `Mod+Tab`. `Mod` resolves to Cmd on macOS and
         * Ctrl elsewhere (keyboard/bindings.ts:81), but this command is bound to
         * LITERAL Ctrl on every platform — Cmd+Tab is the macOS app switcher. So
         * the shortcut named here is correct on macOS, Windows and Linux alike;
         * only the browser differs (`blockedSurfaces: ['web']`, where it is
         * Alt+PageUp/Down), which is why `Alt+↑/↓` — true on every surface
         * including the browser — carries the sentence and Ctrl+Tab follows it.
         */
        id: 'navigation',
        availability: 'shipped',
        eyebrow: 'Move between sessions',
        title: 'Swipe to teleport. Or Ctrl+Tab.',
        body: 'Swipe across the bottom bar to slide between sessions — keep going in one gesture to skip several, each one named as you pass it. At a keyboard, Alt+↑/↓ walks the list and Ctrl+Tab walks your most recent sessions. Every shortcut is remappable.',
        visual: 'mobileAndDesktop',
        accent: 'blue',
        /**
         * The picker mid-gesture, which is the only frame that proves the claim:
         * five session names stacked at once with the reach counter beside them,
         * rather than a single next/previous transition that would look like a
         * tab switch. Same cut-out treatment as `agentSwitching` above.
         */
        image: {
            id: 'feature_navigation',
        },
    },
    {
        id: 'voice',
        availability: 'shipped',
        eyebrow: 'Hands-free',
        title: 'A colleague you can talk to.',
        body: 'The voice assistant watches every running session. Brainstorm the next change, approve a permission, or send a message — all without picking up the phone.',
        visual: 'mobile',
        accent: 'magenta',
        image: {
            id: 'feature_voice',
        },
    },
    {
        id: 'machines',
        availability: 'shipped',
        eyebrow: 'Every computer',
        // WHY THIS IS A PRIMARY CARD AND NOT A GRID LINE. Choosing where a
        // session runs is a decision the reader makes before they make any other
        // one, and the page had no sentence for it: 'anywhere' is about the
        // devices you WATCH from, and the grid's 'handoff' line is about moving a
        // session after it started. Neither says you get to pick in the first
        // place.
        //
        // WHAT IS CHECKED, AND WHERE.
        //   the picker    apps/ui/sources/components/sessions/new/components/
        //                 resolveMachinePickerPresence.ts returns
        //                 { status: 'online', selectable: true } and
        //                 'offline' | 'revoked' | 'replaced' with
        //                 selectable: false — which is exactly "marks which are
        //                 online, and starts sessions on those". MachineSelector
        //                 renders the unselectable ones rather than hiding them.
        //   over SSH      `happier machine setup --ssh <user@host>`
        //                 (apps/cli/src/cli/commands/machine/help.ts:8) and, in
        //                 the app, RemoteSshMachineSetupSection /
        //                 MachineSetupFlowScreen under settings/machines. Both
        //                 surfaces are why the sentence says "from the app or the
        //                 CLI" rather than naming one.
        //   the host list "VPS, home server, dev box" is the released docs' own
        //                 phrase for what the SSH bootstrap targets
        //                 (apps/docs/content/docs/clients/cli.mdx:89), so the
        //                 examples here are not invented. "VM" is deliberately
        //                 absent: nothing in the tree says it.
        title: 'Run sessions on every computer you own.',
        body: 'Connect your laptop, your desktop, a VPS, or a dev box, then pick which one runs each session. The picker marks which are online, and starts sessions on those. Add another over SSH, from the app or the CLI.',
        visual: 'mobileAndDesktop',
        accent: 'coral',
    },
    {
        id: 'surfaces',
        availability: 'shipped',
        eyebrow: 'App, voice, CLI, MCP',
        // THE CARD THE PAGE WAS MISSING. Everything else on this page describes a
        // screen. This describes the thing under all the screens: one registry of
        // 75 actions (packages/protocol/src/actions/actionIds.ts, ACTION_IDS) and
        // one executor (actionExecutor.ts), which every surface calls.
        //
        // "REGISTRY" IS A DESCRIPTION, NOT A NAME, and it is lowercase for that
        // reason. The shipped code files it under actionCatalog.ts and the
        // released docs say "the same action catalog as the app, CLI, voice, and
        // session-agent surfaces". Neither string is a capitalised product name,
        // so nothing here is being christened; if the product ever settles on one
        // of the two words in the UI, this copy should take that word.
        //
        // THE SURFACE LIST IS NOT A FIGURE OF SPEECH. It is a type. Every action
        // spec declares a boolean per surface, and the seven keys are exactly:
        //   ui_button, ui_slash_command, voice_tool, voice_action_block,
        //   session_agent, mcp, cli
        // (ActionSurfaceSchema, packages/protocol/src/actions/actionSpecs.ts).
        // The body names six things because it collapses the two voice keys into
        // "voice"; it names no surface that is not on that list.
        //
        // THE CONTROLS ARE PER ACTION AND PER SURFACE. ActionSettingsOverride
        // carries `disabledSurfaces` and `approvalRequiredSurfaces`, both arrays
        // of surface keys, keyed by action id (actionSettings.ts), and the app
        // has a screen per action for them (settings/actions/[actionId].tsx,
        // actionSettingsTargetApproval.ts).
        //
        // ONE NARROWING, STATED SO NOBODY WIDENS IT BACK. Approval is settable on
        // SURFACE targets — mcp, cli, session_agent, the two voice ones, and the
        // slash command — but not on the UI button placements: for those,
        // resolveActionSettingsApprovalSurface returns null and only the
        // enable/disable control exists. That is why the sentence says approval
        // is chosen per surface rather than "on every button".
        //
        // THE MCP SERVER IS `happier mcp serve`, NOT `happier mcp`.
        // `happier mcp` alone prints usage; `serve` is the stdio server, with
        // `start` kept as a compatibility alias
        // (apps/cli/src/cli/commands/mcp.ts:17-23, and the released
        // apps/docs/content/docs/clients/mcp.mdx says the same).
        // THE TITLE NAMES THE VERBS, NOT THE ARCHITECTURE. It read "The app,
        // voice, the CLI, and MCP run the same actions." — true, and abstract:
        // "the same actions" is a sameness claim about a mechanism, and a
        // reader who does not already know what a Happier action is gets
        // nothing from it. What they can do with it is spawn a session and run
        // it from whichever surface is in reach, so that is what it says.
        //
        // Both verbs are real actions on all four named surfaces:
        // `session.spawn_new` and `session.message.send` declare
        // ui_button/voice/session_agent/mcp/cli true (actionSpecs.ts), and the
        // CLI form of both is in the `code` block below.
        title: 'Spawn and manage sessions from the app, voice, the CLI and MCP.',
        body: 'Every action Happier can take — create a session, send it a message, set the model, start a review — is defined once, in one registry. The app, slash commands, voice, in-session agents, the CLI, and an external MCP host all call the same definition, and for each action you choose which of those surfaces can run it and which have to ask you first.',
        // VERIFIED, LINE BY LINE, AGAINST THE RELEASED CLI'S OWN USAGE STRINGS.
        //   happier mcp serve
        //     apps/cli/src/cli/commands/mcp.ts:17
        //     "happier mcp serve [--session <session-id>]"
        //   happier session list --json
        //     apps/cli/src/cli/commands/session/handleSessionCommand.ts:82
        //     "happier session list [--active] … [--json]"
        //   happier session send <id> "…"
        //     handleSessionCommand.ts:85
        //     "happier session send <session-id-or-prefix> <message> …"
        //   happier session actions list
        //     handleSessionCommand.ts:98  "happier session actions list [--json]"
        //   happier session actions execute <id> session.spawn_new
        //     handleSessionCommand.ts:100
        //     "happier session actions execute <session-id> <action-id>
        //      [--input-json <json>] …" — --input-json is optional, so the short
        //     form is a command that runs. `session.spawn_new` is a real
        //     ACTION_IDS entry, and the same string the other surfaces use.
        code: [
            'happier mcp serve',
            'happier session list --json',
            'happier session send <id> "rerun the failing test"',
            'happier session actions list',
            'happier session actions execute <id> session.spawn_new',
        ],
        visual: 'desktop',
        accent: 'sun',
    },
    {
        id: 'mcp',
        availability: 'shipped',
        eyebrow: 'Configure once',
        title: 'Your MCP servers. Every provider, every machine.',
        body: 'Define your MCP servers once. Happier makes them available across every backend — even ones with no native MCP support — and on every machine you connect. No reinstalling per provider, per device.',
        visual: 'desktop',
        accent: 'blue',
        image: {
            id: 'feature_mcp',
        },
    },
    {
        id: 'subscriptions',
        availability: 'shipped',
        eyebrow: 'Bring your own keys',
        title: 'Use the subscriptions you already pay for.',
        body: 'Happier reuses the subscriptions and logins your existing CLIs already use — Claude, Codex, Cursor, Gemini, OpenCode. No new bill. No double billing.',
        visual: 'mobile',
        accent: 'indigo',
        image: {
            id: 'feature_subscriptions',
        },
    },
    {
        id: 'accounts',
        availability: 'shipped',
        // "Never hit a wall" was the old eyebrow, and it is the same overreach
        // as the old title in miniature: you will still hit the wall. What
        // changes is what happens next. Duller and true beats punchy and false.
        eyebrow: 'More than one account',
        // "Sail past usage limits" was the old title. It reads as a promise to
        // evade a provider limit, which is both a terms-of-service risk and a
        // claim we cannot keep — src/data/copyClaims.test.ts bans the phrase.
        //
        // The body carries two scopes that an earlier draft of this copy got
        // wrong in opposite directions. (1) Nothing switches until you create a
        // pool; a pool is a deliberate object, not a thing that appears because
        // you connected a second account. (2) A live mid-session switch needs the
        // agent to declare the `same_connected_group` transition, and only Claude
        // and Codex do (packages/agents/src/manifest.ts:25,78) — so "Claude Code
        // and Codex" is a limit, not a name-drop, and must not be dropped for
        // rhythm. The per-turn ceiling is
        // ConnectedServiceAuthGroupPolicyV1Schema's `maxSwitchesPerTurn` default.
        title: 'Pool your accounts. Keep the session going.',
        body: 'Link multiple accounts per provider into a pool and watch usage and quota resets for every one of them in the app. Nothing switches until you build a pool — once you have, Claude Code and Codex sessions can change account without stopping, moving to whichever member has the most quota left, at most once a turn and never past a reset time the provider has published.',
        visual: 'mobile',
        accent: 'rose',
        image: {
            id: 'feature_sail_past_limits',
        },
    },
    {
        id: 'customization',
        availability: 'shipped',
        eyebrow: 'Make it yours',
        title: 'Configure (almost) everything.',
        body: 'Modes, models, and permissions per session. Tool-timeline detail levels. Notification routing. Custom themes you can build, import, and share. Tune Happier to exactly how you work.',
        visual: 'desktop',
        accent: 'sun',
    },
    {
        id: 'privacy',
        availability: 'shipped',
        eyebrow: 'Open & encrypted',
        title: 'Open-source. End-to-end encrypted.',
        body: 'Your code, prompts, and session content are encrypted on your device before they ever reach a server. Private by design. Open by default. Self-host in one command.',
        visual: 'mobileAndDesktop',
        accent: 'indigo',
    },
];

/**
 * Grid features shown in the compact 4x4 card grid.
 * Capabilities that don't need a full alternating section but deserve a
 * visible place on the page. Promoted features (subagents, queue, mcp, the
 * attention groups) now live in PRIMARY_FEATURES and are intentionally absent.
 */
export const GRID_FEATURES: ReadonlyArray<GridFeature> = [
    {
        id: 'handoff',
        availability: 'shipped',
        title: 'Hand off mid-session.',
        body: 'Move a live session from one machine to another and keep the same thread — pick up exactly where you left off.',
    },
    {
        id: 'sharing',
        availability: 'shipped',
        title: 'Code together.',
        body: 'Share a session with teammates, manage who can see and act, and collaborate in real time.',
    },
    {
        id: 'goals',
        availability: 'shipped',
        title: 'Track what matters.',
        body: 'First-class support for Codex goals and Claude’s task lists — see objectives, progress, and budget at a glance.',
    },
    {
        id: 'git',
        availability: 'shipped',
        title: 'Build it. Ship it.',
        body: 'Create pull requests, manage branches, push to remotes, stage, and review changed files — full source control from your phone.',
    },
    {
        id: 'folders',
        availability: 'shipped',
        title: 'Organize your way.',
        body: 'Group sessions into folders and subfolders with drag-and-drop, and focus on one folder at a time.',
    },
    {
        id: 'prompts',
        availability: 'shipped',
        title: 'Prompts, skills & templates.',
        body: 'Reusable prompts, skills, templates, and registries — define them once and use them everywhere.',
    },
    {
        id: 'memorySearch',
        availability: 'shipped',
        title: 'Search everything.',
        body: 'Semantic memory search across your sessions — your agents search context, and you search your whole history.',
    },
    {
        id: 'interSession',
        availability: 'shipped',
        title: 'Sessions that talk.',
        body: 'Select messages and send them between sessions; agents and sessions coordinate across your workspace.',
    },
    {
        id: 'agentActions',
        availability: 'shipped',
        title: 'Agents do what you do.',
        body: 'Through the Happier actions spec, agents create and manage sessions and navigate your workspace — with approvals when it matters.',
    },
    {
        id: 'multiSelect',
        availability: 'shipped',
        title: 'Select. Act. Done.',
        body: 'Multi-select sessions and act in bulk — archive, move to folders, or mark read in one tap.',
    },
    {
        id: 'editor',
        availability: 'shipped',
        title: 'Markdown that flows.',
        body: 'Rich, incrementally-streamed markdown in the transcript — tables, code fences, formatting that never jumps — with an optional Notion-style editor for markdown files.',
    },
    {
        id: 'themes',
        availability: 'shipped',
        title: 'Make it yours.',
        body: 'Build, import, and share custom color themes. Clone a preset and preview live as you edit.',
    },
    {
        id: 'imageGen',
        availability: 'shipped',
        title: 'Images, inline.',
        body: 'Agents that generate images render them right in the conversation, wherever you’re reading.',
    },
    {
        id: 'automations',
        availability: 'shipped',
        title: 'On a schedule.',
        body: 'Run sessions on a cadence to watch pull requests, track issues, or repeat any task automatically.',
    },
    {
        id: 'notifications',
        availability: 'shipped',
        title: 'The right ping.',
        body: 'Smart notifications route taps to the exact session and server — approve or answer right from the alert.',
    },
    {
        id: 'crossPlatform',
        availability: 'shipped',
        title: 'macOS, Linux, Windows.',
        body: 'Native apps for iOS and Android, a desktop app for every OS, and a web app — all in sync.',
    },
];
