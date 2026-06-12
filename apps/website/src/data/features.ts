export type Feature = {
    id: string;
    eyebrow: string;
    title: string;
    body: string;
    visual: 'mobile' | 'desktop' | 'mobileAndDesktop';
    /** Each accent samples 1-2 adjacent bands of the hero planet so the
     *  feature glows feel like slices of the same image as the visitor scrolls. */
    accent: 'sun' | 'coral' | 'rose' | 'magenta' | 'blue' | 'indigo';
};

// Adapted from `releaseNotes.onboardingShowcase.cards` in
// apps/ui/sources/text/translations/en.ts — phrased for a landing page
// rather than an in-app card carousel.
export const FEATURES: ReadonlyArray<Feature> = [
    {
        id: 'anywhere',
        eyebrow: 'Every device',
        title: 'Start coding anywhere. Continue everywhere.',
        body: 'Launch a session on your laptop. Follow it live, send messages, and approve permissions from your phone, tablet, browser, or desktop — without losing context.',
        visual: 'mobileAndDesktop',
        accent: 'sun',
    },
    {
        id: 'subscriptions',
        eyebrow: 'Bring your own keys',
        title: 'Use your own subscriptions.',
        body: 'Happier uses your existing Claude Code, Codex, OpenCode, Cursor subscriptions. No new bill. No double billing. Install Happier and start coding with your existing CLIs and subscriptions.',
        visual: 'mobile',
        accent: 'blue',
    },
    {
        id: 'terminalTuis',
        eyebrow: 'Stay in the terminal',
        title: 'You love the terminal? We do too.',
        body: 'If you prefer, you can keep running Claude Code, Codex, or OpenCode in their native TUI. Happier mirrors them to every device. You can then follow along, send messages, and approve permissions from your phone, tablet, browser, or desktop, and easily switch between the terminal and Happier.',
        visual: 'desktop',
        accent: 'coral',
    },
    {
        id: 'cockpit',
        eyebrow: 'Mobile cockpit',
        title: 'Everything you need. One tap away.',
        body: 'Chat, files, Git, editor, terminal. Browse and edit code, review diffs, manage branches, open PRs, create worktrees, and more — straight from your pocket.',
        visual: 'mobile',
        accent: 'indigo',
    },
    {
        id: 'existingSessions',
        eyebrow: 'Adoption-free',
        title: 'Existing Claude, Codex, or OpenCode sessions? Already there.',
        body: 'Open live any Claude, Codex, or OpenCode session running on your machine. Nothing to migrate, nothing to learn.',
        visual: 'mobileAndDesktop',
        accent: 'sun',
    },
    {
        id: 'voice',
        eyebrow: 'Hands-free',
        title: 'A colleague you can talk to.',
        body: 'The voice assistant watches every running session. Brainstorm the next change, approve permissions, send a message — all without picking up the phone.',
        visual: 'mobile',
        accent: 'magenta',
    },
    {
        id: 'review',
        eyebrow: 'Code review',
        title: 'Review the diff. Send notes.',
        body: 'Browse your agent’s changes. Mark the exact lines you want to address. Choose which notes to send, and hand them straight back — same session, or a new one.',
        visual: 'desktop',
        accent: 'rose',
    },
    {
        id: 'subagents',
        eyebrow: 'Many agents',
        title: 'One session. Many agents.',
        body: 'Launch Codex subagents from a Claude session. Route messages between sessions. Use the strength of each provider — together, in one place.',
        visual: 'desktop',
        accent: 'indigo',
    },
    {
        id: 'inbox',
        eyebrow: 'Never lose the thread',
        title: 'One inbox. Every session.',
        body: 'Pending approvals, permission prompts, unread activity — across every session and every machine, in one inbox. Nothing falls through the cracks.',
        visual: 'mobile',
        accent: 'coral',
    },
    {
        id: 'mcp',
        eyebrow: 'MCP, everywhere',
        title: 'One config. Every provider.',
        body: 'Define MCP servers once. They work across every backend — even ones that don’t natively support MCP. Skills, prompts, profiles, all in sync.',
        visual: 'desktop',
        accent: 'blue',
    },
    {
        id: 'queue',
        eyebrow: 'Stay in control',
        title: 'Queue. Steer. Fork. Rollback.',
        body: 'Queue messages while the agent is busy. Steer a running turn. Fork from any message. Roll back if things go sideways.',
        visual: 'mobile',
        accent: 'rose',
    },
    {
        id: 'automations',
        eyebrow: 'Agents on a schedule',
        title: 'Your agent, on a schedule.',
        body: 'Schedule recurring sessions to monitor pull requests, watch issues, or run any task on a regular cadence. Wake up to results.',
        visual: 'mobileAndDesktop',
        accent: 'magenta',
    },
    {
        id: 'accounts',
        eyebrow: 'Multi-account',
        title: 'All your accounts. One view.',
        body: 'Link multiple Claude or OpenAI accounts — personal, work, team. Monitor usage and quotas for each directly in the app.',
        visual: 'mobile',
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
