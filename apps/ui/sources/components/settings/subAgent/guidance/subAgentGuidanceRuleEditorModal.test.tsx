import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            TextInput: 'TextInput',
            Text: 'Text',
            Platform: {
                OS: 'web',
                select: (opt: any) => opt?.default,
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => [],
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [
        {
            backendTarget: { kind: 'backend', backendId: 'claude' },
            backendTargetKey: 'backend:claude',
            kind: 'builtInAgent',
            backendId: 'claude',
            providerId: 'claude',
            catalogAgentId: 'claude',
            builtInAgentId: 'claude',
            iconAgentId: 'claude',
            title: 'Claude',
            subtitle: 'claude',
        },
        {
            backendTarget: { kind: 'backend', backendId: 'custom-preset', configuredBackendId: 'custom-preset' },
            backendTargetKey: 'backend:custom-preset:configured:custom-preset',
            kind: 'configuredBackend',
            backendId: 'custom-preset',
            providerId: 'custom-preset',
            catalogAgentId: null,
            builtInAgentId: null,
            iconAgentId: null,
            title: 'Custom Review Bot',
            subtitle: 'Custom ACP',
        },
    ],
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    getAgentCore: () => ({ displayNameKey: 'agent.claude' }),
    isAgentId: () => true,
    DEFAULT_AGENT_ID: 'claude',
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: vi.fn(() => ({
        preflightModels: null,
        modelOptions: [{ value: 'model1', label: 'Model 1', description: 'Default' }],
        probe: { phase: 'idle', refreshedAt: null, refresh: () => {} },
    })),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
    useLocalSetting: () => 1,
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
}));

function SubAgentGuidanceRuleEditorModalHarness(
    props: React.ComponentProps<typeof import('./subAgentGuidanceRuleEditorModal').SubAgentGuidanceRuleEditorModal> & Readonly<{
        component: React.ComponentType<any>;
    }>,
) {
    const [chrome, setChrome] = React.useState<any>(null);
    const card = chrome && chrome.kind === 'card' ? chrome : null;

    return (
        <ModalCardFrame
            leading={card?.leading}
            title={card?.title}
            subtitle={card?.subtitle}
            actions={card?.actions}
            footer={card?.footer}
            dimensions={card?.dimensions}
	        >
	            <props.component {...props} setChrome={setChrome} />
	        </ModalCardFrame>
	    );
	}

describe('SubAgentGuidanceRuleEditorModal', () => {
    it('disables Save when description is empty', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const { SubAgentGuidanceRuleEditorModal } = await import('./subAgentGuidanceRuleEditorModal');

        const screen = await renderScreen(
            <SubAgentGuidanceRuleEditorModalHarness
                component={SubAgentGuidanceRuleEditorModal as any}
                mode="create"
                entry={{ id: 'guidance_1', description: '', enabled: true }}
                onResolve={onResolve}
                onClose={onClose}
            />,
        );
        const saveButton = findTestInstanceByTypeWithProps(screen.tree, 'RoundButton', { title: 'common.save' });

        expect(saveButton).toBeTruthy();
        expect(saveButton?.props.disabled).toBe(true);

        await pressTestInstanceAsync(saveButton, 'common.save');

        expect(onResolve).not.toHaveBeenCalled();
    });

    it('calls onResolve(save) when description is present', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const { SubAgentGuidanceRuleEditorModal } = await import('./subAgentGuidanceRuleEditorModal');

        const screen = await renderScreen(
            <SubAgentGuidanceRuleEditorModalHarness
                component={SubAgentGuidanceRuleEditorModal as any}
                mode="create"
                entry={{
                    id: 'guidance_2',
                    description: 'Delegate UI tasks',
                    enabled: true,
                    suggestedBackendTarget: { kind: 'backend', backendId: 'claude' },
                }}
                onResolve={onResolve}
                onClose={onClose}
            />,
        );
        const saveButton = findTestInstanceByTypeWithProps(screen.tree, 'RoundButton', { title: 'common.save' });

        expect(saveButton).toBeTruthy();
        expect(saveButton?.props.disabled).toBe(false);

        await pressTestInstanceAsync(saveButton, 'common.save');

        expect(onResolve).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'save',
                entry: expect.objectContaining({
                    id: 'guidance_2',
                    description: 'Delegate UI tasks',
                    suggestedBackendTarget: { kind: 'backend', backendId: 'claude' },
                }),
            }),
        );
    });

    it('preserves a configured ACP backend target and probes models against it', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const { useNewSessionPreflightModelsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState');
        const { SubAgentGuidanceRuleEditorModal } = await import('./subAgentGuidanceRuleEditorModal');

        const screen = await renderScreen(
            <SubAgentGuidanceRuleEditorModalHarness
                component={SubAgentGuidanceRuleEditorModal as any}
                mode="edit"
                entry={{
                    id: 'guidance_3',
                    description: 'Review custom ACP changes',
                    enabled: true,
                    suggestedBackendTarget: { kind: 'backend', backendId: 'custom-preset', configuredBackendId: 'custom-preset' },
                }}
                onResolve={onResolve}
                onClose={onClose}
            />,
        );

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        expect(dropdowns).toHaveLength(3);
        expect(dropdowns[0]!.props.selectedId).toBe('backend:custom-preset:configured:custom-preset');
        expect(dropdowns[1]!.props.selectedId).toBe('');

        expect(useNewSessionPreflightModelsState).toHaveBeenCalledWith(
            expect.objectContaining({
                backendTarget: { kind: 'backend', backendId: 'custom-preset', configuredBackendId: 'custom-preset' },
            }),
        );

        const saveButton = findTestInstanceByTypeWithProps(screen.tree, 'RoundButton', { title: 'common.save' });
        expect(saveButton).toBeTruthy();

        await pressTestInstanceAsync(saveButton, 'common.save');

        expect(onResolve).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'save',
                entry: expect.objectContaining({
                    suggestedBackendTarget: { kind: 'backend', backendId: 'custom-preset', configuredBackendId: 'custom-preset' },
                }),
            }),
        );
    });

    it('does not seed a built-in backend target when no backend is selected', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const { useNewSessionPreflightModelsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState');
        const { SubAgentGuidanceRuleEditorModal } = await import('./subAgentGuidanceRuleEditorModal');

        await renderScreen(
            <SubAgentGuidanceRuleEditorModalHarness
                component={SubAgentGuidanceRuleEditorModal as any}
                mode="create"
                entry={{
                    id: 'guidance_4',
                    description: 'Review session guidance',
                    enabled: true,
                }}
                onResolve={onResolve}
                onClose={onClose}
            />,
        );

        expect(useNewSessionPreflightModelsState).toHaveBeenCalledWith(
            expect.objectContaining({
                backendTarget: null,
                selectedMachineId: null,
            }),
        );
    });
});
