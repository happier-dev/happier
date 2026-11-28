import { plansRelease } from './plansRelease';
import { DOCS_URL } from './downloads';

export const PLANS_TITLE = 'Plans & Supporter';

const usd = (amount: number) => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

export const CLOUD_PLANS = [
    { id: 'free', name: 'Free', monthlyUsd: 0, sessionDays: 60, subagentDays: 7, pins: 50, fileStorage: '500 MB', includesSupporter: false },
    { id: 'lite', name: 'Lite', monthlyUsd: 2.99, sessionDays: 90, subagentDays: 14, pins: 100, fileStorage: '1 GB', includesSupporter: true },
    { id: 'plus', name: 'Plus', monthlyUsd: 6.99, sessionDays: 365, subagentDays: 30, pins: 500, fileStorage: '5 GB', includesSupporter: true },
] as const;

export const SUPPORTER_PACK = {
    name: 'Supporter Pack',
    minimumWebUsd: 3,
    perks: [
        'A permanent supporter number',
        'Your Supporter pass and badge in the app',
        'An optional listing on the supporters wall, in Credits and in the README',
    ],
    cloudNote: `On Happier Cloud, Lite includes this pack and keeps more history, for ${usd(CLOUD_PLANS[1].monthlyUsd)}.`,
} as const;

export const TEAMS_PLAN = { freeMembers: 3, monthlyUsdPerAdditionalMember: 10 } as const;
export const HISTORY_GRACE_DAYS = 90;
export const LIMIT_CHANGE_NOTICE_DAYS = 30;
export const SESSION_NOTICE_DAYS = 7;
export const LIMIT_CHANGE_NOTICE = `Nothing changes until everyone on Happier Cloud has had ${LIMIT_CHANGE_NOTICE_DAYS} days’ notice in the app.`;

/*
 * Page copy for /plans, /supporters and /thanks, worded from plan 06 "Copy for
 * the pages" and the verified sp3Web:plans lab frame. Every number below is
 * derived from the facts above, so a price or limit changes in one place.
 * Lines that name 0.3-only capabilities switch on plansRelease, the one file
 * that differs between the 0.2 and 0.3 trees.
 */

export type PlanId = (typeof CLOUD_PLANS)[number]['id'] | 'self-hosted' | 'supporter';

export type PlanCardCopy = {
    id: PlanId;
    name: string;
    price: string;
    per: string;
    lines: readonly string[];
    includesPack: boolean;
    note: string | null;
    cta: string;
    /** Site-relative or absolute; null while purchases are not live. */
    href: string | null;
    featured: boolean;
};

const kept = (days: number) => (days >= 365 ? 'a year' : `${days} days`);

/** Shown on a paid card while plansRelease.purchasesLive is false. */
export const PURCHASES_PENDING = 'Purchases coming soon';

const cloudCard = (plan: (typeof CLOUD_PLANS)[number]): PlanCardCopy => {
    const free = plan.monthlyUsd === 0;
    return {
        id: plan.id,
        name: plan.name,
        price: usd(plan.monthlyUsd),
        per: free ? 'every feature' : 'a month',
        lines: [
            `Sessions kept ${kept(plan.sessionDays)} after last activity`,
            free ? `Pin up to ${plan.pins} to keep them` : `${plan.pins} pins`,
            free
                ? `Subagent transcripts for ${plan.subagentDays} days, pinned or not`
                : `Subagent transcripts for ${plan.subagentDays} days`,
            ...(plansRelease.fileStorageLive
                ? [free ? `${plan.fileStorage} for files · teams up to ${TEAMS_PLAN.freeMembers}` : `${plan.fileStorage} for files`]
                : []),
        ],
        includesPack: plan.includesSupporter,
        note: null,
        cta: free ? 'Install Happier' : `Get ${plan.name}`,
        href: free ? '/download' : null,
        featured: free,
    };
};

export const PLAN_GROUPS = [
    {
        id: 'cloud',
        title: 'Happier Cloud',
        subtitle: 'We run the server. Every plan has every feature.',
        cards: CLOUD_PLANS.map(cloudCard),
    },
    {
        id: 'any-server',
        title: 'Any server',
        subtitle: `Run your own, or get the ${SUPPORTER_PACK.name} wherever you use Happier.`,
        cards: [
            {
                id: 'self-hosted',
                name: 'Self-hosted',
                price: 'Free',
                per: 'your own server',
                lines: ['Set your own limits for history, files and people', 'One command to install', 'MIT licence'],
                includesPack: false,
                note: null,
                cta: 'Self-host guide',
                href: `${DOCS_URL}self-hosting/quickstart`,
                featured: false,
            },
            {
                id: 'supporter',
                name: SUPPORTER_PACK.name,
                price: `From ${usd(SUPPORTER_PACK.minimumWebUsd)}`,
                per: 'monthly or once',
                lines: SUPPORTER_PACK.perks,
                includesPack: false,
                note: SUPPORTER_PACK.cloudNote,
                cta: 'Support Happier',
                href: null,
                featured: false,
            },
        ],
    },
] as const satisfies ReadonlyArray<{ id: string; title: string; subtitle: string; cards: readonly PlanCardCopy[] }>;

const ribbonCaption = (plan: (typeof CLOUD_PLANS)[number]) =>
    plan.monthlyUsd === 0
        ? `leaves ${plan.sessionDays} days after its last activity, unless you pin it`
        : `kept ${kept(plan.sessionDays)} after its last activity`;

export const PLANS_PAGE = {
    eyebrow: 'Plans',
    // The page's promise is the headline (lab sp3Web:plans); the page keeps its name in the
    // document title and navigation.
    title: 'Every feature, free. Pay only to keep more.',
    lead: `Set your own limits on a self-hosted server, or use Happier Cloud for free. Lite and Plus keep more of your history on our servers. The ${SUPPORTER_PACK.name} is for anyone, on any server.`,
    ribbonTitle: 'History on Happier Cloud',
    ribbonCaption: 'An example history: each tick is a session, gold dots are pinned.',
    ribbonAxisAgo: 'days ago',
    ribbonAxisToday: 'Today',
    /** `keepDays` is null when the period runs past the ribbon's 120 days. */
    ribbonRows: CLOUD_PLANS.map((plan) => ({
        id: plan.id,
        name: plan.name,
        keepDays: plan.sessionDays <= 120 ? plan.sessionDays : null,
        caption: ribbonCaption(plan),
    })),
    includesPack: `Includes the ${SUPPORTER_PACK.name}`,
    finePrint: `Prices are in US dollars. Monthly subscriptions renew until you cancel. On the web, the ${SUPPORTER_PACK.name} is also available as a one-time purchase. In the App Store and Google Play, it comes in fixed amounts.`,
    fileStorageNote: plansRelease.fileStorageLive ? null : 'Cloud file storage limits are planned for Happier 0.3.',
    teamsHeading: 'Teams',
    teamsBody: plansRelease.teamsLive
        ? `The first ${TEAMS_PLAN.freeMembers === 3 ? 'three' : TEAMS_PLAN.freeMembers} people are free, then ${usd(TEAMS_PLAN.monthlyUsdPerAdditionalMember)} a person a month. Members of a team that pays for seats get Plus history, and every team feature is included at every size.`
        : `Teams arrive with Happier 0.3. The first ${TEAMS_PLAN.freeMembers === 3 ? 'three' : TEAMS_PLAN.freeMembers} people will be free, then ${usd(TEAMS_PLAN.monthlyUsdPerAdditionalMember)} a person a month. Members of a team that pays for seats will get Plus history, and every team feature will be included at every size.`,
    faqHeading: 'Questions',
} as const;

const FREE = CLOUD_PLANS[0];

export const PLANS_FAQ = [
    {
        id: 'locked',
        q: 'Which features come with Free?',
        a: [`Every feature is free. Free, Lite, Plus, the ${SUPPORTER_PACK.name} and self-hosted run the same features. Lite and Plus change how much history our servers keep.`],
    },
    {
        id: 'lite-vs-pack',
        q: `What’s the difference between Lite and the ${SUPPORTER_PACK.name}?`,
        a: [
            `Lite is Happier Cloud history: sessions kept ${CLOUD_PLANS[1].sessionDays} days after their last activity, ${CLOUD_PLANS[1].pins} pins and subagent transcripts for ${CLOUD_PLANS[1].subagentDays} days, with the ${SUPPORTER_PACK.name} included. The ${SUPPORTER_PACK.name} on its own changes no limits. It’s a thank-you anyone can buy, on any server, self-hosted included.`,
        ],
    },
    {
        id: 'session-limit',
        q: `What happens when a session reaches ${FREE.sessionDays} days?`,
        a: [
            `${SESSION_NOTICE_DAYS === 7 ? 'Seven' : SESSION_NOTICE_DAYS} days before, the app shows it in Keep or let go. Pin it or keep working in it and it stays. Otherwise it leaves Happier Cloud and stays in your list under External, where you can keep reading it from your agent’s log while that log exists and its machine is online. We can’t bring our copy back, because it’s encrypted to your devices. You can export any session as Markdown or JSON first.`,
        ],
    },
    {
        id: 'cancel',
        q: 'What happens if I cancel?',
        a: [`Your subscription ends after the period you paid for. You keep your paid history limits for another ${HISTORY_GRACE_DAYS} days, then Free limits apply. Pins above ${FREE.pins} stay pinned.`],
    },
    {
        id: 'self-host-pack',
        q: `I self-host. Can I still get the ${SUPPORTER_PACK.name}?`,
        a: [`Yes. The ${SUPPORTER_PACK.name} works from any server.`],
    },
    {
        id: 'numbers-change',
        q: 'Can these numbers change?',
        a: [`Yes. ${LIMIT_CHANGE_NOTICE} The Terms of Sale set out how.`],
    },
] as const;

export const SUPPORTERS_PAGE = {
    eyebrow: 'Supporters',
    title: 'The people who help fund Happier',
    intro: `The ${SUPPORTER_PACK.name} is a thank-you you can buy from any server, monthly or once, from ${usd(SUPPORTER_PACK.minimumWebUsd)}. Every amount gets the same pack: a permanent supporter number, a pass and badge in the app, and, only if you choose, your name on this page, in the app’s credits and in the README. Nothing about Happier itself changes when you buy it; every feature is already free.`,
    openLead: 'Read what we charge for and where the money goes on the',
    openLinkText: 'Open page',
    empty: 'No names yet. You could be number one.',
    /** `{n}`, `{name}` and `{since}` are filled by the wall. */
    entry: 'No. {n} · {name} · since {since}, thank you',
    unknown: 'Thank you for supporting Happier. New names can take a day to appear.',
    linked: {
        sponsor: 'Your GitHub sponsorship has been verified and your Supporter Pack is ready.',
        supporter: 'Your GitHub account is linked for your supporter label.',
        contributor: 'Your GitHub contributor account is linked.',
        none: 'We couldn’t find a supporter or contributor on that account. You can check the linked account in Plans & Supporter in the app.',
        error: 'We couldn’t verify your GitHub sponsorship. Please try again from Plans & Supporter.',
    },
    discordLinked: {
        supporter: 'Your Supporter role is ready in Discord.',
        contributor: 'Your Contributor role is ready in Discord.',
        none: 'Link a verified GitHub account in Discord to check for the Contributor role, or open Plans & Supporter in Happier to link your Supporter account.',
        error: 'We couldn’t verify your Discord roles. Please start again from Discord or Happier.',
        retry: 'GitHub couldn’t verify your Contributor role right now. Please try again from Discord’s Linked Roles menu.',
    },
    cta: plansRelease.purchasesLive ? 'Become a supporter' : 'See the Supporter Pack',
    countOne: '{count} supporter',
    countMany: '{count} supporters',
} as const;

export const THANKS_PAGE = {
    title: 'Thank you for supporting Happier.',
    lead: 'Open Happier on this device to add the Supporter Pack to your account.',
    codeLabel: 'Your supporter code',
    codeHint: 'Keep this code private. It lets Happier find and apply your purchase.',
    open: 'Open Happier',
    noCode: 'If you bought from inside the app, it’s already on its way to your account. Otherwise open Plans & Supporter in the app and choose Check again.',
    copy: 'Copy',
    copied: 'Copied',
} as const;
