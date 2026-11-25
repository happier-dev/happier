import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { t } from '@/text';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

/**
 * The selected profile's paid consent for this start only, never a saved preference.
 */
export type ReviewStartCostConsent = Readonly<{
  id: string;
  engine: string;
  title: string;
  description?: string;
  estimate?: string;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}>;
export function ReviewCostConsentRows(props: Readonly<{ costs: readonly ReviewStartCostConsent[]; disabled?: boolean }>) {
  const commands = useCurrentUiContextLocalCommands(props.disabled ? [] : props.costs.map(cost => ({
    key: `review.start.cost.${cost.id}`,
    title: cost.title,
    description: `review.start.cost.${cost.id} — Set this Review draft's cost acknowledgement with {value: boolean}.`,
    invoke: input => {
      if (!isJsonObject(input) || typeof input.value !== 'boolean') return false;
      cost.onAcceptedChange(input.value);
    },
  })), { unbound: 'local' });
  return <>{props.costs.map((cost, index) => (
        <Item
          key={cost.id}
          testID={index === 0 ? 'review-start-cost-consent' : `review-start-cost-consent:${cost.id}`}
          leftElement={
            <SelectionCheckGlyph
              state={cost.accepted ? 'checked' : 'unchecked'}
            />
          }
          title={cost.title}
          subtitle={cost.description ?? t('reviewWalkthrough.start.billedTo', {
            engine: cost.engine,
          })}
          accessibilityRole="checkbox"
          accessibilityChecked={cost.accepted}
          onPress={() => { void commands.invoke(`review.start.cost.${cost.id}`, { value: !cost.accepted }); }}
          disabled={props.disabled}
          showChevron={false}
        />
  ))}</>;
}
