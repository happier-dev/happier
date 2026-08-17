/**
 * English source-of-truth copy for the marketing site.
 *
 * Every string here was lifted verbatim from the component that used to own it;
 * the file:line it came from is noted so the extraction is auditable.
 *
 * `Messages` is derived from this object (see ./index.ts), so any locale file is
 * a compile error until it is COMPLETE. That is deliberate: a half-translated
 * app screen degrades gracefully, but a half-translated landing page reads as
 * abandonware. Completeness is enforced by `tsc`, not by discipline.
 *
 * Conventions:
 * - `\n` is a hard line break the layout depends on. Translators may move it,
 *   but must keep the same number of breaks.
 * - `~~~` inside hero.subhead is a RevealText no-break marker, not copy.
 *   See src/components/RevealText.tsx. Keep it in every locale.
 * - Product nouns that ship untranslated in the app (MCP, Git, CLI, Claude Code,
 *   Codex, OpenCode, subagent, prompt, skill) stay in Latin script. This matches
 *   the app's own zh-Hans file, which writes e.g. "跨 provider 的 subagents".
 */

export const en = {
    /** Document head. One entry per locale, consumed by the prerender step. */
    meta: {
        title: 'Happier — One session. Every device.',
        description:
            'Happier is the cross-device control room for your AI coding agents. Run Claude Code, Codex, OpenCode and more — on every device, in one inbox, with your own subscriptions.',
        ogTitle: 'Happier — One session. Every device.',
        ogDescription:
            'The mobile-native control layer for AI coding agents. See the UI. Act on it. No hacks.',
        ogLocale: 'en_US',
    },

    /** src/sections/Nav.tsx */
    nav: {
        github: 'GitHub',
        starOnGithub: 'Star on GitHub',
        docs: 'Docs',
        guides: 'Guides',
        webApp: 'Web app',
        localeSwitcherLabel: 'Change language',
    },

    /**
     * Hero. Rendered by src/components/HeroHeadline.tsx and src/sections/Hero.tsx,
     * both of which now READ FROM HERE — this object is the only copy of the
     * headline and subhead in the codebase. It used to exist twice (a hardcoded
     * WordSpec array in HeroHeadline.tsx and these keys) and the two had drifted
     * into asserting different agent counts.
     *
     * THE COUNT IS LOAD-BEARING. Four agents are named; `headlineLineTwoAside`
     * carries the rest. named + aside must equal PROVIDERS.length (13), and
     * src/data/copyClaims.test.ts fails the build if it doesn't. Add a provider
     * to src/data/providers.tsx and this string has to be re-counted.
     *
     * Line one and line two are parsed on their commas (`,` or the CJK `、`), and
     * each comma-delimited item becomes a `white-space: nowrap` group — that is
     * what keeps "Claude Code" from breaking across two lines.
     */

    /** src/components/InstallCommand.tsx */
    install: {
        copy: 'Copy',
        copied: 'Copied!',
        copyCommand: 'Copy install command',
    },

    /** src/components/DownloadBadges.tsx:231-244 */
    badges: {
        appStoreEyebrow: 'Download on',
        appStoreLabel: 'App Store',
        playEyebrow: 'Get it on',
        playLabel: 'Google Play',
        webAppEyebrow: 'Open the',
        webAppLabel: 'Web app',
    },

    /** src/sections/AlternatingFeatures.tsx:102 */
    features: {
        heading: 'One control room\nfor every coding agent.',
    },

    /** src/sections/TabbedExplorer.tsx:7-45 */
    explorer: {
        heading: 'Every tool.\nOne interface.',
        tabChat: 'Chat',
        tabEditor: 'Editor',
        tabGit: 'Git',
        tabTerminal: 'Terminal',
    },

    /** src/sections/FeatureGrid.tsx:17 */
    grid: {
        heading: 'Everything else\nyou didn’t know you needed.',
    },

    /** src/sections/SelfHost.tsx:6-50,70,241-243 */
    selfHost: {
        heading: 'Own the stack.\nStay independent.',
        installTitle: 'One-command install',
        installBody: 'Install the relay server with a single command. Docker or bare metal.',
        operationTitle: 'Daily operation',
        // Was "Auto-updates, health checks, and monitoring built in. Set it and
        // forget it." — false against our own shipped docs (docker.mdx:41,72;
        // advanced/updates.mdx:156; hstack/remote-server.mdx:86). Keep in step
        // with HIGHLIGHTS in src/sections/SelfHost.tsx.
        operationBody:
            'A managed service you start, stop and check with happier relay host status. Nothing on the host updates itself — you update by rerunning the install command, when you decide to.',
        remoteTitle: 'Remote access',
        remoteBody: 'Access your sessions from anywhere. SSH tunnels, Tailscale, or direct HTTPS.',
        nodeDevice: 'Your device',
        nodeRelay: 'Your relay',
        nodeRelayDetail: 'Docker or bare metal',
        nodeMachine: 'Your machine',
        nodeMachineDetail: 'Claude Code, Codex, OpenCode',
        copyCommands: 'Copy commands',
        copy: 'Copy',
        copied: 'Copied!',
    },

    /** src/sections/GetStarted.tsx:20-39,59 */
    getStarted: {
        heading: 'Up and running\nin under a minute.',
        stepDownloadTitle: 'Download the app',
        stepDownloadBody: 'Grab Happier from the App Store, Google Play, or as a desktop app.',
        stepInstallTitle: 'Install the CLI',
        stepInstallBody: 'One command. Works on macOS, Linux, and Windows.',
        stepPairTitle: 'Pair your device',
        stepPairBody: 'Scan the QR code in your terminal to connect your phone or browser.',
        stepCodeTitle: 'Start coding',
        stepCodeBody:
            'Run happier instead of claude or codex. Your sessions sync everywhere instantly.',
        runHappierLabel: 'Run happier instead of claude',
    },

    /** src/sections/CallToAction.tsx:37 */
    cta: {
        heading: 'Open source. Yours forever.',
    },

    /** src/sections/Footer.tsx:6-26 */
    footer: {
        columnProduct: 'Product',
        columnOpenSource: 'Open source',
        columnResources: 'Resources',
        linkFeatures: 'Features',
        linkGetStarted: 'Get started',
        linkWebApp: 'Web app',
        linkDocs: 'Docs',
        linkGuides: 'Guides',
        linkGithub: 'GitHub',
        linkSelfHost: 'Self-host',
        linkLicense: 'License',
        linkChangelog: 'Changelog',
        linkDiscord: 'Discord',
    },

    /** Locale suggestion banner. Shown, never auto-applied. */
    localeBanner: {
        /** `{language}` is substituted with the target locale's `nativeName`. */
        body: 'This page is available in {language}.',
        action: 'Switch',
        dismiss: 'Dismiss',
    },
};

/**
 * The shape every locale must satisfy. Derived rather than hand-written so it
 * can never fall behind `en`.
 *
 * Note there is no `as const` above — values widen to `string`, which is what
 * lets a locale supply different text while keeping the key set exact.
 */
export type Messages = typeof en;
