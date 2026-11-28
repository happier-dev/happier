import { listSelectableBundledAgentExecutionTargets } from '@happier-dev/agents/definitions';
import { formatAgentLikeIdForDisplay } from '@happier-dev/agents/presentation';

import { t, type TranslationKey } from '@/text';

/**
 * The first Welcome's headline (owner 2026-11-26, from the website lab's hero, `website-lab/r10/headline.js`): its
 * first line runs through every supported Agent ("Run Codex.") and one phrase per feature, in a fresh order each
 * visit, and its second line ("Everywhere you go.") stays. Each phrase is a lead and the words it continues, so the
 * lead can stay put while only the words change. Verb first, at most four words, true of the product.
 */
export type WelcomeHeadlinePhrase = Readonly<{ lead: string; vary: string }>;

export type WelcomeHeadline = Readonly<{
  /** This visit's phrases in order; the first is the one every still presentation shows (the opening's replica too). */
  phrases: readonly WelcomeHeadlinePhrase[];
  /** What stands between a lead and its words in this language (a space, or nothing). */
  joiner: string;
  /** The second line, which never changes. */
  line2: string;
}>;

/** One phrase per feature: its lead and the words it continues. */
const FEATURE_PHRASES = {
  agents: ['welcome.headline.agentsLead', 'welcome.headline.agentsVary'],
  bots: ['welcome.headline.botsLead', 'welcome.headline.botsVary'],
  workflows: [
    'welcome.headline.workflowsLead',
    'welcome.headline.workflowsVary',
  ],
  reviews: ['welcome.headline.reviewsLead', 'welcome.headline.reviewsVary'],
  issues: ['welcome.headline.issuesLead', 'welcome.headline.issuesVary'],
  discussions: [
    'welcome.headline.discussionsLead',
    'welcome.headline.discussionsVary',
  ],
  channels: ['welcome.headline.channelsLead', 'welcome.headline.channelsVary'],
  teams: ['welcome.headline.teamsLead', 'welcome.headline.teamsVary'],
  voice: ['welcome.headline.voiceLead', 'welcome.headline.voiceVary'],
  computerUse: [
    'welcome.headline.computerUseLead',
    'welcome.headline.computerUseVary',
  ],
  browser: ['welcome.headline.browserLead', 'welcome.headline.browserVary'],
  terminal: ['welcome.headline.terminalLead', 'welcome.headline.terminalVary'],
  files: ['welcome.headline.filesLead', 'welcome.headline.filesVary'],
  machines: ['welcome.headline.machinesLead', 'welcome.headline.machinesVary'],
  remoteWorkspaces: [
    'welcome.headline.remoteWorkspacesLead',
    'welcome.headline.remoteWorkspacesVary',
  ],
  providers: [
    'welcome.headline.providersLead',
    'welcome.headline.providersVary',
  ],
  usage: ['welcome.headline.usageLead', 'welcome.headline.usageVary'],
  secrets: ['welcome.headline.secretsLead', 'welcome.headline.secretsVary'],
  deployments: [
    'welcome.headline.deploymentsLead',
    'welcome.headline.deploymentsVary',
  ],
  servers: ['welcome.headline.serversLead', 'welcome.headline.serversVary'],
  databases: [
    'welcome.headline.databasesLead',
    'welcome.headline.databasesVary',
  ],
  monitoring: [
    'welcome.headline.monitoringLead',
    'welcome.headline.monitoringVary',
  ],
  softwareFactory: [
    'welcome.headline.softwareFactoryLead',
    'welcome.headline.softwareFactoryVary',
  ],
} as const satisfies Record<string, readonly [TranslationKey, TranslationKey]>;

export type WelcomeHeadlineFeatureId = keyof typeof FEATURE_PHRASES;
export const WELCOME_HEADLINE_FEATURE_IDS = Object.keys(
  FEATURE_PHRASES,
) as readonly WelcomeHeadlineFeatureId[];

export type WelcomeHeadlineEntry =
  | Readonly<{ kind: 'agent'; agentId: string }>
  | Readonly<{ kind: 'feature'; featureId: WelcomeHeadlineFeatureId }>;

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A visit's order: each list shuffled, then spread evenly through the other from a random phase, so Agents and
 * features alternate (never more than two Agents in a row) and the cycle wraps without repeating a phrase. The cycle
 * starts on a feature: the first phrase is the one every still presentation shows (reduced motion, native, the
 * opening's replica), and one Agent's name standing alone reads as a single-Agent app (owner, 2026-11-27).
 */
export function composeWelcomeHeadlineOrder(
  input: Readonly<{
    agentIds: readonly string[];
    featureIds: readonly WelcomeHeadlineFeatureId[];
    random: () => number;
  }>,
): readonly WelcomeHeadlineEntry[] {
  const agents = shuffled(input.agentIds, input.random).map(
    (agentId) => ({ kind: 'agent', agentId }) as const,
  );
  const features = shuffled(input.featureIds, input.random).map(
    (featureId) => ({ kind: 'feature', featureId }) as const,
  );
  const total = agents.length + features.length;
  const phase = input.random();
  const out: WelcomeHeadlineEntry[] = [];
  let a = 0;
  let f = 0;
  for (let i = 0; i < total; i++) {
    const wantsAgent =
      Math.floor(((i + 1) * agents.length) / total + phase) -
        Math.floor((i * agents.length) / total + phase) >
      0;
    out.push(
      (wantsAgent && a < agents.length) || f >= features.length
        ? agents[a++]!
        : features[f++]!,
    );
  }
  // Starting the same cycle at its first feature keeps every spacing, including across the wrap.
  const start = Math.max(0, out.findIndex((entry) => entry.kind === 'feature'));
  return [...out.slice(start), ...out.slice(0, start)];
}

/** Every Agent this build can start, once each, from the Agent catalog owner. */
function supportedAgentIds(): readonly string[] {
  return [
    ...new Set(
      listSelectableBundledAgentExecutionTargets().map(
        (entry) => entry.agentId,
      ),
    ),
  ];
}

let visitOrder: readonly WelcomeHeadlineEntry[] | null = null;

/** This visit's order: chosen once per app load, the first time a Welcome is composed (before it can paint). */
export function readWelcomeHeadlineVisitOrder(): readonly WelcomeHeadlineEntry[] {
  visitOrder ??= composeWelcomeHeadlineOrder({
    agentIds: supportedAgentIds(),
    featureIds: WELCOME_HEADLINE_FEATURE_IDS,
    random: Math.random,
  });
  return visitOrder;
}

/** The headline in the current language for an order of entries. */
export function translateWelcomeHeadline(
  order: readonly WelcomeHeadlineEntry[],
): WelcomeHeadline {
  const agentLead = t('welcome.headline.agentLead');
  return {
    phrases: order.map((entry) => {
      if (entry.kind === 'agent')
        return {
          lead: agentLead,
          vary: t('welcome.headline.agentVary', {
            agent: formatAgentLikeIdForDisplay(entry.agentId),
          }),
        };
      const [lead, vary] = FEATURE_PHRASES[entry.featureId];
      return { lead: t(lead), vary: t(vary) };
    }),
    joiner: t('welcome.headline.joiner'),
    line2: t('welcome.headline.everywhere'),
  };
}

/** A phrase as one line of text (its accessible name and the still presentation's words). */
export function joinWelcomeHeadlinePhrase(
  phrase: WelcomeHeadlinePhrase,
  joiner: string,
): string {
  return `${phrase.lead}${joiner}${phrase.vary}`;
}
