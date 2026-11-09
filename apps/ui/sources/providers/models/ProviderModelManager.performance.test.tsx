import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { renderScreen } from '@/dev/testkit';

type CapturedLegendListProps = Readonly<{
    data?: readonly unknown[];
    children?: React.ReactNode;
    renderItem?: unknown;
}>;
const legendListState = vi.hoisted(() => ({ props: null as CapturedLegendListProps | null }));

function readCapturedLegendListProps(): CapturedLegendListProps | null {
    return legendListState.props;
}

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const ReactModule = await import('react');
    return {
        // The section-list entry reached by the virtualized barrel imports `internal` from here.
        ...(await importOriginal<Record<string, unknown>>()),
        LegendList: ReactModule.forwardRef((props: CapturedLegendListProps, _ref) => {
            legendListState.props = props;
            return ReactModule.createElement('ProviderModelsLegendList', props);
        }),
    };
});

import { ProviderModelManager, buildProviderModelManagerSections } from './ProviderModelManager';
import { MODEL_ROWS_PER_SEGMENT } from './ProviderModelManagerPage';

function group(count: number) {
    const connectionId = ProviderConnectionIdSchema.parse('pc_scale');
    return {
        connectionId,
        providerName: 'Gateway',
        connectionName: 'Scale',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
        modelLoadAction: 'descriptor_absent' as const,
        rows: Array.from({ length: count }, (_, index) => ({
            ref: { modelId: `model-${index}` },
            descriptor: { id: `model-${index}`, name: `Model ${index}`, description: `Model ${index} description` },
            sources: { manual: false, static: false, probe: true },
            catalog: { stale: false },
            loadState: 'unknown' as const,
            visibility: 'visible' as const,
        })),
    };
}

describe('ProviderModelManager catalog-scale gate', () => {
    for (const count of [100, 500, 5_000] as const) {
        it(`projects ${count} exact rows and delegates rendering to one recycler`, async () => {
            const groups = [group(count)];
            const sections = buildProviderModelManagerSections({
                scope: { kind: 'connection', connectionId: 'pc_scale' },
                nativeModels: [],
                groups,
                showHidden: true,
                onSetVisibility: () => {},
            });
            expect(sections[0]?.options).toHaveLength(count);

            legendListState.props = null;
            const screen = await renderScreen(
                <ProviderModelManager
                    scope={{ kind: 'connection', connectionId: 'pc_scale' }}
                    nativeModels={[]}
                    groups={groups}
                    showHidden
                    onSetVisibility={() => {}}
                    onRequestClose={() => {}}
                />,
            );
            const legendListProps = readCapturedLegendListProps();
            expect(legendListProps?.data).toHaveLength(count);
            expect(legendListProps?.children).toBeUndefined();
            expect(legendListProps?.renderItem).toEqual(expect.any(Function));
            expect(screen.findAllByType('ProviderModelsLegendList')).toHaveLength(1);
        });

        it(`hosts ${count} rows as a page section through the page's one recycler`, async () => {
            legendListState.props = null;
            const screen = await renderScreen(
                <ProviderModelManager
                    scope={{ kind: 'connection', connectionId: 'pc_scale' }}
                    nativeModels={[]}
                    groups={[group(count)]}
                    showHidden
                    onSetVisibility={() => {}}
                    onRequestClose={() => {}}
                    page={{ header: <></>, title: 'Models' }}
                />,
            );
            const data = readCapturedLegendListProps()?.data as ReadonlyArray<{ key: string }> | undefined;
            // The page's single list: the section controls, then the rows in bounded segments the
            // recycler mounts near the viewport; never one child per model up front.
            expect(screen.findAllByType('ProviderModelsLegendList')).toHaveLength(1);
            expect(data?.[0]?.key).toBe('models:controls');
            const segments = data?.filter((row) => row.key.startsWith('models:rows:')) ?? [];
            expect(segments.length).toBe(Math.ceil(count / MODEL_ROWS_PER_SEGMENT));
            expect(segments.length).toBeLessThan(count);
        });
    }
});
