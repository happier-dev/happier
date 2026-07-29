import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { AgentInputChipPickerSurface } from '@/components/sessions/agentInput/components/AgentInputChipPickerSurface';
import { OptionPickerOverlay } from '@/components/sessions/pickers/OptionPickerOverlay';

function createModelOptions(count: number) {
    return Array.from({ length: count }, (_, index) => {
        const position = String(index + 1).padStart(5, '0');
        return {
            value: `q24-model-${position}`,
            label: `Q24 Catalog Model ${position}`,
        };
    });
}

const NEIGHBOR_OPTIONS = Array.from({ length: 7 }, (_, index) => ({
    value: `native-model-${index + 1}`,
    label: `Native Model ${index + 1}`,
}));

export default function SelectionListLargeCatalogScreen(): React.ReactElement {
    const params = useLocalSearchParams<{ count?: string | string[] }>();
    const countParam = Array.isArray(params.count) ? params.count[0] : params.count;
    const catalogSize = countParam === '5000' ? 5000 : countParam === '500' ? 500 : 100;
    const modelOptions = React.useMemo(() => createModelOptions(catalogSize), [catalogSize]);
    const [selectedModel, setSelectedModel] = React.useState(NEIGHBOR_OPTIONS[0]?.value ?? '');
    return (
        <View
            testID="selection-list-large-catalog-fixture"
            style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
            }}
        >
            <View style={{ width: 900, maxWidth: '100%' }}>
                <AgentInputChipPickerSurface
                    detailContentOwnsScroll
                    title="Agent"
                    options={[{
                        id: 'codex',
                        label: 'Codex',
                        detailTitle: 'Codex',
                        renderDetailContent: () => (
                            <OptionPickerOverlay
                                fillAvailableSpace
                                title="Model"
                                options={[]}
                                sections={[
                                    {
                                        id: 'native',
                                        title: 'Native',
                                        options: NEIGHBOR_OPTIONS,
                                    },
                                    {
                                        id: 'provider',
                                        title: 'Provider',
                                        options: modelOptions,
                                    },
                                    {
                                        id: 'other',
                                        title: 'Other',
                                        options: [{
                                            value: 'other-model',
                                            label: 'Other Model',
                                        }],
                                    },
                                ]}
                                selectedValue={selectedModel}
                                emptyText="No models"
                                canEnterCustomValue={false}
                                onSelect={setSelectedModel}
                            />
                        ),
                    }]}
                    selectedOptionId="codex"
                    onSelect={() => {}}
                    onRequestClose={() => {}}
                    maxHeight={520}
                    testID="selection-list-large-catalog-surface"
                />
            </View>
        </View>
    );
}
