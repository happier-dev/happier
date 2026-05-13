export type Feature = {
    id: string;
    eyebrow: string;
    title: string;
    body: string;
    visual: 'mobile' | 'desktop' | 'mobileAndDesktop';
    accent: 'sun' | 'coral' | 'blue' | 'indigo';
};

// Adapted from `releaseNotes.onboardingShowcase.cards` in
// apps/ui/sources/text/translations/en.ts — phrased for a landing page
// rather than an in-app card carousel.
export const FEATURES: ReadonlyArray<Feature> = [
    {
        id: 'anywhere',
        eyebrow: 'Every device',
        title: 'Start anywhere. Continue everywhere.',
        body: 'Launch a session on your laptop. Follow it live, send messages, and approve permissions from your phone, tablet, browser, or desktop — without losing context.',
        visual: 'mobileAndDesktop',
        accent: 'sun',
    },
    {
        id: 'subscriptions',
        eyebrow: 'Bring your own keys',
        title: 'Use what you already pay for.',
        body: 'Claude Code, Codex, OpenCode — your subscriptions, your usage. No new bill. No double billing. No login required if you don’t want one.',
        visual: 'mobile',
        accent: 'coral',
    },
    {
        id: 'terminalTuis',
        eyebrow: 'Stay in the terminal',
        title: 'You love the terminal? We do too.',
        body: 'Keep running Claude Code, Codex, or OpenCode in their native TUI. Happier mirrors them to every device — follow along, send messages, and approve permissions from your phone.',
        visual: 'desktop',
        accent: 'indigo',
    },
    {
        id: 'cockpit',
        eyebrow: 'Mobile cockpit',
        title: 'Everything you need. One tap away.',
        body: 'Chat, files, Git, editor, terminal. Browse and edit code, review diffs, manage branches, open PRs — straight from your pocket.',
        visual: 'mobile',
        accent: 'sun',
    },
    {
        id: 'existingSessions',
        eyebrow: 'Adoption-free',
        title: 'Existing sessions? Already there.',
        body: 'Any Claude, Codex, or OpenCode session running on your machine — open it in Happier, live. Nothing to migrate, nothing to learn.',
        visual: 'mobileAndDesktop',
        accent: 'blue',
    },
    {
        id: 'voice',
        eyebrow: 'Hands-free',
        title: 'A colleague you can talk to.',
        body: 'The voice assistant watches every running session. Brainstorm the next change, approve permissions, send a message — all without picking up the phone.',
        visual: 'mobile',
        accent: 'coral',
    },
    {
        id: 'review',
        eyebrow: 'Code review',
        title: 'Review the diff. Send notes.',
        body: 'Browse your agent’s changes. Mark the exact lines you want to address. Choose which notes to send, and hand them straight back — same session, or a new one.',
        visual: 'desktop',
        accent: 'indigo',
    },
    {
        id: 'subagents',
        eyebrow: 'Many agents',
        title: 'One session. Many agents.',
        body: 'Launch Codex subagents from a Claude session. Route messages between sessions. Use the strength of each provider — together, in one place.',
        visual: 'desktop',
        accent: 'blue',
    },
    {
        id: 'inbox',
        eyebrow: 'Never lose the thread',
        title: 'One inbox. Every session.',
        body: 'Pending approvals, permission prompts, unread activity — across every session and every machine, in one inbox. Nothing falls through the cracks.',
        visual: 'mobile',
        accent: 'sun',
    },
    {
        id: 'mcp',
        eyebrow: 'MCP, everywhere',
        title: 'One config. Every provider.',
        body: 'Define MCP servers once. They work across every backend — even ones that don’t natively support MCP. Skills, prompts, profiles, all in sync.',
        visual: 'desktop',
        accent: 'indigo',
    },
    {
        id: 'queue',
        eyebrow: 'Stay in control',
        title: 'Queue. Steer. Fork. Rollback.',
        body: 'Queue messages while the agent is busy. Steer a running turn. Fork from any message. Roll back if things go sideways.',
        visual: 'mobile',
        accent: 'coral',
    },
    {
        id: 'automations',
        eyebrow: 'Agents on a schedule',
        title: 'Your agent, on a schedule.',
        body: 'Schedule recurring sessions to monitor pull requests, watch issues, or run any task on a regular cadence. Wake up to results.',
        visual: 'mobileAndDesktop',
        accent: 'blue',
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
