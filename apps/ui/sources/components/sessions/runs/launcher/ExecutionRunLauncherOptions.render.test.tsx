import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/components/ui/text/Text', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});
vi.mock('@/components/sessions/actions/ActionInputFields', async () => {
    const ReactModule = await import('react');
    return {
        ActionInputFields: () => ReactModule.createElement('ActionInputFields'),
        getValueAtPath: () => undefined,
    };
});

const backendChoices = [{
    backendTarget: { kind: 'backend', backendId: 'codex' },
    targetKey: 'agent:codex',
    backendId: 'codex',
    agentId: 'codex',
    title: 'Codex',
    disabled: false,
}] as any;

const permissionModeOptions = [
    { value: 'read-only', label: 'Read-only' },
    { value: 'default', label: 'Default' },
] as any;

async function renderOptions(choices: readonly unknown[] = backendChoices) {
    const { ExecutionRunLauncherOptions } = await import('./ExecutionRunLauncherOptions');
    return renderScreen(React.createElement(ExecutionRunLauncherOptions, {
        backendChoices: choices as any,
        machineName: 'Build box',
        selectedBackendTargetKeys: ['agent:codex'],
        profileChoices: [],
        selectedProfileId: '',
        selectedPermissionMode: 'read-only',
        permissionModeOptions,
        fields: [],
        input: {},
        editable: true,
        resolveFieldOptions: () => [],
        onSelectBackend: vi.fn(),
        onSelectProfile: vi.fn(),
        onPatch: vi.fn(),
    }));
}

describe('ExecutionRunLauncherOptions', () => {
    // The agent tile is drawn at its own padded size under every pointer; a finger's target is the
    // shared pressable's hit area, never a drawn minimum.
    it('draws backend tiles without a minimum target size', async () => {
        const screen = await renderOptions();

        const style = flattenTestStyle(screen.findByTestId('execution-run-launcher-target:agent:codex')?.props.style);
        expect(style.minWidth).toBeUndefined();
        expect(style.minHeight).toBeUndefined();
        standardCleanup();
    });

    it('reports the selected backend and permission mode through accessibility state', async () => {
        const screen = await renderOptions();

        expect(screen.findByTestId('execution-run-launcher-target:agent:codex')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('execution-run-launcher-permission-mode:read-only')?.props.accessibilityState)
            .toMatchObject({ checked: true });
        expect(screen.findByTestId('execution-run-launcher-permission-mode:default')?.props.accessibilityState)
            .toMatchObject({ checked: false });
        standardCleanup();
    });

    it('names an Agent the Machine does not have under the "not on this Machine yet" heading, after the ones it has', async () => {
        const screen = await renderOptions([
            { ...backendChoices[0] },
            { backendTarget: { kind: 'backend', backendId: 'opencode' }, targetKey: 'agent:opencode', backendId: 'opencode', agentId: 'opencode', title: 'OpenCode', disabled: true, unavailable: 'notOnMachine' },
        ]);
        const text = screen.getTextContent();
        expect(text.match(/machineAgents\.notOnMachineYet/g)).toHaveLength(1);
        expect(text.indexOf('Codex')).toBeLessThan(text.indexOf('machineAgents.notOnMachineYet'));
        expect(text.indexOf('machineAgents.notOnMachineYet')).toBeLessThan(text.indexOf('OpenCode'));
        expect(screen.findByTestId('execution-run-launcher-target:agent:opencode')?.props.accessibilityState).toMatchObject({ disabled: true });
        standardCleanup();
    });
});
