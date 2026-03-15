import * as React from 'react';
import { View } from 'react-native';
import { useRoute } from '@react-navigation/native';

import { SessionFilesScreenView } from '@/components/sessions/files/views/SessionFilesScreenView';

export default function FilesScreenRoute() {
    const route = useRoute();
    const sessionId = (route.params as any)?.id as string;
    return (
        <View testID="session-files-screen" style={{ flex: 1 }}>
            <SessionFilesScreenView sessionId={sessionId} />
        </View>
    );
}
