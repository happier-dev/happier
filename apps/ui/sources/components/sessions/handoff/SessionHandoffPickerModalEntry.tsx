import { getActionSpec } from '@happier-dev/protocol';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import type { SessionHandoffPickerModalProps } from './SessionHandoffPickerModal';

const LazySessionHandoffPickerModal = React.lazy(async () => {
    const module = await import('./SessionHandoffPickerModal');
    return { default: module.SessionHandoffPickerModal };
});

const stylesheet = StyleSheet.create(() => ({
    loading: {
        minHeight: 180,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

function SessionHandoffPickerLoading({ setChrome }: Pick<SessionHandoffPickerModalProps, 'setChrome'>) {
    const { theme } = useUnistyles();
    const actionSpec = getActionSpec('session.handoff');
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: actionSpec.title,
        subtitle: actionSpec.description,
        testID: 'session-handoff-modal',
        dimensions: { width: 520, maxHeightRatio: 0.92 },
    }), [actionSpec.description, actionSpec.title]);

    useModalCardChrome(setChrome, chrome);

    return (
        <View testID="session-handoff-loading" style={stylesheet.loading}>
            <ActivitySpinner
                size="small"
                color={theme.colors.text.secondary}
                accessibilityRole="progressbar"
                accessibilityLabel={t('common.loading')}
            />
        </View>
    );
}

export function SessionHandoffPickerModalEntry(props: SessionHandoffPickerModalProps) {
    return (
        <React.Suspense fallback={<SessionHandoffPickerLoading setChrome={props.setChrome} />}>
            <LazySessionHandoffPickerModal {...props} />
        </React.Suspense>
    );
}
