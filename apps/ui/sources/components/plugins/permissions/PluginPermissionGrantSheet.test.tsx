import React from 'react';
import { I18nManager, Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { setPreferredLanguageFromSettings } from '@/text';

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
        detailRows?: readonly Readonly<{ key: string; label?: string; value: string }>[];
        disabled?: boolean;
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
    afterEach(() => {
        setPreferredLanguageFromSettings(null);
        vi.restoreAllMocks();
    });

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
                    requester: { kind: 'plugin', pluginId: 'review-coderabbit', sessionId: 'session-1' },
                    authoritySource: { kind: 'machine_installation', machineId: 'machine-1', installationId: 'installation-1' },
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
        expect(screen.getTextContent()).toContain('workspace-1');
        expect(screen.getTextContent()).toContain('session-1');
        expect(screen.getTextContent()).toContain('machine-1');
        expect(screen.getTextContent()).toContain('installation-1');
        expect(screen.getTextContent()).not.toContain('1970-01-01T00:00:00.001Z');
        expect(screen.getTextContent()).toContain('Write approved review comments without another prompt.');
        expect(onGrant).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();

        await pressTestInstanceAsync(screen.findByTestId('plugin-grant-grant'), 'plugin-grant-grant');
        expect(onGrant).toHaveBeenCalledWith({ requestId: 'request-1' });

        await pressTestInstanceAsync(screen.findByTestId('plugin-grant-dismiss'), 'plugin-grant-dismiss');
        expect(onDismiss).toHaveBeenCalledWith({ requestId: 'request-1' });
        expect(screen.findByTestId('plugin-grant-grant')?.props.style.minHeight).toBe(44);
        expect(screen.findByTestId('plugin-grant-dismiss')?.props.style.minHeight).toBe(44);
    });

    it('renders caller-supplied disclosure facts inside the canonical accessible review summary', async () => {
        const mod = await loadSheet();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const screen = await renderScreen(
            <mod.PluginPermissionGrantSheet
                pendingRequest={{
                    id: 'request-raw-credential',
                    pluginId: 'acme.voice',
                    pluginName: 'Acme Voice',
                    capability: 'credentials.materialize.raw',
                    targetScope: { kind: 'account' },
                    requester: { kind: 'plugin', pluginId: 'acme.voice' },
                    authoritySource: { kind: 'bundled' },
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }}
                labels={{
                    title: 'Raw credential access review',
                    body: ({ pluginName }) => `${pluginName} requests raw credential access.`,
                    grant: 'Allow access',
                    dismiss: 'Not now',
                }}
                detailRows={[
                    { key: 'package', label: 'Package', value: '@acme/voice' },
                    { key: 'publisher', label: 'Publisher', value: 'Unavailable' },
                    { key: 'credential-slot', label: 'Credential slot', value: 'api_key' },
                    {
                        key: 'disclosure-0',
                        label: 'Credential disclosure',
                        value: 'Saved secret · connection · web · authorization @ https://voice.example.test',
                    },
                    { key: 'contribution', value: 'Contribution: acme.voice/conversation' },
                ]}
                onGrant={() => {}}
                onDismiss={() => {}}
                testID="plugin-grant-raw-credential"
            />,
        );

        expect(screen.getTextContent()).toContain('Package: @acme/voice');
        expect(screen.getTextContent()).toContain('Publisher: Unavailable');
        expect(screen.getTextContent()).toContain('Credential slot: api_key');
        expect(screen.getTextContent()).toContain('authorization @ https://voice.example.test');
        const summary = screen.findByTestId('plugin-grant-raw-credential-details')?.props.accessibilityLabel;
        expect(summary).toContain('Package: @acme/voice');
        expect(summary).toContain('Publisher: Unavailable');
        expect(summary).toContain('Credential disclosure: Saved secret');
        expect(summary).toContain('Contribution: acme.voice/conversation');
        expect(summary).not.toContain(': Contribution: acme.voice/conversation');
    });

    it('localizes and accessibly groups long permission facts while preserving exact technical values in RTL', async () => {
        const mod = await loadSheet();
        expect(mod).not.toBeNull();
        if (!mod) return;

        setPreferredLanguageFromSettings('es');
        const previousIsRTL = I18nManager.isRTL;
        (I18nManager as { isRTL: boolean }).isRTL = true;
        try {
            const longWorkspaceId = `workspace-${'muy-largo-'.repeat(12)}`;
            const longSessionId = `session-${'technical-id-'.repeat(12)}`;
            const createdAt = Date.UTC(2025, 6, 27, 13, 45);
            const screen = await renderScreen(
                <mod.PluginPermissionGrantSheet
                    pendingRequest={{
                        id: 'request-rtl',
                        pluginId: 'review-coderabbit',
                        pluginName: 'CodeRabbit',
                        capability: 'reviews.comments.write.direct',
                        targetScope: { kind: 'workspace', workspaceId: longWorkspaceId },
                        requester: {
                            kind: 'plugin',
                            pluginId: 'review-coderabbit',
                            sessionId: longSessionId,
                            requestId: 'provider-request-1',
                        },
                        authoritySource: {
                            kind: 'machine_installation',
                            machineId: 'machine-1',
                            installationId: 'installation-1',
                        },
                        status: 'pending',
                        createdAt,
                        updatedAt: createdAt,
                    }}
                    labels={{
                        title: 'Solicitud de permiso del plugin',
                        body: ({ pluginName, pluginId }) => `${pluginName} (${pluginId}) solicita un permiso.`,
                        grant: 'Conceder permiso',
                        dismiss: 'Ahora no',
                    }}
                    onGrant={() => {}}
                    onDismiss={() => {}}
                    testID="plugin-grant-localized"
                />,
            );

            const content = screen.getTextContent();
            expect(content).toContain('Solicitante');
            expect(content).toContain('Autoridad');
            expect(content).toContain('Ámbito');
            expect(content).toContain('Hora de la solicitud');
            expect(content).toContain(longWorkspaceId);
            expect(content).toContain(longSessionId);
            expect(content).toContain('reviews.comments.write.direct');
            expect(content).not.toContain('workspace:');
            expect(content).not.toContain('plugin:');
            expect(content).not.toContain(new Date(createdAt).toISOString());

            const details = screen.findByTestId('plugin-grant-localized-details');
            expect(details).not.toBeNull();
            expect(details?.props.accessible).toBe(true);
            expect(details?.props.accessibilityLabel).toContain(`Solicitante: Complemento`);
            expect(details?.props.accessibilityLabel).toContain(`Autoridad: Instalación en una máquina`);
            expect(details?.props.accessibilityLabel).toContain(`Ámbito: Espacio de trabajo`);
            expect(details?.props.accessibilityLabel).toContain(`Hora de la solicitud:`);
            expect(details?.props.accessibilityLabel).toContain(longWorkspaceId);
            expect(details?.props.accessibilityLabel).toContain(longSessionId);
            expect(details?.props.style.direction).toBe('rtl');
        } finally {
            (I18nManager as { isRTL: boolean }).isRTL = previousIsRTL;
        }
    });

    it('localizes the neighboring account, project, user, host, and bundled kinds', async () => {
        const mod = await loadSheet();
        expect(mod).not.toBeNull();
        if (!mod) return;

        setPreferredLanguageFromSettings('es');
        const sharedProps = {
            labels: {
                title: 'Solicitud de permiso del complemento',
                body: ({ pluginName, pluginId }: Readonly<{ pluginName: string; pluginId: string }>) =>
                    `${pluginName} (${pluginId}) solicita un permiso.`,
                grant: 'Conceder permiso',
                dismiss: 'Ahora no',
            },
            onGrant: () => {},
            onDismiss: () => {},
        };
        const accountScreen = await renderScreen(
            <mod.PluginPermissionGrantSheet
                {...sharedProps}
                pendingRequest={{
                    id: 'request-account',
                    pluginId: 'review-coderabbit',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'account' },
                    requester: { kind: 'user', userId: 'user-1' },
                    authoritySource: { kind: 'bundled' },
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }}
                testID="plugin-grant-account"
            />,
        );
        const accountSummary = accountScreen.findByTestId('plugin-grant-account-details')?.props.accessibilityLabel;
        expect(accountSummary).toContain('Ámbito: Cuenta');
        expect(accountSummary).toContain('Solicitante: Usuario · user-1');
        expect(accountSummary).toContain('Autoridad: Incluido');

        const projectScreen = await renderScreen(
            <mod.PluginPermissionGrantSheet
                {...sharedProps}
                pendingRequest={{
                    id: 'request-project',
                    pluginId: 'review-coderabbit',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'project', projectId: 'project-1' },
                    requester: { kind: 'host', label: 'host-label-1' },
                    authoritySource: { kind: 'bundled' },
                    status: 'pending',
                    createdAt: 1,
                    updatedAt: 1,
                }}
                testID="plugin-grant-project"
            />,
        );
        const projectSummary = projectScreen.findByTestId('plugin-grant-project-details')?.props.accessibilityLabel;
        expect(projectSummary).toContain('Ámbito: Proyecto · project-1');
        expect(projectSummary).toContain('Solicitante: Sistema anfitrión · host-label-1');
    });

    it('makes pending grant and dismiss actions inert when disabled', async () => {
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
                disabled
                onGrant={onGrant}
                onDismiss={onDismiss}
                testID="plugin-grant-disabled"
            />,
        );

        const grant = screen.findByTestId('plugin-grant-disabled-grant');
        const dismiss = screen.findByTestId('plugin-grant-disabled-dismiss');
        expect(grant).not.toBeNull();
        expect(dismiss).not.toBeNull();
        if (!grant || !dismiss) return;
        expect(grant.props.disabled).toBe(true);
        expect(grant.props.onPress).toBeUndefined();
        expect(dismiss.props.disabled).toBe(true);
        expect(dismiss.props.onPress).toBeUndefined();
        expect(onGrant).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('does not crash when daemon data contains an out-of-range request timestamp', async () => {
        const mod = await loadSheet();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const screen = await renderScreen(
            <mod.PluginPermissionGrantSheet
                pendingRequest={{
                    id: 'request-1',
                    pluginId: 'review-coderabbit',
                    pluginName: 'CodeRabbit',
                    capability: 'reviews.comments.write.direct',
                    targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
                    status: 'pending',
                    createdAt: Number.MAX_SAFE_INTEGER,
                    updatedAt: Number.MAX_SAFE_INTEGER,
                }}
                labels={{
                    title: 'Plugin permission request',
                    body: ({ pluginName, pluginId }) => `${pluginName} (${pluginId}) requested a permission.`,
                    grant: 'Grant permission',
                    dismiss: 'Dismiss request',
                }}
                onGrant={() => {}}
                onDismiss={() => {}}
                testID="plugin-grant-invalid-timestamp"
            />,
        );

        expect(screen.getTextContent()).toContain('CodeRabbit');
        expect(screen.findByTestId('plugin-grant-invalid-timestamp-requested-at')).toBeNull();
    });

    it('keeps grant and dismiss actions at least 48dp tall on Android', async () => {
        const mod = await loadSheet();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const screen = await renderScreen(
                <mod.PluginPermissionGrantSheet
                    pendingRequest={{
                        id: 'request-1',
                        pluginId: 'review-coderabbit',
                        pluginName: 'CodeRabbit',
                        capability: 'reviews.comments.write.direct',
                        targetScope: { kind: 'workspace', workspaceId: 'workspace-1' },
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
                    onGrant={() => {}}
                    onDismiss={() => {}}
                    testID="plugin-grant-android"
                />,
            );

            expect(screen.findByTestId('plugin-grant-android-grant')?.props.style.minHeight).toBeGreaterThanOrEqual(48);
            expect(screen.findByTestId('plugin-grant-android-dismiss')?.props.style.minHeight).toBeGreaterThanOrEqual(48);
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });
});
