import * as React from 'react';
import { View } from 'react-native';
import type { DeploySuggestionRecommendationV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import {
  ValueFieldSelect,
  type ValueFieldSelectItem,
} from '@/components/ui/forms/ValueFieldSelect';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { NewAppDeploySummary } from '../NewAppDeploySteps';
import type { NewAppAutoChosen } from './useNewAppAutoSuggestions';

type Change = Partial<
  Pick<DeploySuggestionRecommendationV1, 'source' | 'targetId' | 'data'>
>;
type Fact = 'source' | 'target' | 'data';

/**
 * Adjust the setup (journey-deploy autoAdjust): the chosen card's three facts as selects fed by the snapshot it was
 * checked against, and a note that asks for something else. Each change goes to the suggestion owner's
 * `adjustChosen` (its validator decides fit; no I/O); a change that does not fit leaves the fact as it was and says so.
 */
export function NewAppAutoAdjust(
  props: Readonly<{
    chosen: NewAppAutoChosen;
    title: string;
    source: string | null;
    note: string;
    onNoteChange: (next: string) => void;
    adjust: (change: Change) => boolean;
    onEditDescription: () => void;
    phone: boolean;
  }>,
) {
  const { recommendation, catalog } = props.chosen;
  const [refused, setRefused] = React.useState<Fact | null>(null);

  const sourceItems = React.useMemo(
    (): ValueFieldSelectItem[] => [
      ...catalog.starters.map((starter) => ({
        id: `starter:${starter.id}`,
        title: starter.title,
      })),
      { id: 'scratch', title: t('newApp.auto.scratch') },
      ...catalog.apps.map((app) => ({ id: `app:${app.id}`, title: app.title })),
    ],
    [catalog.apps, catalog.starters],
  );
  const targetItems = React.useMemo(
    (): ValueFieldSelectItem[] =>
      catalog.targets.map((target) => ({ id: target.id, title: target.title })),
    [catalog.targets],
  );
  const dataItems = React.useMemo(
    (): ValueFieldSelectItem[] => [
      { id: 'none', title: t('newApp.auto.dataNone') },
      ...catalog.stores.map((store) => ({
        id: `store:${store.id}`,
        title: store.engine,
      })),
    ],
    [catalog.stores],
  );

  const source = recommendation.source;
  const sourceId =
    source.kind === 'starter'
      ? `starter:${source.starterId}`
      : source.kind === 'catalogApp'
        ? `app:${source.appId}`
        : 'scratch';
  const data = recommendation.data;
  const dataId =
    data.kind === 'store'
      ? `store:${data.storeId}`
      : data.kind === 'none'
        ? 'none'
        : null;

  const apply = (fact: Fact, change: Change) =>
    setRefused(props.adjust(change) ? null : fact);
  const chooseSource = (id: string) =>
    apply('source', {
      source:
        id === 'scratch'
          ? { kind: 'scratch' }
          : id.startsWith('starter:')
            ? { kind: 'starter', starterId: id.slice('starter:'.length) }
            : { kind: 'catalogApp', appId: id.slice('app:'.length) },
    });
  const chooseData = (id: string) => {
    const store = catalog.stores.find(
      (candidate) => `store:${candidate.id}` === id,
    );
    apply('data', {
      data: store
        ? { kind: 'store', storeId: store.id, engine: store.engine }
        : { kind: 'none' },
    });
  };

  return (
    <View testID="newApp.auto.adjusting">
      <NewAppDeploySummary
        phone={props.phone}
        frame={null}
        onChangeSource={props.onEditDescription}
        source={{ title: t('newApp.auto.sourceTitle'), note: props.source }}
      />
      <ItemGroup title={props.title}>
        <Item
          title={t('newApp.auto.factStartsFrom')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={
            <ValueFieldSelect
              testID="newApp.auto.adjust.source"
              label={t('newApp.auto.factStartsFrom')}
              items={sourceItems}
              selectedId={sourceId}
              onSelect={chooseSource}
            />
          }
        />
        <Item
          title={t('newApp.auto.factRunsOn')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={
            <ValueFieldSelect
              testID="newApp.auto.adjust.target"
              label={t('newApp.auto.factRunsOn')}
              items={targetItems}
              selectedId={recommendation.targetId}
              onSelect={(id) => apply('target', { targetId: id })}
            />
          }
        />
        <Item
          title={t('newApp.auto.factData')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={
            <ValueFieldSelect
              testID="newApp.auto.adjust.data"
              label={t('newApp.auto.factData')}
              items={dataItems}
              selectedId={dataId}
              onSelect={chooseData}
            />
          }
        />
        {refused ? (
          <EmptyState
            testID="newApp.auto.adjust.refused"
            layout="line"
            title={t('newApp.auto.adjustRefused')}
          />
        ) : null}
      </ItemGroup>
      <ItemGroup
        surface="none"
        title={t('newApp.auto.askElse')}
        description={t('newApp.auto.askElseDescription')}
      >
        <FieldTextInput
          testID="newApp.auto.adjust.note"
          value={props.note}
          onChangeText={props.onNoteChange}
          accessibilityLabel={t('newApp.auto.askElse')}
          multiline
          minLines={3}
          growWithText
        />
      </ItemGroup>
    </View>
  );
}
