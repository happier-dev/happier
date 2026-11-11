import * as React from 'react';
import { View } from 'react-native';

import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { usageBodyOccurrence, useUsageBodyRememberedHeight } from './usageBodyHeightMemory';

// Keep the widget catalog lightweight until an actual Usage occurrence mounts.
const Content = retryableLazy(async () => ({
    default: (await import('./UsageWidgetBody')).UsageWidgetBody,
}));

export const UsageWidgetBody = React.memo((props: React.ComponentProps<typeof Content>) => (
    <React.Suspense fallback={<UsageBodyLoadingRoom serverId={props.serverId} testID={props.testID} />}>
        <Content {...props} />
    </React.Suspense>
));

/** While the body's code loads, hold the room the body last drew here so its arrival moves nothing below it. */
function UsageBodyLoadingRoom(props: Readonly<{ serverId: string; testID: string }>) {
    const remembered = useUsageBodyRememberedHeight(usageBodyOccurrence(props.serverId, props.testID));
    if (remembered === null) return <PaneLoadingFallback />;
    return <View style={{ height: remembered, overflow: 'hidden' }}><PaneLoadingFallback /></View>;
}
