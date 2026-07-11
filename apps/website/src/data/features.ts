export type FeatureImage = {
    /** PNG source (also the fallback). Optimized siblings (@2x, .webp) are
     *  produced by `scripts/optimize-feature-images.mjs` and resolved by the
     *  renderer. If the file is missing the visual falls back to the device
     *  mockup, so it is always safe to reference art that doesn't exist yet. */
    src: string;
    src2x?: string;
};

export type Feature = {
    id: string;
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
        eyebrow: 'Every device',
        title: 'Start coding anywhere. Continue everywhere.',
        body: 'Launch a session on your laptop. Follow it live, send messages, and approve permissions from your phone, tablet, browser, or desktop — without losing context.',
        visual: 'mobileAndDesktop',
        accent: 'sun',
        image: {
            src: '/images/features/start-anywhere-continue-everywhere.png',
            src2x: '/images/features/start-anywhere-continue-everywhere@2x.png',
        },
    },
    {
        id: 'existingSessions',
        eyebrow: 'Adoption-free',
        title: 'Already running a session? It’s already here.',
        body: 'Open any Claude Code, Codex, or OpenCode session running on your machine — live, from any device. Nothing to migrate, nothing to learn.',
        visual: 'mobileAndDesktop',
        accent: 'indigo',
        image: {
            src: '/images/features/existing-sessions.png',
            src2x: '/images/features/existing-sessions@2x.png',
        },
    },
    {
        id: 'terminalTuis',
        eyebrow: 'Stay in the terminal',
        title: 'You love the terminal? We do too.',
        body: 'Keep running Claude Code, Codex, or OpenCode in their native TUI. Happier mirrors them to every device, so you can follow along, send messages, and approve permissions from anywhere — and switch between the terminal and Happier whenever you like.',
        visual: 'desktop',
        accent: 'coral',
        image: {
            src: '/images/features/terminal.png',
            src2x: '/images/features/terminal@2x.png',
        },
    },
    {
        id: 'cockpit',
        eyebrow: 'Mobile cockpit',
        title: 'Everything you need. One tap away.',
        body: 'Chat, files, Git, and a live terminal — one tap each. Browse and edit code, review diffs, manage branches, and open pull requests, straight from your pocket.',
        visual: 'mobile',
        accent: 'blue',
        image: {
            src: '/images/features/one-tap-away.png',
            src2x: '/images/features/one-tap-away@2x.png',
        },
    },
    {
        id: 'subagents',
        eyebrow: 'Multi-agent',
        title: 'One session. A whole team of agents.',
        body: 'Launch subagents to review, plan, or delegate — and choose which backend runs each one: Claude, Codex, or any ACP-compatible CLI. Mix providers in a single workspace and watch every subagent work in the timeline.',
        visual: 'mobileAndDesktop',
        accent: 'magenta',
        image: {
            src: '/images/features/subagents.png',
            src2x: '/images/features/subagents@2x.png',
        },
    },
    {
        id: 'queue',
        eyebrow: 'Stay in control',
        title: 'Queue it. Steer it. Fork it.',
        body: 'Queue messages while the agent works — reorder, edit, or send them now. Steer a running turn without interrupting it. Fork from any message to explore a different path.',
        visual: 'mobile',
        accent: 'rose',
        image: {
            src: '/images/features/queue-steer-fork.png',
            src2x: '/images/features/queue-steer-fork@2x.png',
        },
    },
    {
        id: 'attention',
        eyebrow: 'Stay on top',
        title: 'Always know what needs you.',
        body: 'Sessions waiting on a decision rise to a “Needs attention” group at the top of your list; everything actively running gathers under “Working.” Run a dozen agents at once and never lose the thread.',
        visual: 'mobile',
        accent: 'sun',
    },
    {
        id: 'review',
        eyebrow: 'Code review',
        title: 'Review the diff. Send notes.',
        body: 'Browse your agent’s changes. Mark the exact lines you want to address. Choose which notes to send, and hand them straight back — same session, or a new one.',
        visual: 'desktop',
        accent: 'coral',
        image: {
            src: '/images/features/review.png',
            src2x: '/images/features/review@2x.png',
        },
    },
    {
        id: 'voice',
        eyebrow: 'Hands-free',
        title: 'A colleague you can talk to.',
        body: 'The voice assistant watches every running session. Brainstorm the next change, approve a permission, or send a message — all without picking up the phone.',
        visual: 'mobile',
        accent: 'magenta',
        image: {
            src: '/images/features/voice.png',
            src2x: '/images/features/voice@2x.png',
        },
    },
    {
        id: 'mcp',
        eyebrow: 'Configure once',
        title: 'Your MCP servers. Every provider, every machine.',
        body: 'Define your MCP servers once. Happier makes them available across every backend — even ones with no native MCP support — and on every machine you connect. No reinstalling per provider, per device.',
        visual: 'desktop',
        accent: 'blue',
        image: {
            src: '/images/features/mcp.png',
            src2x: '/images/features/mcp@2x.png',
        },
    },
    {
        id: 'subscriptions',
        eyebrow: 'Bring your own keys',
        title: 'Use the subscriptions you already pay for.',
        body: 'Happier reuses the subscriptions and logins your existing CLIs already use — Claude, Codex, Cursor, Gemini, OpenCode. No new bill. No double billing.',
        visual: 'mobile',
        accent: 'indigo',
        image: {
            src: '/images/features/connected-services.png',
            src2x: '/images/features/connected-services@2x.png',
        },
    },
    {
        id: 'accounts',
        eyebrow: 'Never hit a wall',
        title: 'Pool your accounts. Sail past usage limits.',
        body: 'Link multiple accounts per provider into a pool. When one hits its limit, Happier switches to another and keeps the session going — preferring whichever account has the most quota left, and switching proactively before you hit the wall. Monitor usage and quota resets for every account, right in the app.',
        visual: 'mobile',
        accent: 'rose',
        image: {
            src: '/images/features/connected-services-pools-resets.png',
            src2x: '/images/features/connected-services-pools-resets@2x.png',
        },
    },
    {
        id: 'customization',
        eyebrow: 'Make it yours',
        title: 'Configure (almost) everything.',
        body: 'Modes, models, and permissions per session. Tool-timeline detail levels. Notification routing. Keyboard shortcuts. Custom themes you can build, import, and share. Tune Happier to exactly how you work.',
        visual: 'desktop',
        accent: 'sun',
    },
    {
        id: 'privacy',
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
        title: 'Hand off mid-session.',
        body: 'Move a live session from one machine to another and keep the same thread — pick up exactly where you left off.',
    },
    {
        id: 'sharing',
        title: 'Code together.',
        body: 'Share a session with teammates, manage who can see and act, and collaborate in real time.',
    },
    {
        id: 'goals',
        title: 'Track what matters.',
        body: 'First-class support for Codex goals and Claude’s task lists — see objectives, progress, and budget at a glance.',
    },
    {
        id: 'git',
        title: 'Build it. Ship it.',
        body: 'Create pull requests, manage branches, push to remotes, stage, and review changed files — full source control from your phone.',
    },
    {
        id: 'folders',
        title: 'Organize your way.',
        body: 'Group sessions into folders and subfolders with drag-and-drop, and focus on one folder at a time.',
    },
    {
        id: 'prompts',
        title: 'Prompts, skills & templates.',
        body: 'Reusable prompts, skills, templates, and registries — define them once and use them everywhere.',
    },
    {
        id: 'memorySearch',
        title: 'Search everything.',
        body: 'Semantic memory search across your sessions — your agents search context, and you search your whole history.',
    },
    {
        id: 'interSession',
        title: 'Sessions that talk.',
        body: 'Select messages and send them between sessions; agents and sessions coordinate across your workspace.',
    },
    {
        id: 'agentActions',
        title: 'Agents do what you do.',
        body: 'Through the Happier actions spec, agents create and manage sessions and navigate your workspace — with approvals when it matters.',
    },
    {
        id: 'multiSelect',
        title: 'Select. Act. Done.',
        body: 'Multi-select sessions and act in bulk — archive, move to folders, or mark read in one tap.',
    },
    {
        id: 'editor',
        title: 'Markdown that flows.',
        body: 'Rich, incrementally-streamed markdown in the transcript — tables, code fences, formatting that never jumps — with an optional Notion-style editor for markdown files.',
    },
    {
        id: 'themes',
        title: 'Make it yours.',
        body: 'Build, import, and share custom color themes. Clone a preset and preview live as you edit.',
    },
    {
        id: 'imageGen',
        title: 'Images, inline.',
        body: 'Agents that generate images render them right in the conversation, wherever you’re reading.',
    },
    {
        id: 'automations',
        title: 'On a schedule.',
        body: 'Run sessions on a cadence to watch pull requests, track issues, or repeat any task automatically.',
    },
    {
        id: 'notifications',
        title: 'The right ping.',
        body: 'Smart notifications route taps to the exact session and server — approve or answer right from the alert.',
    },
    {
        id: 'crossPlatform',
        title: 'macOS, Linux, Windows.',
        body: 'Native apps for iOS and Android, a desktop app for every OS, and a web app — all in sync.',
    },
];
