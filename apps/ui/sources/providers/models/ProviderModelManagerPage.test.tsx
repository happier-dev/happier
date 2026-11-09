import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { renderScreen } from '@/dev/testkit';

type CapturedPageRow = Readonly<{ key: string; render: () => React.ReactElement }>;
const legendListState = vi.hoisted(() => ({ data: null as readonly unknown[] | null }));

// The page's third-party recycler is the boundary; its row renderers stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const ReactModule = await import('react');
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        LegendList: ReactModule.forwardRef((props: Readonly<{ data?: readonly unknown[] }>, _ref) => {
            legendListState.data = props.data ?? null;
            return ReactModule.createElement('ProviderModelsLegendList', props);
        }),
    };
});

import { ProviderModelManager } from './ProviderModelManager';
import { MODEL_ROWS_PER_SEGMENT } from './ProviderModelManagerPage';

const connectionId = ProviderConnectionIdSchema.parse('pc_custom');
const groups = [{
    connectionId,
    providerName: 'Custom',
    connectionName: 'Work',
    connectionRole: 'named' as const,
    connectionDisplayNameMode: 'custom' as const,
    modelLoadAction: 'descriptor_absent' as const,
    authorization: { authorized: true as const },
    rows: [{
        ref: { modelId: 'm1' },
        descriptor: { id: 'm1', name: 'Model one' },
        sources: { manual: false, static: true, probe: false },
        confidence: 'verified_static' as const,
        compatibility: {
            result: {
                status: 'verified' as const,
                selectedProtocol: 'openai-chat' as const,
                evidence: { sourceUrls: ['https://example.com/compatibility'], verifiedAt: '2026-07-13' },
            },
            compatibilityFingerprint: 'compatibility:v1:page', confirmed: true,
        },
        catalog: { stale: false },
        loadState: 'unknown' as const,
        visibility: 'visible' as const,
    }],
}];
const grouping = {
    nativeTitle: 'Claude',
    nativeDescription: 'Claude’s own models.',
    connectionDescription: 'Shown in every agent that can run it.',
    defaultRef: null,
};

function pageRows(): readonly CapturedPageRow[] {
    return (legendListState.data ?? []) as readonly CapturedPageRow[];
}

async function renderPage() {
    legendListState.data = null;
    await renderScreen(
        <ProviderModelManager
            scope={{ kind: 'agent', agentTargetKey: 'agent:happier.agent.claude/claude' }}
            nativeModels={[{ id: 'opus', name: 'Opus', hidden: false }]}
            groups={groups}
            showHidden
            grouping={grouping}
            onSetVisibility={() => {}}
            onShowAll={() => {}}
            onHideAll={() => {}}
            onRequestClose={() => {}}
            page={{ header: <></>, title: '' }}
        />,
    );
    const controls = pageRows().find((row) => row.key === 'models:controls');
    if (!controls) throw new Error('Expected the Models controls row');
    return renderScreen(controls.render());
}

function connectionGroups(modelCount: number) {
    const [base] = groups;
    return [{
        ...base!,
        rows: Array.from({ length: modelCount }, (_, index) => ({
            ...base!.rows[0]!,
            ref: { modelId: `m${index}` },
            descriptor: { id: `m${index}`, name: `Model ${index}` },
        })),
    }];
}

async function renderConnectionPage(modelCount: number) {
    legendListState.data = null;
    await renderScreen(
        <ProviderModelManager
            scope={{ kind: 'connection', connectionId }}
            nativeModels={[]}
            groups={connectionGroups(modelCount)}
            showHidden={false}
            onSetVisibility={() => {}}
            onHideAll={() => {}}
            onRequestClose={() => {}}
            headerActions={React.createElement('ConnectionListAction', { testID: 'connection-list-action' })}
            page={{ header: <></>, title: '', summary: `${modelCount} models` }}
        />,
    );
    const row = (key: string) => {
        const found = pageRows().find((candidate) => candidate.key === key);
        if (!found) throw new Error(`Expected the ${key} row`);
        return renderScreen(found.render());
    };
    return { controls: await row('models:controls'), summary: await row('models:summary') };
}

describe('ProviderModelManagerPage', () => {
    it('retains an off-source sheet when there are no native or listed Provider models', async () => {
        legendListState.data = null;
        await renderScreen(
            <ProviderModelManager
                scope={{ kind: 'agent', agentTargetKey: 'agent:happier.agent.claude/claude' }}
                nativeModels={[]}
                groups={groups}
                showHidden={false}
                grouping={{ ...grouping, isSourceShown: () => false }}
                onSetVisibility={() => {}}
                onRequestClose={() => {}}
                page={{ header: <></>, title: '' }}
            />,
        );
        const source = pageRows().find(row => row.key === `models:source:source:${connectionId}`);
        expect(source).toBeDefined();
        const header = await renderScreen(source!.render());
        expect(header.getTextContent()).toContain('Custom · Work');
        expect(pageRows().map(row => row.key)).not.toContain('models:empty');
    });

    it('keeps a short connection list free of a filter toolbar: its actions sit with the summary line', async () => {
        const { controls, summary } = await renderConnectionPage(2);

        expect(controls.findByTestId('provider-model-manager.filter')).toBeNull();
        expect(controls.findByTestId('connection-list-action')).toBeNull();
        expect(summary.findByTestId('connection-list-action')).not.toBeNull();
        expect(summary.findByTestId('provider-model-manager.menu.trigger')).not.toBeNull();
    });

    it('offers the filter once a connection list is longer than a page segment', async () => {
        const { controls } = await renderConnectionPage(MODEL_ROWS_PER_SEGMENT + 1);

        expect(controls.findByTestId('provider-model-manager.filter')).not.toBeNull();
        expect(controls.findByTestId('connection-list-action')).not.toBeNull();
    });

    it('carries no filter or toolbar on a grouped agent page: its bulk operations live in the page header', async () => {
        const controls = await renderPage();

        expect(pageRows().map((row) => row.key)).not.toContain('models:summary');
        expect(controls.findByTestId('provider-model-manager.filter')).toBeNull();
        expect(controls.findByTestId('provider-model-manager.show-all')).toBeNull();
        expect(controls.findByTestId('provider-model-manager.menu.trigger')).toBeNull();
    });

    it('explains the three row controls once, above the source sheets of an agent list', async () => {
        const controls = await renderPage();

        expect(controls.findByTestId('provider-model-manager.legend')).not.toBeNull();
    });
});
