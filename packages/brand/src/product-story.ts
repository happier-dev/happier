/**
 * Canonical product narrative metadata shared by marketing and product surfaces.
 *
 * This is deliberately not a runtime feature registry or a UI presentation model:
 * availability here describes what the brand may claim, while each consumer owns
 * its layout, localization, imagery imports, and release/runtime gates.
 */
export type ProductStoryFeature = Readonly<{
    id: string;
    availability: 'shipped' | 'upcoming';
    placements: Readonly<{
        onboarding: number | null;
        website: 'primary' | 'grid' | null;
        docs: ReadonlyArray<string>;
    }>;
    semantics: Readonly<{
        iconId: string;
        artworkId: string | null;
    }>;
    english: Readonly<{
        title: string;
        wideTitle: string;
        overview: string;
        detail: string;
    }>;
}>;

type StorySeed = readonly [
    id: string,
    iconId: string,
    artworkId: string | null,
    title: string,
    wideTitle: string,
    overview: string,
    detail: string,
    website: 'primary' | 'grid' | null,
];

const seeds = [
    ['anywhere', 'devices', 'onboarding-anywhere', 'Start coding anywhere. Continue everywhere.', 'Start coding anywhere.\nContinue everywhere.', 'Begin with one session that follows you across terminal, desktop, web, and phone.', 'The session keeps its context while you move between terminal, desktop, web, tablet, and phone. You can step away from the machine without stepping away from the work.', 'primary'],
    ['existingSessions', 'sessions', 'onboarding-existing-sessions', 'Your sessions? Already there.', 'Your sessions?\nAlready there.', 'Open the sessions already running on your computers—nothing to migrate.', 'Happier discovers sessions that are already running on your computers and brings them into one familiar place. There is no project import and no new workflow to adopt.', 'primary'],
    ['terminalTuis', 'terminal', 'onboarding-terminal', 'You love the terminal? We do too.', 'Love the terminal?\nSo do we.', 'Keep your native TUI flow and open the same session in Happier whenever you need it.', 'Keep the native Claude Code, Codex, or OpenCode TUI as your home base. Happier mirrors the same live session when a larger screen—or your phone—is the better tool.', 'primary'],
    ['cockpit', 'cockpit', 'onboarding-one-tap-away', 'Your coding cockpit. One tap away.', 'Your coding cockpit.\nOne tap away.', 'Browse, edit, review, branch, and open a live shell without leaving the session.', 'Move from the conversation to a file, a diff, a branch, or a live shell without leaving the session. Each tool has its own focused surface, sized for the device in your hand.', 'primary'],
    ['sessionTeam', 'team', 'onboarding-sessions-team', 'Your sessions work as a team.', 'Sessions that work\nas a team.', 'Send focused work to other sessions and agents while keeping every result connected.', 'A session can start another, send it a focused task, and read the result. Split work across Claude, Codex, and compatible agents while each session keeps a clear transcript.', 'primary'],
    ['queue', 'queue', null, 'Queue it. Steer it. Fork it.', 'Queue it. Steer it.\nFork it.', 'Line up follow-ups, change direction, or branch from an earlier point.', 'Line up follow-ups while an agent works, reorder or edit them, and steer the current turn when direction changes. Fork or roll back when you want to explore a different path.', 'primary'],
    ['attention', 'attention', 'onboarding-what-needs-you', 'Always know what needs you.', 'Always know\nwhat needs you.', 'See waiting decisions and actively working sessions at a glance.', 'Waiting approvals and questions rise above the noise while actively working sessions stay grouped together. Run many agents without repeatedly opening each transcript to check its state.', 'primary'],
    ['review', 'review', 'onboarding-review', 'Review the diff. Send precise notes.', 'Review the diff.\nSend precise notes.', 'Comment on exact changed lines and hand structured feedback back to an agent.', 'Attach feedback to exact changed lines, choose which comments to include, and send structured review context back to the current agent—or use it to start a focused follow-up session.', 'primary'],
    ['agentSwitching', 'switching', 'onboarding-agent-switching', 'Start in Codex. Finish in Claude.', 'Start in Codex.\nFinish in Claude.', 'Continue the same work with the agent that fits the next part best.', 'Change the agent that continues a session when another model is a better fit. Happier carries forward the useful context while preserving the session as one coherent place to work.', 'primary'],
    ['navigation', 'navigation', 'onboarding-navigation', 'Move through work, not window chrome.', 'Move through work,\nnot window chrome.', 'Jump directly between sessions, files, changes, and places that need attention.', 'Jump between sessions, files, changes, terminal tabs, and the places that need attention. Navigation stays close to the work instead of forcing you through nested setup screens.', 'primary'],
    ['voice', 'voice', 'onboarding-voice', 'A colleague you can talk to.', 'A colleague\nyou can talk to.', 'Ask, brainstorm, approve, and steer the same sessions hands-free.', 'Ask what is running, brainstorm the next change, approve a request, or send a message while your hands are busy. Voice is another way into the same sessions—not a separate assistant silo.', 'primary'],
    ['machines', 'machines', null, 'On every computer you own.', 'On every computer\nyou own.', 'Choose which computer, VPS, or development box runs each session.', 'Connect laptops, desktops, VPSs, and development boxes you control. Choose where each session executes and keep the code and tools on the machine where they belong.', 'primary'],
    ['surfaces', 'surfaces', null, 'App, voice, CLI, and MCP.', 'App, voice, CLI,\nand MCP.', 'Use the interface that fits the moment while keeping one shared view of the work.', 'Start and steer work from the interface that fits the moment. These are several doors into the same Happier sessions, with one shared view of progress and attention.', 'primary'],
    ['mcp', 'globe', 'onboarding-mcp', 'One MCP config. Every agent.', 'One MCP config.\nEvery agent.', 'Define MCP servers once and reuse them across supported coding agents.', 'Define servers once and reuse them across supported coding agents, including agents whose native MCP setup differs. Happier can also expose its own session actions over MCP.', 'primary'],
    ['subscriptions', 'subscriptions', 'onboarding-subscriptions', 'Use the subscriptions you already have.', 'Use the subscriptions\nyou already have.', 'Connect existing coding-agent subscriptions and see their usage in one place.', 'Connect the Claude and OpenAI accounts you already pay for instead of buying another model bundle. See usage in the app and choose the right account for the next session.', 'primary'],
    ['accounts', 'accounts', 'onboarding-sail-past-limits', 'More accounts. Fewer hard stops.', 'More accounts.\nFewer hard stops.', 'Keep personal, work, and team accounts ready without losing track of limits.', 'Keep personal, work, and team accounts available together and understand their limits before a long task stalls. Pick deliberately rather than discovering quota trouble mid-session.', 'primary'],
    ['customization', 'customization', null, 'Make Happier feel like yours.', 'Make Happier\nfeel like yours.', 'Tune themes, profiles, prompts, and preferences around how you build.', 'Tune themes, profiles, prompts, and working preferences around how you actually build. The product adapts without hiding the underlying agent or machine from you.', 'primary'],
    ['privacy', 'privacy', null, 'Open source. Private by design.', 'Open source.\nPrivate by design.', 'Choose end-to-end encryption or self-host the relay on infrastructure you control.', 'Choose end-to-end encryption so the relay stores only encrypted session data, or self-host the relay on infrastructure you control. The source is open for inspection and contribution.', 'primary'],
    ['automations', 'automations', null, 'Your agents, on a schedule.', 'Your agents,\non a schedule.', 'Schedule recurring sessions for the work that should happen automatically.', 'Turn a recurring task into a scheduled session: monitor a pull request, check an issue queue, or run a maintenance prompt. The result appears alongside the rest of your work.', 'grid'],
    ['prompts', 'prompts', null, 'Keep the prompts that work.', 'Keep the prompts\nthat work.', 'Reuse proven prompts, skills, and profiles on every device.', 'Save reusable instructions, skills, and agent profiles instead of reconstructing them for every session. Bring proven ways of working to whichever device starts the next task.', 'grid'],
    ['pets', 'pets', null, 'Never work alone. Meet Pets.', 'Never work alone.\nMeet Pets.', 'A small optional companion for long-running sessions.', 'A small companion follows session activity across Happier and adds a little warmth to long-running work. It is optional, playful, and more charming than strictly necessary.', null],
] as const satisfies readonly StorySeed[];

export type ProductStoryFeatureId = (typeof seeds)[number][0];

export const PRODUCT_STORY_FEATURES: ReadonlyArray<ProductStoryFeature> = seeds.map((seed, onboarding) => ({
    id: seed[0],
    availability: 'shipped',
    placements: {
        onboarding,
        website: seed[7],
        docs: [],
    },
    semantics: {
        iconId: seed[1],
        artworkId: seed[2],
    },
    english: {
        title: seed[3],
        wideTitle: seed[4],
        overview: seed[5],
        detail: seed[6],
    },
}));

export const PRODUCT_STORY_FEATURES_BY_ID: Readonly<Record<string, ProductStoryFeature>> = Object.fromEntries(
    PRODUCT_STORY_FEATURES.map((feature) => [feature.id, feature]),
);

export const PRODUCT_STORY_DETAILS_ENGLISH = Object.fromEntries(
    PRODUCT_STORY_FEATURES.map((feature) => [feature.id, {
        wideTitle: feature.english.wideTitle,
        body: feature.english.detail,
    }]),
) as Readonly<Record<ProductStoryFeatureId, Readonly<{ wideTitle: string; body: string }>>>;

/** Canonical website-length English copy; website layout and artwork stay website-owned. */
export const PRODUCT_STORY_WEBSITE_COPY_ENGLISH: Readonly<Partial<Record<ProductStoryFeatureId, Readonly<{
    title: string;
    body: string;
}>>>> = {
    anywhere: {
        title: 'Start coding anywhere. Continue everywhere.',
        body: 'Launch a session on your laptop. Follow it live, send messages, and approve permissions from your phone, tablet, browser, or desktop — without losing context.',
    },
    existingSessions: {
        title: 'Your existing sessions? Already there.',
        body: 'Open any Claude Code, Codex, or OpenCode session running on your machine — live, from any device. Nothing to migrate, nothing to learn.',
    },
    terminalTuis: {
        title: 'You love the terminal? We do too.',
        body: 'Keep running Claude Code, Codex, or OpenCode in their native TUI. Happier mirrors them to every device, so you can follow along, send messages, and approve permissions from anywhere — and switch between the terminal and Happier whenever you like.',
    },
    cockpit: {
        title: 'Your coding cockpit. One tap away.',
        body: 'Browse, edit, review, branch, and open a live shell without leaving the session.',
    },
    sessionTeam: {
        title: 'Your sessions work as a team.',
        body: 'A session can start another session, send it messages, and read its transcript — so a Claude session and a Codex session can split the work between them. Each one still runs its own subagents, on whichever backend you choose: Claude, Codex, or any ACP-compatible CLI.',
    },
    queue: {
        title: 'Queue it. Steer it. Fork it.',
        body: 'Queue messages while the agent works — reorder, edit, or send them now. Steer a running turn without interrupting it, or roll back to any earlier message and take a different path.',
    },
    attention: {
        title: 'Always know what needs you.',
        body: 'Sessions waiting on a decision rise to a “Needs attention” group at the top of your list; everything actively running gathers under “Working.” Run a dozen agents at once and never lose the thread.',
    },
    review: {
        title: 'Review the diff. Send notes to your agents.',
        body: 'Browse your agent’s changes. Mark the exact lines you want to address. Choose which notes to send, and hand them straight back — same session, or a new one.',
    },
    agentSwitching: {
        title: 'Start in Codex. Finish in Claude.',
        body: 'Change the engine mid-conversation and the same session keeps going. Your recent conversation carries over, and the new agent gets tools to read the rest — plus the previous agent’s own transcript, where it keeps one. Switch back later and it resumes its own thread, receiving only what it missed.',
    },
    navigation: {
        title: 'Swipe to teleport. Or Ctrl+Tab.',
        body: 'Swipe across the bottom bar to slide between sessions — keep going in one gesture to skip several, each one named as you pass it. At a keyboard, Alt+↑/↓ walks the list and Ctrl+Tab walks your most recent sessions. Every shortcut is remappable.',
    },
    voice: {
        title: 'A colleague you can talk to.',
        body: 'The voice assistant watches every running session. Brainstorm the next change, approve a permission, or send a message — all without picking up the phone.',
    },
    machines: {
        title: 'Run sessions on every computer you own.',
        body: 'Connect your laptop, your desktop, a VPS, or a dev box, then pick which one runs each session. The picker marks which are online, and starts sessions on those. Add another over SSH, from the app or the CLI.',
    },
    surfaces: {
        title: 'Spawn and manage sessions from the app, voice, the CLI and MCP.',
        body: 'Every action Happier can take — create a session, send it a message, set the model, start a review — is defined once, in one registry. The app, slash commands, voice, in-session agents, the CLI, and an external MCP host all call the same definition, and for each action you choose which of those surfaces can run it and which have to ask you first.',
    },
    mcp: {
        title: 'Your MCP servers. Every agent, every machine.',
        body: 'Define your MCP servers once. Happier makes them available across every agent — even ones with no native MCP support — and on every machine you connect. No reinstalling per agent, per device.',
    },
    subscriptions: {
        title: 'Use the subscriptions you already pay for.',
        body: 'Happier reuses the subscriptions and logins your existing CLIs already use — Claude, Codex, Cursor, Gemini, OpenCode. No new bill. No double billing.',
    },
    accounts: {
        title: 'Pool your accounts. Keep the session going.',
        body: 'Link multiple accounts per provider into a pool and watch usage and quota resets for every one of them in the app. Nothing switches until you build a pool — once you have, Claude Code and Codex sessions can change account without stopping, moving to whichever member has the most quota left, at most once a turn and never past a reset time the provider has published.',
    },
    customization: {
        title: 'Configure (almost) everything.',
        body: 'Modes, models, and permissions per session. Tool-timeline detail levels. Notification routing. Custom themes you can build, import, and share. Tune Happier to exactly how you work.',
    },
    privacy: {
        title: 'Open-source. End-to-end encrypted.',
        body: 'Your code, prompts, and session content are encrypted on your device before they ever reach a server. Private by design. Open by default. Self-host in one command.',
    },
};
