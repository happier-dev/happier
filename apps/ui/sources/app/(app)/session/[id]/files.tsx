import * as React from 'react';
import { useRoute } from '@react-navigation/native';

import { SessionFilesScreenView } from '@/components/sessions/files/views/SessionFilesScreenView';

export default function FilesScreenRoute() {
    const route = useRoute();
    const sessionId = (route.params as any)?.id as string;
    return <SessionFilesScreenView sessionId={sessionId} />;
}
