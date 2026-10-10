import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { t } from '@/text';

/**
 * The launcher route chip's popover (RT4): follow the session (the default) or choose for this Run.
 * Choosing reveals the Run's own model field in place; nothing changes until a model is picked there.
 */
export function ExecutionRunRouteChoiceContent(props: Readonly<{
    inherits: boolean;
    /** False when the Run targets another Agent than the session's: there is no route to follow. */
    canInherit: boolean;
    inheritDetail: string | null;
    onInherit: () => void;
    /** The Run's own model choice (the launcher's model field); null when this start offers none. */
    chooseContent: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const [choosing, setChoosing] = React.useState(!props.inherits);
    const showChoice = (choosing || !props.inherits) && props.chooseContent !== null;
    return (
        <View testID="execution-run-route-choice">
            <ActionListSection actions={[
                {
                    id: 'inherit',
                    testID: 'execution-run-route-choice.inherit',
                    label: t('runPage.menu.selectionInherited'),
                    subtitle: props.inheritDetail ?? undefined,
                    icon: <Icon name="arrow-elbow-down-right" size={18} color={theme.colors.text.secondary} />,
                    selected: props.inherits && !choosing,
                    disabled: !props.canInherit,
                    onPress: () => {
                        setChoosing(false);
                        if (!props.inherits) props.onInherit();
                    },
                },
                props.chooseContent !== null ? {
                    id: 'choose',
                    testID: 'execution-run-route-choice.choose',
                    label: t('runPage.menu.selectionChoose'),
                    subtitle: t('runPage.menu.selectionChooseDetail'),
                    icon: <Icon name="path" size={18} color={theme.colors.text.secondary} />,
                    selected: showChoice,
                    onPress: () => setChoosing(true),
                } : null,
            ]} />
            {showChoice ? props.chooseContent : null}
        </View>
    );
}
