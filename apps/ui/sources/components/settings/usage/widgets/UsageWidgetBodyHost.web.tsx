import * as React from 'react';
import { View } from 'react-native';

import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';
import { t } from '@/text';

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

/**
 * While the body's code loads, hold the room the body last drew here so its arrival moves nothing below it. The room
 * holds the same loading rows the body's own first read draws, never a centred spinner card of a fixed height that
 * every card shares and then leaves (USAGE-DESIGN-PASS-57 #6).
 */
function UsageBodyLoadingRoom(props: Readonly<{ serverId: string; testID: string }>) {
    const remembered = useUsageBodyRememberedHeight(usageBodyOccurrence(props.serverId, props.testID));
    const rows = <ItemLoadStateRows testID={`${props.testID}.loading`} state={LOADING} rows={3} lines={2} shape="list"
        accessibilityLabel={t('usage.board.page.loading')} />;
    if (remembered === null) return rows;
    return <View style={{ height: remembered, overflow: 'hidden' }}>{rows}</View>;
}

const LOADING = Object.freeze({ kind: 'loading' as const });
