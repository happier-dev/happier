import type { Messages } from './en';

/**
 * Simplified Chinese copy for the marketing site.
 *
 * PROVENANCE — this is not a fresh translation. Terminology is pinned to the
 * strings the app already ships to Chinese users, so the site and the product
 * use the same words for the same things. Source of truth:
 *   remote-dev/apps/ui/sources/text/translations/zh-Hans.ts  (10,129 lines)
 *
 * Terms taken verbatim from that file (with the app key they come from):
 *   会话        session          (`sessionHandoff.*`)
 *   机器        machine          (`mcpServersPreviewMachineTitle`)
 *   配对        pair             (`pairingRequestTitle`)
 *   扫描…二维码  scan the QR code (`scanComputerQrInstructions`)
 *   终端        terminal         (`runCommandInTerminal`)
 *   权限 / 批准  permission/approve (`permissions`, `approve`)
 *   自托管      self-host        (`selfHosted`)
 *   更新日志    changelog        (`changelog`)
 *   功能        features         (`featuresTitle`)
 *   开源。端到端加密。可自托管。  ← `releaseNotes.onboardingShowcase.cards.welcome.privacyTitle`
 *                                  is an EXACT existing translation of the hero subhead's
 *                                  second line. Reused verbatim rather than re-translated.
 *
 * Latin-script product nouns (MCP, Git, CLI, Docker, Tailscale, relay, Claude
 * Code, Codex, OpenCode) are left untranslated — this mirrors the app's own
 * zh-Hans register, e.g. "跨 provider 的 subagents", "一个配置。所有 provider。"
 *
 * STATUS: machine-authored, glossary-anchored, NOT yet reviewed by a native
 * speaker. See the review gate in the lane notes before this ships to /zh.
 */
export const zhHans: Messages = {
    meta: {
        title: 'Happier — 一个客户端，管理所有 AI 编程代理',
        // Qwen and Kimi are named on purpose and named EARLY. They are in the
        // shipped provider list (src/data/providers.tsx:121-122), they are what
        // this audience actually runs, and they are the one thing Anthropic's
        // Remote Control structurally cannot ever support. The English
        // description leads with Claude/Codex; the Chinese one must not.
        description:
            '在自己的电脑上运行 Claude Code、Codex、OpenCode、Qwen、Kimi 等 12 种 AI 编程代理，然后从手机、浏览器或桌面端继续。一个客户端管理全部，不绑定任何厂商。开源、端到端加密、可自托管，用你自己的订阅账号。',
        ogTitle: 'Happier — 一个客户端，管理所有 AI 编程代理',
        ogDescription:
            'Claude Code、Codex、OpenCode、Qwen、Kimi —— 一个跨设备客户端全部管理。开源，端到端加密，可自托管。',
        ogLocale: 'zh_CN',
    },

    nav: {
        github: 'GitHub',
        starOnGithub: '在 GitHub 上加星',
        docs: '文档',
        guides: '指南',
        webApp: '网页版',
        localeSwitcherLabel: '切换语言',
    },

    hero: {
        // Provider names stay Latin; the enumeration comma 、 replaces ", ".
        headlineLineOne: 'Claude Code、Codex',
        headlineLineTwo: 'OpenCode、Pi',
        // English reads "& 9 more". Chinese enumerations idiomatically state the
        // TOTAL after 等, not the remainder — "X、Y 等 13 种" is the natural form
        // and asserts the same fact (4 named + 9 = 13 shipped providers).
        headlineLineTwoAside: '等 13 种',
        // EN: "Everywhere you work." — the emphasis moved from travel ("走到哪")
        // to work, so the Chinese parallel moves with it.
        headlineLineThree: '在哪工作，就在哪用。',
        // Line 1 mirrors the new English: your own computer (电脑, not 机器 —
        // 机器 is reserved for the in-app machine selector), your own
        // subscriptions or API keys. Line 2 is the app's own privacyTitle,
        // verbatim, with the RevealText no-break marker kept in place.
        subhead: '在你自己的电脑上运行，用你自己的订阅或 API key。\n开源。端到端 ~~~ 加密。可自托管。',
    },

    install: {
        copy: '复制',
        copied: '已复制！',
        copyCommand: '复制安装命令',
    },

    badges: {
        // Reads "下载 App Store" / "获取 Google Play" in the eyebrow+label
        // stack. Kept short so the badge box does not grow: Chinese glyphs are
        // ~2x the advance width of Latin at the same point size.
        appStoreEyebrow: '下载',
        appStoreLabel: 'App Store',
        playEyebrow: '获取',
        playLabel: 'Google Play',
        webAppEyebrow: '打开',
        webAppLabel: '网页版',
    },

    features: {
        heading: '一个控制台，\n管理所有编程代理。',
    },

    explorer: {
        heading: '所有工具，\n一个界面。',
        tabChat: '聊天',
        tabEditor: '编辑器',
        tabGit: 'Git',
        tabTerminal: '终端',
    },

    grid: {
        heading: '还有那些\n你没想到却很需要的功能。',
    },

    selfHost: {
        heading: '掌控整套技术栈。\n保持独立。',
        installTitle: '一条命令完成安装',
        installBody: '用一条命令安装 relay 服务器。支持 Docker 或裸机部署。',
        operationTitle: '日常运维',
        // 原文是"内置自动更新…"，与我们自己的文档相矛盾（docker.mdx:41,72；
        // advanced/updates.mdx:156；hstack/remote-server.mdx:86）。请与
        // src/sections/SelfHost.tsx 的 HIGHLIGHTS 保持一致。
        operationBody:
            '作为托管服务运行，用 happier relay host status 启动、停止和查看状态。主机上没有任何东西会自动更新——需要更新时，由你重新运行安装命令。',
        remoteTitle: '远程访问',
        remoteBody: '随时随地访问你的会话。SSH 隧道、Tailscale，或直接使用 HTTPS。',
        nodeDevice: '你的设备',
        nodeRelay: '你的 relay',
        nodeRelayDetail: 'Docker 或裸机',
        nodeMachine: '你的机器',
        nodeMachineDetail: 'Claude Code、Codex、OpenCode',
        copyCommands: '复制命令',
        copy: '复制',
        copied: '已复制！',
    },

    getStarted: {
        heading: '一分钟之内\n就能跑起来。',
        // Step order is deliberately NOT the English order for zh: see the lane
        // notes on the funnel. The CLI step leads, because the failure mode for
        // this audience is installing the app with no machine to pair.
        stepDownloadTitle: '下载应用',
        stepDownloadBody: '从 App Store 或 Google Play 获取 Happier，也可以使用桌面端。',
        stepInstallTitle: '安装 CLI',
        stepInstallBody: '一条命令搞定。支持 macOS、Linux 和 Windows。',
        stepPairTitle: '配对设备',
        stepPairBody: '扫描终端中显示的二维码，连接你的手机或浏览器。',
        stepCodeTitle: '开始编程',
        stepCodeBody: '用 happier 代替 claude 或 codex 运行。你的会话会立刻同步到所有设备。',
        runHappierLabel: '用 happier 代替 claude 运行',
    },

    cta: {
        heading: '开源。永远属于你。',
    },

    footer: {
        columnProduct: '产品',
        columnOpenSource: '开源',
        columnResources: '资源',
        linkFeatures: '功能',
        linkGetStarted: '快速开始',
        linkWebApp: '网页版',
        linkDocs: '文档',
        linkGuides: '指南',
        linkGithub: 'GitHub',
        linkSelfHost: '自托管',
        linkLicense: '许可证',
        linkChangelog: '更新日志',
        linkDiscord: 'Discord',
    },

    localeBanner: {
        body: '本页面有{language}版本。',
        action: '切换',
        dismiss: '忽略',
    },
};
