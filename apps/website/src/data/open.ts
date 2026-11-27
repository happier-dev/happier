import { GITHUB_SPONSORS_URL } from './downloads';
import { plansRelease } from './plansRelease';

/**
 * /open copy. Wording follows plan 06 "Copy for the pages" and the verified
 * sp3Web:open lab frame. Facts (numbers, what ships in this tree) are read from
 * ./plans and ./plansRelease, never restated here, so the two trees share this
 * file byte for byte and differ only in plansRelease.ts.
 *
 * No em dashes in new copy, one eyebrow per page, and no sample numbers: every
 * figure on the page comes from finances.json or its dated snapshot.
 */
export const OPEN_INTRO = {
    eyebrow: 'Open source philosophy',
    title: 'Software should be free and accessible to everyone.',
    description:
        'Happier is MIT-licensed, and every feature works on your own server and on ours, at no cost. Here is how it stays that way, how it’s funded and where the money goes. I publish the numbers early each month.',
    goal: 'The goal is for Happier to pay for itself first, then properly fund its development.',
    contact: 'hello@happier.dev',
} as const;

export const OPEN_PILLS = {
    supporter: 'Become a supporter',
    star: 'Star on GitHub',
    selfHost: 'Self-host Happier',
} as const;

export const OPEN_PROMISES_HEADING = 'Five promises that keep Happier free';

/*
 * Owner direction (2026-11-27): no talk of limit changes on this page (the
 * notice period lives in the Terms of Sale), and no promise about how Happier
 * is or isn't funded beyond what is true today. Never "no VC" or "no investors".
 */
export const OPEN_PROMISES = [
    {
        id: 'features',
        title: 'Every feature is free, everywhere.',
        body: plansRelease.teamsLive
            ? 'Every agent, every client, voice with your own key, automations, plugins, teams. Paying never changes what Happier can do.'
            : 'Every agent, every client, voice with your own key, automations. Paying never changes what Happier can do.',
    },
    {
        id: 'no-enterprise-tier',
        title: 'No “Enterprise” edition holding features back.',
        body: plansRelease.teamsLive
            ? 'Teams, automations, end-to-end encryption and self-hosting are all in the same MIT-licensed product. There is no open-core tier where the parts companies need wait behind a sales call.'
            : 'Automations, end-to-end encryption and self-hosting are all in the same MIT-licensed product, and teams join them with Happier 0.3. There is no open-core tier where the parts companies need wait behind a sales call.',
    },
    {
        id: 'self-host',
        title: 'Self-hosting is the whole product.',
        body: 'The same code, with limits you choose and no licence key. If you run it, it’s yours.',
    },
    {
        id: 'cloud',
        title: 'Happier Cloud stays free.',
        body: 'End-to-end encrypted sync between your machines and your phone, at no cost.',
    },
    {
        id: 'your-data',
        title: 'Your data stays yours, with no lock-in.',
        body: 'Your code stays on your machines, your agents run on your own accounts, and the encryption keys live on your devices. Export any session as Markdown or JSON, run your own server, or move off Happier Cloud whenever you like. Export is free on every plan.',
    },
] as const;

/** How Happier funds its development: two pillars, neither of which changes the product. */
export const OPEN_FUNDING = {
    heading: 'How Happier pays for itself',
    lead: 'Two ways, and neither changes what the open-source product can do.',
    pillars: [
        {
            id: 'cloud',
            title: 'Happier Cloud',
            body: plansRelease.teamsLive
                ? 'Convenience, if you want it. We run the server, and Lite and Plus keep more of your history on it. Teams bigger than three pay for their extra seats.'
                : 'Convenience, if you want it. We run the server, and Lite and Plus keep more of your history on it. With Happier 0.3, teams bigger than three will pay for their extra seats.',
            links: [{ label: 'See the plans', href: '/plans' }],
        },
        {
            id: 'supporters',
            title: 'The Supporter Pack and GitHub Sponsors',
            body: 'For anyone who wants Happier to keep going, on any server, self-hosters included. You get a supporter number and a thank-you in the app; the product stays exactly the same.',
            links: [
                { label: 'Supporter Pack', href: '/plans#any-server' },
                { label: 'GitHub Sponsors', href: GITHUB_SPONSORS_URL },
            ],
        },
    ],
} as const;

/** The money section. `{asOf}`-style values are filled from finances.json by the sheet. */
export const OPEN_MONEY = {
    heading: 'Where the money goes',
    lead: 'Costs are what it takes to build and run Happier; income is what people chose to pay.',
    empty: 'The first monthly numbers go up early in December.',
    costsTitle: 'Operating and development costs',
    costsScopeMonthly: 'monthly',
    costsScopeFuture: 'the months ahead fill in as they happen',
    legendAi: 'AI tools Happier is built with',
    legendServers: 'Servers',
    legendOther: 'Everything else',
    legendIncome: 'What people paid, to scale',
    coveredTitle: 'Covered this month',
    coveredScope: 'income pays the servers first',
    coveredNoteAll: 'Servers are covered at {servers} Plus members; everything at about {everything}.',
    coveredNoteServers: 'Servers are covered at {servers} Plus members.',
    costsChartLabel: '{title}, {months} months, in {currency}',
    costsMonth: 'Month',
    costsTotal: 'Total costs',
    income: 'Income',
    asOf: 'Up to {date}, in {currency}.',
    convertedAt: 'Converted to {currency} at <1>{source}</1>.',
    goalServers: 'Servers',
    goalAi: 'AI tools',
    goalEverything: 'Everything',
    paidTitle: 'Paid this month',
    paidUnit: 'earned',
    payingPeople: 'Paying people',
    peopleSupporter: 'Supporter Pack',
    peopleLite: 'Lite',
    peoplePlus: 'Plus',
    peopleTeamSeats: 'team seats',
    wallTitle: 'Supporters',
    wallScope: 'names shown with permission',
    wallEmpty: 'No names yet. You could be number one.',
    wallMore: 'See every supporter',
} as const;

export const OPEN_WONT_DO = {
    heading: 'What we won’t do',
    items: [
        'Put a feature behind a plan',
        'Ship a separate “enterprise edition”',
        'Show ads or sell your data',
        'Take a cut of your Claude or ChatGPT plan',
        'Charge for export',
        'Lock you into Happier Cloud',
    ],
} as const;

/** Owner wording (2026-11-27). `<1>` is the Discord link, `<2>` the mail link. */
export const OPEN_FOUNDER = {
    initials: 'LB',
    /** Owner wording (2026-11-27): the closing thank-you, above the sign-off. */
    thanks: 'Thank you to everyone who supports this vision — through the Supporter Pack, GitHub Sponsors, Happier Cloud, or simply by using, sharing, and contributing to Happier. You make this possible.',
    note: 'I build Happier because I want developer tools that stay open, private, and genuinely yours. If you have questions, ideas, or just want to say hello, <1>join us on Discord</1> or write to <2>hello@happier.dev</2>.',
    signature: '— Leeroy Brun',
} as const;
