import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { ProviderSettingsMigrationPendingConflictV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { DaemonProviderProfileMigrationPreviewResponseV1Schema, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { t } from '@/text';

const account = createProviderSettingsAccountHarness();
const machineRpc = vi.fn(async (input: Readonly<{ method: string }>) => input.method === RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREVIEW
    ? DaemonProviderProfileMigrationPreviewResponseV1Schema.parse({ status: 'success', sourceProfileId: 'deepseek',
        sourceFingerprint: `legacy-profile-migration-source:v1:${'a'.repeat(43)}` })
    : { status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 1 });
// Only the Machine transport is replaced; Account admission, bindings and retirement stay real.
vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
const { Modal, ModalProvider, useVisibleModalKind } = await import('@/modal');
const { ProviderErrorItems } = await import('@/components/settings/providers/ProviderErrorItems');

afterEach(async () => {
    standardCleanup();
    machineRpc.mockClear();
    await account.reset();
});

describe('Provider legacy review captured Account', () => {
    it('does not publish a late acknowledged Account A migration into the replacement Account dialog', async () => {
        const waivedActions = ['launch_profiles.legacy.convert'] as const;
        const { serverId } = await account.restore({ accountId: 'account-a', waivedActions });
        let modalId: string | null = null;
        const onConfirmed = vi.fn(async () => {});
        const onClose = vi.fn(() => { if (modalId) Modal.hide(modalId); });
        const profile = AIBackendProfileSchema.parse({ id: 'deepseek', name: 'Original Account profile',
            environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://api.deepseek.test/v1', isSecret: false }] });
        const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
        await act(async () => {
            modalId = Modal.show({ component: LegacyProfileMigrationReview, props: {
                machineId: 'machine-shared', serverId, profile, secretBindings: {}, onConfirmed, onClose,
            } });
        });
        const press = async (title: string) => {
            const row = screen.find(node => node.props.title === title && typeof node.props.onPress === 'function');
            await act(async () => { row.props.onPress(); });
            await flushHookEffects();
        };
        await press(t('settingsProviders.migration.preview'));
        await waitForHomeGovernance(() => expect(screen.find(node => node.props.title === t('settingsProviders.migration.confirm'))).toBeTruthy());
        machineRpc.mockClear();
        let releaseResponse: () => void = () => {};
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        machineRpc.mockImplementationOnce(async () => {
            await responseGate;
            return { status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 2 };
        });
        try {
            await press(t('settingsProviders.migration.confirm'));
            await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalledOnce());
            expect(machineRpc.mock.calls[0]?.[0]).toMatchObject({ accountId: 'account-a' });
            await act(async () => { await account.restore({ accountId: 'account-b', waivedActions }); });
            await act(async () => { releaseResponse(); });
            await waitForHomeGovernance(() => expect(screen.find(node => node.props.title === t('settingsProviders.migration.confirm')).props.loading).toBe(false));
            expect(machineRpc).toHaveBeenCalledOnce();
            expect(onConfirmed).not.toHaveBeenCalled();
            expect(onClose).not.toHaveBeenCalled();
        } finally {
            releaseResponse();
        }
    });
    it.each(['review', 'conflict'] as const)('never admits the original %s mapping to another Account with equal source ids', async kind => {
        const waivedActions = ['launch_profiles.legacy.convert', 'launch_profiles.legacy.resolve_conflict'] as const;
        const { serverId } = await account.restore({ accountId: 'account-a', waivedActions });
        let modalId: string | null = null;
        let modalKind: ReturnType<typeof useVisibleModalKind> = null;
        function HostStatus() {
            modalKind = useVisibleModalKind();
            return React.createElement('View');
        }
        const onClose = () => { if (modalId) Modal.hide(modalId); };
        const onConfirmed = vi.fn(async () => {});
        const profile = AIBackendProfileSchema.parse({ id: 'deepseek', name: 'Original Account profile',
            environmentVariables: [{ name: 'OPENAI_BASE_URL', value: 'https://api.deepseek.test/v1', isSecret: false }] });
        const conflict = ProviderSettingsMigrationPendingConflictV1Schema.parse({
            v: 1, sourceProfileId: profile.id, contributionKey: 'happier.provider.deepseek/deepseek',
            existingConnectionId: 'pc_existing', kinds: ['credential_binding'],
            candidateFingerprint: `legacy-profile-migration-conflict:v1:${'a'.repeat(43)}`, detectedAt: 1,
        });
        const screen = await renderScreen(<ModalProvider><HostStatus /></ModalProvider>);
        await act(async () => {
            const common = { machineId: 'machine-shared', serverId, onConfirmed, onClose };
            modalId = kind === 'review'
                ? Modal.show({ component: LegacyProfileMigrationReview, props: { ...common, profile, secretBindings: {} } })
                : Modal.show({ component: LegacyProfileMigrationConflictReview, props: { ...common, profileName: profile.name, conflict } });
        });
        await waitForHomeGovernance(() => expect(modalKind).toBe('custom'));
        const press = async (title: string) => {
            const row = screen.find(node => node.props.title === title && typeof node.props.onPress === 'function');
            await act(async () => { row.props.onPress(); });
            await flushHookEffects();
        };
        if (kind === 'review') {
            await press(t('settingsProviders.migration.preview'));
            await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalledOnce());
            await waitForHomeGovernance(() => expect(screen.find(node => node.props.title === t('settingsProviders.migration.confirm'))).toBeTruthy());
        }
        machineRpc.mockClear();
        // The same Home and source ids cannot turn Account A's authored mapping into Account B's intent.
        await act(async () => { await account.restore({ accountId: 'account-b', waivedActions }); });
        if (modalKind !== null) {
            await press(t(kind === 'review' ? 'settingsProviders.migration.confirm' : 'settingsProviders.migration.keepExisting'));
            await waitForHomeGovernance(() => {
                if (modalKind === null) return;
                const errors = screen.findAllByType(ProviderErrorItems);
                expect(errors.some(node => node.props.error?.code === 'provider_authorization_changed')).toBe(true);
            });
        }
        expect(machineRpc).not.toHaveBeenCalled();
        expect(onConfirmed).not.toHaveBeenCalled();
    });
});
