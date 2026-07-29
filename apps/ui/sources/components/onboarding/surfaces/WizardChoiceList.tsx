import * as React from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';

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
    style?: StyleProp<ViewStyle>;
    items: readonly WizardChoiceListEntry[];
}>): React.ReactNode {
    return (
        <View style={params.style}>
            {params.items.filter(isWizardChoiceListItem).map((item) => {
                const { itemKey, ...rowProps } = item;
                return <WizardChoiceRow key={itemKey} {...rowProps} />;
            })}
        </View>
    );
}
