import { Redirect } from 'expo-router';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';

export default function NewAutomationRoute() {
    const support = useAutomationsSupport();
    if (support && !support.enabled) {
        return <Redirect href={'/new' as any} />;
    }
    return <Redirect href={'/new?automation=1' as any} />;
}
