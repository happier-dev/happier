// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, AccountApiTokenSummaryV1Schema } from '@happier-dev/protocol';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { CustomModal } from '@/modal/components/CustomModal';
import { ApiTokenCreateModal } from './ApiTokenCreateModal';
import { createApiTokenSettingsController } from './apiTokenSettingsController';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
    // The native animation SDK is a boundary, but its host views must retain
    // real RNW layout instead of the renderer testkit's symbolic element names.
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, ScrollView, Text } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const mock = createReanimatedModuleMock();
    const animated = { ...mock.default, View, ScrollView, Text };
    return { ...mock, ...animated, default: animated };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

describe('API token modal browser layout', () => {
    it.each([
        { width: 390, height: 844, mode: 'create' as const },
        { width: 1440, height: 1000, mode: 'create' as const },
        { width: 390, height: 844, mode: 'editAccess' as const },
        { width: 1440, height: 1000, mode: 'editAccess' as const },
    ])('keeps $mode actions visible and its form within a $width-pixel viewport', async (viewport) => {
        // The browser viewport is a platform boundary. Let real RNW Dimensions
        // observe its DOM inputs and resize event rather than replacing its logic.
        const viewportProperties = [
            { target: document.documentElement, key: 'clientWidth', value: viewport.width },
            { target: document.documentElement, key: 'clientHeight', value: viewport.height },
            { target: window.screen, key: 'width', value: viewport.width },
            { target: window.screen, key: 'height', value: viewport.height },
        ];
        const previousDescriptors = viewportProperties.map(({ target, key }) => Object.getOwnPropertyDescriptor(target, key));
        for (const { target, key, value } of viewportProperties) Object.defineProperty(target, key, { configurable: true, value });
        window.dispatchEvent(new Event('resize'));
        const token = AccountApiTokenSummaryV1Schema.parse({
            tokenId: '11111111-1111-4111-8111-111111111111',
            label: 'Leads dashboard', displayPrefix: 'hap_v1_11111111',
            createdAt: '2026-08-20T12:00:00.000Z', lastUsedAt: null, expiresAt: null,
            hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
            grant: API_TOKEN_FULL_GRANT_V1, parentTokenId: null, activeChildCount: 2, embedConfig: null,
        });
        const controller = createApiTokenSettingsController({
            // Action transport and Account lifetime are system boundaries. Only the read is admitted.
            execute: async (actionId) => actionId === 'account.apiTokens.list'
                ? { ok: true, result: { tokens: [token] } }
                : { ok: false, errorCode: 'unsupported' },
            captureActiveAccountScopeLifetime: () => ({
                scope: { serverId: 'home-a', accountId: 'account-a' },
                isCurrent: () => true,
                onRetire: () => ({ dispose() {} }),
            }),
            now: () => 0,
        });
        controller.setCreateDraft({ label: 'Leads dashboard', access: 'limited', expiryPreset: '30d' });
        if (viewport.mode === 'editAccess') {
            await controller.refresh();
            expect(controller.beginAccessEdit(token.tokenId)).toBe(true);
        }
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        try {
            await act(async () => root.render(<CustomModal
                config={{ id: 'token-modal', type: 'custom', component: ApiTokenCreateModal, props: { controller, mode: viewport.mode } }}
                onClose={() => {}}
                visible
            />));
            const layout = await measureWebLayout(document.body, { viewport });
            const edit = viewport.mode === 'editAccess';
            const card = layout.rect(edit ? 'settings-api-tokens-edit-modal' : 'settings-api-tokens-create-modal');
            const footer = layout.rect('modal-card-footer');
            const action = layout.rect(edit ? 'settings-api-tokens-edit-save' : 'settings-api-tokens-create-continue');
            expect(card.left).toBeGreaterThanOrEqual(0);
            expect(card.right).toBeLessThanOrEqual(viewport.width);
            expect(card.bottom).toBeLessThanOrEqual(viewport.height);
            expect(footer.bottom).toBeLessThanOrEqual(viewport.height);
            expect(footer.bottom).toBeLessThanOrEqual(card.bottom);
            expect(action.height).toBeGreaterThan(0);
            expect(action.top).toBeGreaterThanOrEqual(footer.top);
            expect(action.bottom).toBeLessThanOrEqual(footer.bottom);
            if (viewport.width === 390) {
                // Both phone tasks use the canonical edge-to-edge sheet and retain their field width.
                expect(card.left).toBe(0);
                expect(card.width).toBe(viewport.width);
                expect(layout.rect(edit ? 'settings-api-tokens-edit-editor' : 'settings-api-tokens-create-label').right).toBeLessThanOrEqual(card.right);
            } else {
                expect(card.width).toBe(600);
            }
        } finally {
            await act(async () => root.unmount());
            host.remove();
            controller.retire();
            viewportProperties.forEach(({ target, key }, index) => {
                const descriptor = previousDescriptors[index];
                if (descriptor) Object.defineProperty(target, key, descriptor);
                else Reflect.deleteProperty(target, key);
            });
            window.dispatchEvent(new Event('resize'));
        }
    });
});
