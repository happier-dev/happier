import * as React from 'react';
import { act } from 'react-test-renderer';
import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDraftAcpBackend } from './createDraftAcpBackend';
import { renderScreen } from '@/dev/testkit';
import { installAcpCatalogSettingsCommonModuleMocks } from './acpCatalogSettingsTestHelpers';

const state = vi.hoisted(() => ({
    settings: { v: 2, backends: [] } as AcpCatalogSettingsV1,
    backendId: undefined as string | undefined,
    setSettings: vi.fn<(settings: AcpCatalogSettingsV1) => void>(),
}));

installAcpCatalogSettingsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => ({ backendId: state.backendId }) }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: (key: string) => {
                if (key === 'acpCatalogSettingsV1') return [state.settings, state.setSettings];
                if (key === 'secrets') return [[], vi.fn()];
                return [null, vi.fn()];
            },
        });
    },
});

describe('AcpBackendEditorScreen', () => {
    beforeEach(() => {
        state.settings = { v: 2, backends: [] };
        state.backendId = undefined;
        state.setSettings.mockReset();
    });

    it.each([false, true])('saves the edited resume declaration for a backend initially set to %s', async (initialSupport) => {
        const backend = {
            ...createDraftAcpBackend(),
            id: 'resumable-agent',
            name: 'resumable-agent',
            title: 'Resumable agent',
            command: 'acp-agent',
        };
        backend.capabilities.supportsLoadSession = initialSupport;
        if (initialSupport) {
            state.settings = { v: 2, backends: [backend] };
            state.backendId = backend.id;
        }
        const { AcpBackendEditorScreen } = await import('./AcpBackendEditorScreen');
        const screen = await renderScreen(React.createElement(AcpBackendEditorScreen));
        if (!initialSupport) {
            await act(async () => {
                screen.changeTextByTestId('settings.acpCatalog.backendEditor.id', backend.id);
                screen.changeTextByTestId('settings.acpCatalog.backendEditor.name', backend.name);
                screen.changeTextByTestId('settings.acpCatalog.backendEditor.title', backend.title);
                screen.changeTextByTestId('settings.acpCatalog.backendEditor.command', backend.command);
            });
        }
        const toggleId = 'settings.acpCatalog.backendEditor.supportsLoadSession';
        const toggle = screen.findByTestId(toggleId);
        expect(toggle).not.toBeNull();
        expect(toggle?.props.value).toBe(initialSupport);
        await act(async () => {
            toggle?.props.onValueChange(!initialSupport);
        });
        expect(screen.findByTestId(toggleId)?.props.value).toBe(!initialSupport);
        await screen.pressByTestIdAsync('settings.acpCatalog.backendEditor.save');
        const saved = state.setSettings.mock.lastCall?.[0];
        expect(saved?.backends).toHaveLength(1);
        expect(saved?.backends[0].capabilities).toEqual({
            ...backend.capabilities,
            supportsLoadSession: !initialSupport,
        });
    });
});
