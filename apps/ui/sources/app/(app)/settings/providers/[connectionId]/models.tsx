import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { ProviderConnectionModelsScreen } from '@/components/settings/providers/ProviderConnectionModelsScreen';

export default function ProviderConnectionModelsRoute() {
    const params = useLocalSearchParams<{ connectionId?: string | string[]; add?: string | string[] }>();
    const connectionId = Array.isArray(params.connectionId) ? params.connectionId[0] ?? '' : params.connectionId ?? '';
    const add = Array.isArray(params.add) ? params.add[0] : params.add;
    return <ProviderConnectionModelsScreen connectionId={connectionId} startAdding={add === '1'} />;
}
