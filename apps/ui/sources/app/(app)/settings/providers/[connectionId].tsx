import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { ProviderConnectionDetailScreen } from '@/components/settings/providers/ProviderConnectionDetailScreen';

export default function ProviderConnectionRoute() {
    const params = useLocalSearchParams<{ connectionId?: string | string[] }>();
    const connectionId = Array.isArray(params.connectionId) ? params.connectionId[0] ?? '' : params.connectionId ?? '';
    return <ProviderConnectionDetailScreen connectionId={connectionId} />;
}
