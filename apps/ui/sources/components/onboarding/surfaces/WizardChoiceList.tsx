import * as React from 'react';
import { HappierItemGroupBehavior } from '@happier-dev/plugin-ui/presentation';
import { Platform, type StyleProp, View, type ViewStyle } from 'react-native';

import { WizardChoiceRow } from '../ui/WizardChoiceRow';

type WizardChoiceRowProps = React.ComponentProps<typeof WizardChoiceRow>;

export type WizardChoiceListItem = Readonly<WizardChoiceRowProps & {
    itemKey: React.Key;
}>;

type WizardChoiceListEntry = WizardChoiceListItem | null | false | undefined;

function isWizardChoiceListItem(item: WizardChoiceListEntry): item is WizardChoiceListItem {
    return Boolean(item);
}

export function renderWizardChoiceList(params: Readonly<{
    accessibilityLabel: string;
    style?: StyleProp<ViewStyle>;
    items: readonly WizardChoiceListEntry[];
}>): React.ReactNode {
    const items = params.items.filter(isWizardChoiceListItem);
    const isWeb = Platform.OS === 'web';
    return (
        <HappierItemGroupBehavior
            accessibilityRole="radiogroup"
            accessibilityLabel={params.accessibilityLabel}
            selectableItemCount={items.length}
            renderContent={(projectedItems) => (
                <View
                    style={params.style}
                    accessibilityRole={isWeb ? undefined : 'radiogroup'}
                    accessibilityLabel={params.accessibilityLabel}
                    role={isWeb ? 'radiogroup' : undefined}
                    aria-label={isWeb ? params.accessibilityLabel : undefined}
                >
                    {projectedItems}
                </View>
            )}
        >
            {items.map((item) => {
                const { itemKey, ...rowProps } = item;
                return <WizardChoiceRow key={itemKey} {...rowProps} accessibilityRole="radio" />;
            })}
        </HappierItemGroupBehavior>
    );
}
