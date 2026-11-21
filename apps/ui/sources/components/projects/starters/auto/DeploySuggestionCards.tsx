import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  DeploySuggestionCatalogV1,
  DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { FieldLayout } from '@/components/ui/lists/FieldRow';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { DeploymentTargetPlans, declaredPlanLine } from '@/components/projects/deployments/DeploymentTargetPlans';
import { useDeploymentPlatformTargets } from '@/components/projects/deployments/DeploymentPlatformTargetSheet';
import type { DeploymentPlatformTarget } from '@/components/projects/deployments/platformTargetLink';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

/** One labelled fact on a suggestion card (lab autoRecs): what it starts from, where it runs, its data. */
export type NewAppAutoFact = Readonly<{
  key: 'startsFrom' | 'runsOn' | 'data';
  value: string;
  /** The identity drawn before the value (a starter's glyph, a platform's mark). */
  mark?: React.ReactNode;
}>;

export type NewAppAutoCard = Readonly<{
  id: string;
  /** The suggestion's short name, then its one line on why it fits (lab autoRecs). */
  title: string;
  why: string;
  recommended: boolean;
  facts: readonly NewAppAutoFact[];
  /** The platform's declared plans with their dated source (U3); never the person's plan, which only Review reads (A2). */
  plans: DeclaredTargetPlans | null;
  /** The platform's name when the Account has no working connection to it yet (catalog `needs_connection`). */
  connect: string | null;
}>;

/** A target's plans as its plugin declared them to this Account, with the platform's name. */
export type DeclaredTargetPlans = Readonly<{ plans: NonNullable<DeploymentPlatformTarget['plans']>; platform: string }>;

const CARD_PREFIX = 'suggestion-';

/** A card's id is its recommendation's place in the checked result: the first one is the recommended card. */
export const deploySuggestionCardId = (index: number) =>
  `${CARD_PREFIX}${index}`;

/** The recommendation a card id names, or `null` for an id from another result. */
export function deploySuggestionCardIndex(id: string): number | null {
  if (!id.startsWith(CARD_PREFIX)) return null;
  const index = Number(id.slice(CARD_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * A card says the owner's facts in words: every title comes from the snapshot the suggestion was checked against.
 * Both hosts present a checked result through this one function (the dialog's Describe your app and a Session's
 * `deployments.suggestions.check` result, deploy auto-mode U10).
 */
export function presentDeploySuggestionCard(
  recommendation: DeploySuggestionRecommendationV1,
  catalog: DeploySuggestionCatalogV1,
  index: number,
  starterMark: React.ReactNode,
  /**
   * The Account's declared plans for a target id. Plans never come from the catalog copy a Session agent passes in its
   * check call, which it may have paraphrased (review D1).
   */
  declaredPlans: (targetId: string) => DeclaredTargetPlans | null,
): NewAppAutoCard {
  const source = recommendation.source;
  const sourceTitle =
    source.kind === 'starter'
      ? catalog.starters.find((item) => item.id === source.starterId)?.title
      : source.kind === 'catalogApp'
        ? catalog.apps.find((item) => item.id === source.appId)?.title
        : undefined;
  const targetRow = catalog.targets.find(
    (item) => item.id === recommendation.targetId,
  );
  const target = targetRow?.title;
  const data = recommendation.data;
  const store = data.kind === 'store' ? catalog.stores.find((item) => item.id === data.storeId) : undefined;
  const dataTitle =
    data.kind === 'store'
      ? [store?.title, data.engine].filter(Boolean).join(' · ')
      : data.kind === 'catalogApp'
        ? catalog.apps.find((item) => item.id === data.appId)?.title
        : undefined;
  const facts: NewAppAutoFact[] = [
    ...(sourceTitle
      ? [
          {
            key: 'startsFrom' as const,
            value: sourceTitle,
            ...(source.kind === 'starter' ? { mark: starterMark } : {}),
          },
        ]
      : []),
    ...(target ? [{ key: 'runsOn' as const, value: target }] : []),
    ...(dataTitle ? [{ key: 'data' as const, value: dataTitle }] : []),
  ];
  return {
    id: deploySuggestionCardId(index),
    title: recommendation.title,
    why: recommendation.why,
    recommended: index === 0,
    facts,
    plans: declaredPlans(recommendation.targetId),
    connect: targetRow?.availability === 'needs_connection' ? targetRow.title : null,
  };
}

/**
 * The Account's declared plans by target id, read through the same declared-target reader Where it runs uses, and only
 * while a recommendation runs on a platform. Both hosts' cards take their plans from here (review D1).
 */
export function useDeclaredTargetPlans(
  recommendations: readonly DeploySuggestionRecommendationV1[] | null,
  catalog: DeploySuggestionCatalogV1 | null,
): (targetId: string) => DeclaredTargetPlans | null {
  const wantsPlans = Boolean(recommendations?.some((recommendation) =>
    catalog?.targets.some((target) => target.id === recommendation.targetId && target.targetClass === 'platform')));
  const lifetime = useActiveServerAccountScopeLifetime();
  const platforms = useDeploymentPlatformTargets(wantsPlans ? lifetime : null).state;
  const declared = platforms.status === 'ready' ? platforms.targets : null;
  return React.useCallback((targetId: string) => {
    const target = declared?.find((candidate) => candidate.key === targetId);
    return target?.plans?.length ? { plans: target.plans, platform: target.title } : null;
  }, [declared]);
}

/** The checked result's cards, in order, with the starter glyph both hosts draw before a starter's name. */
export function useDeploySuggestionCards(
  recommendations: readonly DeploySuggestionRecommendationV1[] | null,
  catalog: DeploySuggestionCatalogV1 | null,
): readonly NewAppAutoCard[] {
  const { theme } = useUnistyles();
  const glyph = theme.colors.text.secondary;
  const declaredPlans = useDeclaredTargetPlans(recommendations, catalog);
  return React.useMemo(() => {
    if (!recommendations || !catalog) return [];
    return recommendations.map((recommendation, index) =>
      presentDeploySuggestionCard(
        recommendation,
        catalog,
        index,
        <Icon name="sparkle" size={ICON_SIZE.sm} color={glyph} />,
        declaredPlans,
      ),
    );
  }, [catalog, declaredPlans, glyph, recommendations]);
}

/**
 * The suggestion cards (lab autoRecs): one card per line, the recommended one first and badged, each with its
 * labelled facts on one label column and its platform's dated plans. A card is a radio in the group; Tab enters the group at the chosen
 * card, the arrow keys move between cards, and the next Tab leaves for the host's actions.
 */
export function DeploySuggestionCardTiles(
  props: Readonly<{
    cards: readonly NewAppAutoCard[];
    value: string | null;
    onChange: (id: string) => void;
    phone: boolean;
    testIdPrefix: string;
  }>,
) {
  const { cards } = props;
  const options = React.useMemo(
    () =>
      cards.map((card) => ({
        id: card.id,
        title: card.title,
        subtitle: card.why,
        ...(card.recommended ? { badge: t('newApp.auto.recommended') } : {}),
        footerLabel: cardFactsLabel(card),
      })),
    [cards],
  );
  return (
    <SelectionTiles
      testIdPrefix={props.testIdPrefix}
      maximumColumns={1}
      subtitleLines={0}
      // The facts stand under the title on the card's own edge, as the Where cards' do (jdF-autoRecs); a card has no
      // glyph, so no icon column is held for it.
      descriptionPlacement="below"
      accessibilityLabel={t('newApp.auto.recommendationsTitle')}
      value={props.value}
      onChange={(id) => {
        if (id) props.onChange(id);
      }}
      options={options}
      renderOptionFooter={({ option }) => {
        const card = cards.find((candidate) => candidate.id === option.id);
        return card ? (
          <CardFacts card={card} phone={props.phone} testID={`${props.testIdPrefix}:${card.id}`} />
        ) : null;
      }}
    />
  );
}

const FACT_LABEL_KEY = {
  startsFrom: 'newApp.auto.factStartsFrom',
  runsOn: 'newApp.auto.factRunsOn',
  data: 'newApp.auto.factData',
} as const;

/** The card's target and the plans its floor shows, in the words drawn there, for the card's accessible name (U11 QA). */
function cardFactsLabel(card: NewAppAutoCard): string {
  const target = card.facts.find((fact) => fact.key === 'runsOn');
  return [
    target ? `${t(FACT_LABEL_KEY.runsOn)} ${target.value}` : null,
    card.connect ? t('projects.deployments.platformLink.connectTitle', { platform: card.connect }) : null,
    ...(card.plans?.plans.map(declaredPlanLine) ?? []),
  ].filter(Boolean).join(', ');
}

/**
 * The card's floor: its labelled facts on one label column, the identity before each value, then the platform's
 * declared plans with their price and dated source (U3) through the plans owner the Where cards use.
 */
function CardFacts(
  props: Readonly<{ card: NewAppAutoCard; phone: boolean; testID: string }>,
) {
  const { theme } = useUnistyles();
  const { facts, plans, connect } = props.card;
  return (
    <View style={styles.facts}>
      {facts.map((fact) => (
        <FieldLayout
          key={fact.key}
          label={t(FACT_LABEL_KEY[fact.key])}
          columns={!props.phone}
        >
          <View style={styles.factValue}>
            {fact.mark ?? null}
            <Text
              variant="body"
              style={{ flexShrink: 1, color: theme.colors.text.primary }}
            >
              {fact.value}
            </Text>
          </View>
        </FieldLayout>
      ))}
      {connect ? (
        // The connect step itself is on Where it runs; the card says it is needed before choosing it.
        <Text testID={`${props.testID}:connect`} variant="body" style={{ color: theme.colors.text.secondary }}>
          {t('projects.deployments.platformLink.connectTitle', { platform: connect })}
        </Text>
      ) : null}
      {plans ? (
        <View testID={`${props.testID}:plans`}>
          <DeploymentTargetPlans plans={plans.plans} platform={plans.platform} columns={!props.phone}
            phone={props.phone} testID={`${props.testID}:plans`} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  facts: {
    gap: theme.space.s6,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  factValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
