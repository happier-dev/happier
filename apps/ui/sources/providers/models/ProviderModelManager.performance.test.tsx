import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

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

vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef((props: CapturedLegendListProps, _ref) => {
            legendListState.props = props;
            return ReactModule.createElement('ProviderModelsLegendList', props);
        }),
    };
});

import { ProviderModelManager, buildProviderModelManagerSections } from './ProviderModelManager';

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
    }
});
