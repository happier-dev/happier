/**
 * Real copy strings from apps/ui/sources/text/translations/en.ts and
 * visible UI elements in apps/ui. Using the same words the app uses so
 * the marketing site and the product speak with one voice.
 *
 * Rule: never invent a label here. If new copy is needed, add it to
 * the app first (or pull it from the app's real UI) and then mirror.
 */

export const copy = {
    // Nav
    nav: {
        product: 'Product',
        providers: 'Providers',
        pricing: 'Pricing',
        docs: 'Docs',
        github: 'GitHub',
    },

    // Hero
    hero: {
        badge: 'Open source · End-to-end encrypted · Self-hostable',
        // Line 1 lists providers so the reader knows what this is about without guessing.
        // Line 2 is the benefit, faded into the gradient for visual hierarchy.
        headline: 'Claude Code, Codex, OpenCode —\neverywhere you go.',
        sub: 'Run any AI coding agent on your computer. Keep steering it from your phone, browser, or desktop.',
        primaryCta: 'Get started',
        secondaryCta: 'View on GitHub',
    },

    // Providers (from agent registries in apps/ui)
    providers: {
        title: 'Works with every major AI coding agent',
        list: [
            { name: 'Claude Code', command: 'happier claude' },
            { name: 'Codex', command: 'happier codex' },
            { name: 'OpenCode', command: 'happier opencode' },
            { name: 'Gemini', command: 'happier gemini' },
            { name: 'Copilot', command: 'happier copilot' },
            { name: 'PI', command: 'happier pi' },
            { name: 'Kilo', command: 'happier kilo' },
            { name: 'Kimi', command: 'happier kimi' },
            { name: 'Qwen', command: 'happier qwen' },
            { name: 'Augment', command: 'happier augment' },
        ],
    },

    remoteLaunch: {
        kicker: 'Remote launch',
        headline: 'Start OpenCode on your Mac.\nAttach from terminal later.',
        body: 'Kick off a coding-agent session from phone or desktop on a selected computer. The daemon starts it in the background, then `happier attach` connects your terminal when you are back at the keyboard.',
    },

    // Direct sessions pillar — using real app copy
    directSessions: {
        kicker: 'Direct sessions',
        headline: 'Already running Claude, Codex, or OpenCode?\nTake it over from anywhere.',
        body: 'Happier detects sessions you started outside the app and lets you steer them from your phone or browser — with full history, permissions, and streaming intact.',
        browseButton: 'Browse provider sessions', // Real button copy in the app
        externalBadge: 'Started without Happier',
    },

    // Voice pillar — from the realtime folder and voice features
    voice: {
        kicker: 'Voice',
        headline: 'Hands free,\nwith full context.',
        body: 'The voice agent reads every running session, summarizes what is waiting on you, and routes your decisions to the right place. Every action is approval-gated.',
        sample: [
            { role: 'user', text: 'What is running right now?' },
            {
                role: 'agent',
                text: 'Your refactor session finished the component split. Your test session has one failing test on useSession.',
            },
            { role: 'user', text: 'Have the refactor session take a look.' },
            {
                role: 'agent',
                text: 'It needs permission to edit useSession.test.ts. Approve?',
            },
            { role: 'user', text: 'Yep.' },
            {
                role: 'agent',
                text: "Approved. I'll ping you when it's green.",
            },
        ],
    },

    // Parallel pillar
    parallel: {
        kicker: 'Parallel work',
        headline: 'Many agents.\nOne inbox.',
        body: 'Run Claude, Codex, and OpenCode side by side across projects and worktrees. Every permission request lands in one place.',
    },

    // Self-host + security
    selfHost: {
        kicker: 'Yours, always',
        headline: 'Self-hostable.\nEnd-to-end encrypted.',
        body: 'Your code is encrypted on your devices before it hits the wire. Run the relay yourself or use ours — the server never sees your data either way. Built in Switzerland.',
        bullets: [
            { title: 'End-to-end encrypted', body: 'Clients encrypt, relays route.' },
            {
                title: 'Self-hostable',
                body: 'Docker up your own relay — GitHub OAuth, OIDC, mTLS supported.',
            },
            {
                title: 'Zero-knowledge',
                body: 'The server cannot read your messages, your code, or your secrets.',
            },
        ],
    },

    // Permission card — exact phrasing patterns used in the app
    permissionPrompt: {
        title: 'Claude wants to edit', // Pattern: "{agent} wants to {action}"
        allow: 'Allow',
        deny: 'Deny',
    },

    // Get started
    getStarted: {
        kicker: 'Get started',
        headline: 'Install in one command.',
        install: 'curl -fsSL https://happier.dev/install | bash',
    },

    // Footer
    footer: {
        tagline: 'Built by developers, for developers. Open source.',
        madeIn: 'Made with care in Switzerland.',
    },
} as const;
