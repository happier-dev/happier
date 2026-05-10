import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { SessionsListPaneContent } from '@/components/sessions/shell/SessionsListPaneContent';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
    },
}));

export function SessionsListWrapper() {
    const { externalSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SessionsListStorageChrome
                externalSessionsEnabled={externalSessionsEnabled}
                storageKind={storageKind}
                onSelectStorageKind={setStorageKind}
            />
            <SessionsListPaneContent storageKind={storageKind} fallbackGuidanceVariant="phone" />
        </View>
    );
}
