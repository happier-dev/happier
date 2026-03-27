import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';

import { DirectSessionsBrowseScreen, type DirectSessionsBrowseScopeLock } from './DirectSessionsBrowseScreen';

export type DirectSessionsResumeIdPickerModalProps = CustomModalInjectedProps & Readonly<{
    lockScope: DirectSessionsBrowseScopeLock;
    onResolve: (value: string | null) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
}));

export const DirectSessionsResumeIdPickerModal = React.memo(function DirectSessionsResumeIdPickerModal(
    props: DirectSessionsResumeIdPickerModalProps,
) {
    const styles = stylesheet;
    return (
        <View style={styles.body}>
            <DirectSessionsBrowseScreen
                interaction="pickRemoteSessionId"
                lockScope={props.lockScope}
                onPickRemoteSessionId={(remoteSessionId) => {
                    props.onResolve(remoteSessionId);
                    props.onClose();
                }}
            />
        </View>
    );
});
