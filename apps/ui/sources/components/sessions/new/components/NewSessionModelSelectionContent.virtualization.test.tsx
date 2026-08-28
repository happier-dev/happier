import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema, type SessionModelSelectionV1 } from '@happier-dev/protocol';

import {
    createCapturingLegendListMock,
    createResolvedAgentCatalogEntryFixture,
    renderScreen,
    withPopoverWebGlobals,
} from '@/dev/testkit';
import type { SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    renderItemLimit: 12,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

const CONNECTION_ID = ProviderConnectionIdSchema.parse('pc_large_catalog');
const TARGET_KEY = 'backend:codex';
const CODEX_BACKEND_ENTRY: ResolvedBackendCatalogEntry = {
    agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'codex' }),
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    backendTargetKey: TARGET_KEY,
    kind: 'builtInAgent',
    backendId: 'codex',
    agentId: 'codex',
    catalogAgentId: 'codex',
    builtInAgentId: 'codex',
    iconAgentId: 'codex',
    title: 'Codex',
    subtitle: 'Codex',
    cliAuthBackgroundCheckSafe: false,
};

function providerGroup(count: number): SessionModelProjectionGroup {
    return {
        connectionId: CONNECTION_ID,
        providerName: 'Large catalog',
        connectionName: 'Work',
        connectionRole: 'named',
        connectionDisplayNameMode: 'custom',
        connectionRevision: 1,
        authorization: { authorized: true },
        manualModelPolicy: 'catalog-only',
        supportsFreeformModelIds: false,
        suppressedConnectedServiceIds: [],
        modelLoadAction: 'descriptor_absent',
        rows: Array.from({ length: count }, (_, index) => {
            const modelId = `provider-model-${String(index).padStart(4, '0')}`;
            return {
                ref: {
                    agentTargetKey: TARGET_KEY,
                    providerConnectionId: CONNECTION_ID,
                    modelId,
                },
                descriptor: { id: modelId, name: `Provider model ${String(index).padStart(4, '0')}` },
                sources: { manual: false, static: false, probe: true },
                confidence: 'probe',
                compatibility: {
                    result: {
                        status: 'verified',
                        selectedProtocol: 'openai-responses',
                        evidence: {
                            sourceUrls: ['https://example.test/models'],
                            verifiedAt: '2026-07-26',
                        },
                    },
                    compatibilityFingerprint: `compatibility:v1:${modelId}`,
                    confirmed: true,
                },
                endpointHealth: 'available',
                catalog: { stale: false },
                loadState: 'loaded',
                visibility: 'visible',
            };
        }),
    } as SessionModelProjectionGroup;
}

function LargeCatalogHarness(props: Readonly<{ count: number }>) {
    const [selection, setSelection] = React.useState<SessionModelSelectionV1 | null>(null);
    return (
        <>
            <NewSessionModelSelectionContent
                presentation="compact"
                providerProjectionAuthoritative
                modelOptions={[]}
                selectedModelId={selection?.ref.modelId ?? 'default'}
                selectedModelSelection={selection}
                selectedIndicatorColor="#fff"
                selectedBackendEntry={CODEX_BACKEND_ENTRY}
                providerGroups={[providerGroup(props.count)]}
                onSelectModel={() => {}}
                onSelectSelection={(ref) => {
                    setSelection(ref ? { v: 1, updatedAt: 123, ref } : null);
                }}
            />
            <React.Fragment>
                {selection ? sessionModelSelectionKey(selection.ref) : 'no-selection'}
            </React.Fragment>
        </>
    );
}

const { NewSessionModelSelectionContent } = await import('./NewSessionModelSelectionContent');

describe('NewSessionModelSelectionContent canonical virtualized renderer', () => {
    it('opens the real compact picker, searches and selects an exact Provider ref, then reopens with cleared search and retained selection', async () => {
        await withPopoverWebGlobals(async () => {
            legendListState.reset();
            const screen = await renderScreen(<LargeCatalogHarness count={5_000} />);

            await screen.pressByTestIdAsync('new-session-model-dropdown-trigger');

            expect(screen.findByTestId('model-picker-overlay-selection-list')).toBeTruthy();
            expect(legendListState.props?.data).toHaveLength(5_000);
            expect(screen.tree.root.findAllByType('LegendListItem')).toHaveLength(12);

            act(() => screen.changeTextByTestId('model-picker-overlay-search', 'Provider model 0007'));
            await screen.pressByTestIdAsync(`model-picker-overlay-option:${JSON.stringify([
                TARGET_KEY,
                CONNECTION_ID,
                'provider-model-0007',
            ])}`);

            expect(screen.getTextContent()).toContain(JSON.stringify([
                TARGET_KEY,
                CONNECTION_ID,
                'provider-model-0007',
            ]));
            expect(screen.findByTestId('model-picker-overlay-selection-list')).toBeNull();

            await screen.pressByTestIdAsync('new-session-model-dropdown-trigger');

            expect(legendListState.props?.data).toHaveLength(5_000);
            expect(screen.findByTestId(
                `model-picker-overlay-option-selected-indicator:${JSON.stringify([
                    TARGET_KEY,
                    CONNECTION_ID,
                    'provider-model-0007',
                ])}`,
            )).toBeTruthy();

            act(() => screen.changeTextByTestId('model-picker-overlay-search', 'Provider model 0007'));
            act(() => screen.changeTextByTestId('model-picker-overlay-search', ''));
            expect(legendListState.props?.data).toHaveLength(5_000);
        });
    });
});
