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

/** One labelled fact on a suggestion card (lab autoRecs): what it starts from, where it runs, its data. */
export type NewAppAutoFact = Readonly<{
  key: 'startsFrom' | 'runsOn' | 'data';
  value: string;
  /** The identity drawn before the value (a starter's glyph, a platform's mark). */
  mark?: React.ReactNode;
}>;

export type NewAppAutoCard = Readonly<{
  id: string;
  title: string;
  why: string;
  recommended: boolean;
  facts: readonly NewAppAutoFact[];
}>;

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
): NewAppAutoCard {
  const source = recommendation.source;
  const sourceTitle =
    source.kind === 'starter'
      ? catalog.starters.find((item) => item.id === source.starterId)?.title
      : source.kind === 'catalogApp'
        ? catalog.apps.find((item) => item.id === source.appId)?.title
        : undefined;
  const target = catalog.targets.find(
    (item) => item.id === recommendation.targetId,
  )?.title;
  const data = recommendation.data;
  const dataTitle =
    data.kind === 'store'
      ? data.engine
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
  const card = recommendation as DeploySuggestionRecommendationV1 &
    Partial<Readonly<{ title: string; why: string }>>;
  return {
    id: deploySuggestionCardId(index),
    title: card.title ?? recommendation.whatToBuild,
    why: card.why ?? '',
    recommended: index === 0,
    facts,
  };
}

/** The checked result's cards, in order, with the starter glyph both hosts draw before a starter's name. */
export function useDeploySuggestionCards(
  recommendations: readonly DeploySuggestionRecommendationV1[] | null,
  catalog: DeploySuggestionCatalogV1 | null,
): readonly NewAppAutoCard[] {
  const { theme } = useUnistyles();
  const glyph = theme.colors.text.secondary;
  return React.useMemo(
    () =>
      !recommendations || !catalog
        ? []
        : recommendations.map((recommendation, index) =>
            presentDeploySuggestionCard(
              recommendation,
              catalog,
              index,
              <Icon name="sparkle" size={ICON_SIZE.sm} color={glyph} />,
            ),
          ),
    [catalog, glyph, recommendations],
  );
}

/**
 * The suggestion cards (lab autoRecs): one card per line, the recommended one first and badged, each with its why
 * and its labelled facts on one label column. A card is a radio in the group; Tab enters the group at the chosen
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
      })),
    [cards],
  );
  return (
    <SelectionTiles
      testIdPrefix={props.testIdPrefix}
      maximumColumns={1}
      subtitleLines={0}
      accessibilityLabel={t('newApp.auto.recommendationsTitle')}
      value={props.value}
      onChange={(id) => {
        if (id) props.onChange(id);
      }}
      options={options}
      renderOptionFooter={({ option }) => {
        const card = cards.find((candidate) => candidate.id === option.id);
        return card ? (
          <CardFacts facts={card.facts} phone={props.phone} />
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

/** The card's floor: its three labelled facts on one label column, the identity before each value. */
function CardFacts(
  props: Readonly<{ facts: readonly NewAppAutoFact[]; phone: boolean }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.facts}>
      {props.facts.map((fact) => (
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
