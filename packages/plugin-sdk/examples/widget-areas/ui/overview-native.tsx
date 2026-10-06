import * as React from 'react';
import { defineUiSurface, PageHeader, Screen, ScrollArea, Select, Stack, WidgetSurface } from '@happier-dev/plugin-ui';

function Overview() {
    const [filter, setFilter] = React.useState<'open' | 'closed'>('open');
    const context = React.useMemo(() => ({ filter }), [filter]);
    return (
        <Screen>
            <ScrollArea accessibilityLabel="Widget areas">
                <Stack gap="medium">
                    <PageHeader title="Widget areas" description="Pin widgets that follow this page or keep their own filter." />
                    <Select label="Filter" presentation="segmented" value={filter}
                        options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]}
                        onChange={value => { if (value === 'open' || value === 'closed') setFilter(value); }} />
                    <WidgetSurface area="pinned" context={context} title="Pinned" />
                </Stack>
            </ScrollArea>
        </Screen>
    );
}

export const renderSurface = defineUiSurface(Overview);
