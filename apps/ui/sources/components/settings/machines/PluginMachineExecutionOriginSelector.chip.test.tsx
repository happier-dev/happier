import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { composePluginMachineExecutionOriginV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginCandidateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { PluginMachineExecutionOriginSelectionV1 } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

import { installNewSessionComponentsCommonModuleMocks } from '../../sessions/new/components/newSessionComponentsTestHelpers';

installNewSessionComponentsCommonModuleMocks({
    storage: (importOriginal) => importOriginal(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

function createSelection() {
    const candidates: readonly PluginMachineExecutionOriginCandidateV1[] = [
        {
            materialization: {
                serverIdentityId: 'home-one', machineId: 'machine-a', materializationId: 'installation-a',
                pluginId: 'acme.plugin', version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 100,
            },
            releaseContent: 'matched', validation: { kind: 'admitted' },
        },
        {
            materialization: {
                serverIdentityId: 'home-one', machineId: 'machine-b', materializationId: 'installation-b',
                pluginId: 'acme.plugin', version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 100,
            },
            releaseContent: 'matched', validation: { kind: 'rejected', reason: 'offline' },
        },
    ];
    const selectOrigin = vi.fn(async () => ({ status: 'applied' as const, settingsVersion: 8, value: undefined }));
    const selection: PluginMachineExecutionOriginSelectionV1 = {
        candidates,
        state: { kind: 'selectionRequired', candidates },
        selectedOrigin: null,
        canExecute: false,
        selectOrigin,
        clearOrigin: async () => ({ status: 'applied', settingsVersion: 8, value: undefined }),
        resolveExecutionOrigin: () => null,
    };
    return { selection, candidates, selectOrigin };
}

describe('PluginMachineExecutionOriginSelector header chip', () => {
    it('opens the shared machine list and submits the exact installation while rejecting offline choices', () => withPopoverWebGlobals(async () => {
        const { PluginMachineExecutionOriginSelectorView } = await import('./PluginMachineExecutionOriginSelector');
        const fixture = createSelection();
        const screen = await renderScreen(<PluginMachineExecutionOriginSelectorView
            selection={fixture.selection}
            presentation="chip"
            testIDPrefix="plugin.execution"
        />);
        expect(screen.findHostByTestId('plugin.execution.chip')).not.toBeNull();
        expect(screen.findHostByTestId('plugin.execution.picker-list')).toBeNull();
        await screen.pressByTestIdAsync('plugin.execution.chip');
        expect(screen.findHostByTestId('plugin.execution.picker-list')).not.toBeNull();
        const offline = screen.findHostByTestId('plugin.execution.picker-option:machine-b');
        expect(offline?.props.disabled ?? offline?.props.accessibilityState?.disabled ?? offline?.props['aria-disabled']).toBe(true);
        await screen.pressByTestIdAsync('plugin.execution.picker-option:machine-a');
        expect(fixture.selectOrigin).toHaveBeenCalledWith(composePluginMachineExecutionOriginV1(fixture.candidates[0]!.materialization));
        const chip = screen.findHostByTestId('plugin.execution.chip');
        expect(chip?.props.accessibilityState?.expanded ?? chip?.props['aria-expanded']).toBe(false);
    }));
});
