import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let lastOptionPickerOverlayProps: any = null;

installNewSessionComponentsCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
    }),
    text: () => createTextModuleMock({ translate: (key) => key }),
    unistyles: () => createUnistylesMock(),
});

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: any) => {
        lastOptionPickerOverlayProps = props;
        return React.createElement('OptionPickerOverlay', props);
    },
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getAgentCore: () => ({
            model: {
                dynamicProbe: 'dynamic',
            },
        }),
    };
});

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        preflightModels: {
            availableModels: [],
            supportsFreeform: false,
        },
        probe: { phase: 'idle' },
    }),
}));

describe('NewSessionFavoriteModelsDetail', () => {
    beforeEach(() => {
        lastOptionPickerOverlayProps = null;
    });

    it('renders stale favorite models with a remove affordance instead of dropping the pane', async () => {
        const onRemoveFavoriteModelSelection = vi.fn();
        const favorite = {
            backendTargetKey: 'agent:claude',
            providerAgentId: 'claude',
            builtInAgentId: 'claude',
            backendLabel: 'Claude',
            modelId: 'retired-model',
            modelLabel: 'Retired model',
        };
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favorite]}
            resolvedBackendEntries={[
                {
                    backendTarget: { kind: 'backend', backendId: 'claude' },
                    backendTargetKey: 'agent:claude',
                    title: 'Claude',
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                } as any,
            ]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={{} as any}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={onRemoveFavoriteModelSelection}
        />);

        expect(lastOptionPickerOverlayProps?.options).toEqual([
            {
                value: 'retired-model',
                label: 'Retired model',
                description: 'agentInput.model.configureInCli',
            },
        ]);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.values.has('retired-model')).toBe(true);

        lastOptionPickerOverlayProps?.favoriteOptions?.onToggle(lastOptionPickerOverlayProps.options[0]);

        expect(onRemoveFavoriteModelSelection).toHaveBeenCalledWith(favorite);
    });
});
