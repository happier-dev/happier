import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
        });
    },
});

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Readonly<Record<string, unknown>>) => React.createElement('Switch', props),
}));

describe('PluginInstallationReviewDialog', () => {
    it('paints a visible keyboard focus ring on the install decision controls on web', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                body="Review the plugin before installation."
                target={{ machine: 'Laptop', server: 'Server A' }}
                optionalHostAccess={[]}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        for (const testID of [
            'settings.plugins.installReview.cancel',
            'settings.plugins.installReview.confirm',
        ]) {
            const control = screen.findByTestId(testID);
            expect(control?.props.style({ pressed: false, focused: true })).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    outlineStyle: 'solid',
                    outlineWidth: expect.any(Number),
                    outlineColor: expect.any(String),
                }),
            ]));
        }
    });

    it('keeps optional access and decision controls at least 48dp on Android', async () => {
        platformEnvironment.platform = 'android';
        try {
            const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
            const screen = await renderScreen(
                <PluginInstallationReviewDialog
                    body="Review the plugin before installation."
                    target={{ machine: 'Laptop', server: 'Server A' }}
                    optionalHostAccess={[{
                        id: 'workspace',
                        capability: 'Workspace files',
                        reason: 'Read the selected workspace.',
                        authorizationClass: 'hostResourceSelection',
                        normalizedScope: { kind: 'workspace' },
                    }]}
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />,
            );

            const optional = screen.findByTestId('settings.plugins.installReview.optional.workspace');
            expect(optional?.props.style).toEqual(expect.arrayContaining([
                expect.objectContaining({ minWidth: 48, minHeight: 48 }),
            ]));
            for (const testID of [
                'settings.plugins.installReview.cancel',
                'settings.plugins.installReview.confirm',
            ]) {
                const control = screen.findByTestId(testID);
                expect(control?.props.style({ pressed: false })).toEqual(expect.arrayContaining([
                    expect.objectContaining({ minHeight: 48 }),
                ]));
            }
        } finally {
            platformEnvironment.platform = 'web';
        }
    });

    it('names the exact machine and server the install-and-trust decision lands on', async () => {
        const { PluginInstallationReviewDialog } = await import('./PluginInstallationReviewDialog');
        const screen = await renderScreen(
            <PluginInstallationReviewDialog
                body="Review the plugin before installation."
                target={{ machine: 'Build box', server: 'Server B' }}
                optionalHostAccess={[]}
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        // Trust is granted on ONE machine reached through ONE server, so the
        // review must carry that target and not just the package review body.
        expect(screen.findByTestId('settings.plugins.installReview.target')?.props.children)
            .toBe(`settingsPlugins.pluginChangeConfirmTarget:${JSON.stringify({
                machine: 'Build box',
                server: 'Server B',
            })}`);
    });
});
