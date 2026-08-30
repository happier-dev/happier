import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import type { MachinePathBrowserModalProps } from './MachinePathBrowserModal';
import { PATH_BROWSER_MODAL_TEST_ID } from './pathBrowserTestIds';

const LazyMachinePathBrowserModal = React.lazy(async () => {
    const module = await import('./MachinePathBrowserModal');
    return { default: module.MachinePathBrowserModal };
});

const stylesheet = StyleSheet.create(() => ({
    loading: {
        minHeight: 220,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

function MachinePathBrowserLoading(props: Pick<MachinePathBrowserModalProps, 'setChrome' | 'title'>) {
    const { theme } = useUnistyles();
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title ?? t('newSession.pathPicker.enterPathTitle'),
        testID: PATH_BROWSER_MODAL_TEST_ID,
        dimensions: { width: 560, maxHeightRatio: 0.92 },
    }), [props.title]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View testID="path-browser-loading" style={stylesheet.loading}>
            <ActivitySpinner
                size="small"
                color={theme.colors.text.secondary}
                accessibilityRole="progressbar"
                accessibilityLabel={t('common.loading')}
            />
        </View>
    );
}

export function MachinePathBrowserModalEntry(props: MachinePathBrowserModalProps) {
    return (
        <React.Suspense fallback={<MachinePathBrowserLoading setChrome={props.setChrome} title={props.title} />}>
            <LazyMachinePathBrowserModal {...props} />
        </React.Suspense>
    );
}
