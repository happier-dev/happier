import type { ImageId } from './generatedImages';

export type FeatureImage = {
    /** Typed key into the build-generated responsive image manifest. */
    id: ImageId;
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
 * tree on 2026-08-11 and every one of them is in it — the riskiest four were
 * the ones with no shipped docs page, and all four have shipped implementations:
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
 *   power-user wins -> cost -> reliability -> customization -> trust (closer).
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
        },
    },
    {
        id: 'existingSessions',
        availability: 'shipped',
        eyebrow: 'Adoption-free',
        title: 'Already running a session? It’s already here.',
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
        title: 'Everything you need. One tap away.',
        body: 'Chat, files, Git, and a live terminal — one tap each. Browse and edit code, review diffs, manage branches, and open pull requests, straight from your pocket.',
        visual: 'mobile',
        accent: 'blue',
        image: {
            id: 'feature_one_tap_away',
        },
    },
    {
        id: 'subagents',
        availability: 'shipped',
        eyebrow: 'Multi-agent',
        title: 'One session. A whole team of agents.',
        body: 'Launch subagents to review, plan, or delegate — and choose which backend runs each one: Claude, Codex, or any ACP-compatible CLI. Mix providers in a single workspace and watch every subagent work in the timeline.',
        visual: 'mobileAndDesktop',
        accent: 'magenta',
    },
    {
        id: 'queue',
        availability: 'shipped',
        eyebrow: 'Stay in control',
        title: 'Queue it. Steer it. Fork it.',
        body: 'Queue messages while the agent works — reorder, edit, or send them now. Steer a running turn without interrupting it. Fork from any message to explore a different path.',
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
    },
    {
        id: 'review',
        availability: 'shipped',
        eyebrow: 'Code review',
        title: 'Review the diff. Send notes.',
        body: 'Browse your agent’s changes. Mark the exact lines you want to address. Choose which notes to send, and hand them straight back — same session, or a new one.',
        visual: 'desktop',
        accent: 'coral',
        image: {
            id: 'feature_review',
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
        body: 'Modes, models, and permissions per session. Tool-timeline detail levels. Notification routing. Keyboard shortcuts. Custom themes you can build, import, and share. Tune Happier to exactly how you work.',
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
