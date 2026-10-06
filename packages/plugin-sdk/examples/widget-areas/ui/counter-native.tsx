import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { Action, defineUiSurface, ErrorState, LoadingState, Metric, Stack, Text, useLivePluginResource } from '@happier-dev/plugin-ui';

function readCount(bytes: Uint8Array): number | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof value !== 'object' || value === null || !('count' in value)) return null;
        return typeof value.count === 'number' && Number.isFinite(value.count) ? value.count : null;
    } catch { return null; }
}

function Counter({ launchInput }: RenderContext) {
    const { resource, refresh } = useLivePluginResource('count');
    const filter = launchInput !== null && typeof launchInput === 'object' && !Array.isArray(launchInput)
        && 'filter' in launchInput && typeof launchInput.filter === 'string' ? launchInput.filter : null;
    if (filter === null) return <ErrorState layout="line" title="Choose a filter in Edit inputs" />;
    const retry = <Action.Refresh title="Refresh count" onRefresh={refresh} />;
    if (!resource.value) return resource.error
        ? <ErrorState layout="line" title="Count is unavailable" action={retry} />
        : <LoadingState layout="line" title="Loading count" />;
    const count = resource.value.contentType === 'application/json' ? readCount(resource.value.bytes) : null;
    if (count === null) return <ErrorState layout="line" title="Count could not be read" action={retry} />;
    return (
        <Stack gap="small">
            <Metric label="Registered count" value={count} />
            <Text value={`Filter: ${filter}`} tone="secondary" />
        </Stack>
    );
}

export const renderSurface = defineUiSurface(Counter);
