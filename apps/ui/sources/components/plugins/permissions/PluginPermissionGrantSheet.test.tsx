import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

type SheetModule = Readonly<{
    PluginPermissionGrantSheet: React.ComponentType<{
        pendingRequest: unknown;
        labels: {
            title: string;
            body: (params: Readonly<{ pluginName: string; pluginId: string }>) => string;
            grant: string;
            dismiss: string;
        };
        onGrant: (input: Readonly<{ requestId: string }>) => void;
        onDismiss: (input: Readonly<{ requestId: string }>) => void;
        testID?: string;
    }>;
}>;

async function loadSheet(): Promise<SheetModule | null> {
    try {
        return await import('./PluginPermissionGrantSheet') as unknown as SheetModule;
    } catch {
        return null;
    }
}

describe('PluginPermissionGrantSheet', () => {
    it('renders trusted request identity and waits for explicit grant action', async () => {
        const mod = await loadSheet();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const onGrant = vi.fn();
        const onDismiss = vi.fn();
        const screen = await renderScreen(
            <mod.PluginPermissionGrantSheet
                pendingRequest={{
                    id: 'request-1',
                    pluginId: 'review-coderabbit',
                    pluginName: 'CodeRabbit',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
                    reason: 'Write approved review comments without another prompt.',
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }}
                labels={{
                    title: 'Plugin permission request',
                    body: ({ pluginName, pluginId }) => `${pluginName} (${pluginId}) requested a permission.`,
                    grant: 'Grant permission',
                    dismiss: 'Dismiss request',
                }}
                onGrant={onGrant}
                onDismiss={onDismiss}
                testID="plugin-grant"
            />,
        );

        expect(screen.getTextContent()).toContain('CodeRabbit');
        expect(screen.getTextContent()).toContain('review-coderabbit');
        expect(screen.getTextContent()).toContain('reviews.comments.write.direct');
        expect(screen.getTextContent()).toContain('workspace:workspace-1');
        expect(screen.getTextContent()).toContain('Write approved review comments without another prompt.');
        expect(onGrant).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();

        await pressTestInstanceAsync(screen.findByTestId('plugin-grant-grant'), 'plugin-grant-grant');
        expect(onGrant).toHaveBeenCalledWith({ requestId: 'request-1' });

        await pressTestInstanceAsync(screen.findByTestId('plugin-grant-dismiss'), 'plugin-grant-dismiss');
        expect(onDismiss).toHaveBeenCalledWith({ requestId: 'request-1' });
    });
});
