import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
} from '@/__tests__/routes/(app)/settings/sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn());

installSessionSettingsEntryModuleMocks({
    modalModule: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
    },
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/settings/mcpServers/McpValueRefMapEditor', () => ({
    McpValueRefMapEditor: (props: Record<string, unknown>) => React.createElement('McpValueRefMapEditor', props),
}));

afterEach(() => {
    modalAlertSpy.mockReset();
    resetSessionSettingsEntryState();
    standardCleanup();
});

describe('AcpBackendEditorScreen', () => {
    it('keeps invalid descriptor save feedback visible and announced on the screen', async () => {
        const { AcpBackendEditorScreen } = await import('./AcpBackendEditorScreen');
        const screen = await renderSettingsView(React.createElement(AcpBackendEditorScreen));

        await screen.pressByTestIdAsync('settings.acpCatalog.backendEditor.save');

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'settings.acpCatalogValidationFailed');
        const validationError = screen.findByTestId('settings.acpCatalog.backendEditor.validationError');
        expect(validationError?.props.children).toBe('settings.acpCatalogValidationFailed');
        expect(validationError?.props.accessibilityRole).toBe('alert');
        expect(validationError?.props.accessibilityLiveRegion).toBe('polite');
    });
});
