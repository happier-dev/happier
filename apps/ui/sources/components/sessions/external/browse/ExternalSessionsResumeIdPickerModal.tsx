import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';

import { ExternalSessionsBrowseScreen, type ExternalSessionsBrowseScopeLock } from './ExternalSessionsBrowseScreen';

export type ExternalSessionsResumeIdPickerModalProps = CustomModalInjectedProps & Readonly<{
    lockScope: ExternalSessionsBrowseScopeLock;
    onResolve: (value: string | null) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
}));

export const ExternalSessionsResumeIdPickerModal = React.memo(function ExternalSessionsResumeIdPickerModal(
    props: ExternalSessionsResumeIdPickerModalProps,
) {
    const styles = stylesheet;
    return (
        <View style={styles.body}>
            <ExternalSessionsBrowseScreen
                interaction="pickRemoteSessionId"
                lockScope={props.lockScope}
                onPickRemoteSessionId={(remoteSessionId) => {
                    props.onResolve(remoteSessionId);
                    props.onClose();
                }}
                onRequestClose={() => {
                    props.onResolve(null);
                    props.onClose();
                }}
            />
        </View>
    );
});
