import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsMigrationPendingConflictV1Schema } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks();
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ method: string }>) => {
        if (request.method === 'daemon.providers.profileMigration.conflict.confirm') return confirm(request);
        throw new Error(`Unexpected Provider RPC method: ${request.method}`);
    },
}));
vi.mock('@/components/ui/forms/MachineSetupTextField', () => ({
    MachineSetupTextField: (props: Record<string, unknown>) => React.createElement('MachineSetupTextField', props),
}));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemList', props, props.children),
}));

const fingerprint = `legacy-profile-migration-conflict:v1:${'a'.repeat(43)}`;
const conflict = ProviderSettingsMigrationPendingConflictV1Schema.parse({
    v: 1,
    sourceProfileId: 'deepseek',
    contributionKey: 'happier.provider.deepseek/deepseek',
    existingConnectionId: 'pc_existing',
    kinds: ['credential_binding', 'manual_model'],
    modelChoices: [
        {
            kind: 'existing',
            selection: { agentTargetKey: 'agent:claude', modelId: 'existing-model' },
            label: 'Existing model',
        },
        {
            kind: 'legacy',
            selection: { agentTargetKey: 'agent:claude', modelId: 'legacy-model' },
            label: 'Legacy model',
        },
    ],
    candidateFingerprint: fingerprint,
    detectedAt: 1,
});

describe('LegacyProfileMigrationConflictReview', () => {
    afterEach(standardCleanup);
    beforeEach(() => confirm.mockReset());

    it('requires and submits an exact redacted model outcome when keeping the existing connection', async () => {
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 10,
        });
        const onConfirmed = vi.fn(async () => undefined);
        const onClose = vi.fn();
        const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek"
            conflict={conflict}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        const serialized = JSON.stringify(screen.findAllByType('Item').map((item) => item.props));
        expect(serialized).toContain('settingsProviders.migration.conflictCredential');
        expect(serialized).toContain('settingsProviders.migration.conflictModels');
        expect(serialized).not.toContain(fingerprint);
        expect(serialized).not.toContain('pc_existing');
        expect(serialized).not.toContain('happier.provider.deepseek');

        const keepItem = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.keepExisting');
        expect(keepItem?.props.disabled).toBe(true);
        await React.act(async () => {
            screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.preserveLegacyModel')?.props.onPress?.();
        });
        await React.act(async () => { await keepItem?.props.onPress?.(); });
        expect(confirm).toHaveBeenCalledWith({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: 'daemon.providers.profileMigration.conflict.confirm',
            payload: {
                machineId: 'machine-a',
                sourceProfileId: 'deepseek',
                expectedCandidateFingerprint: fingerprint,
                decision: {
                    kind: 'keep_existing',
                    existingConnectionId: 'pc_existing',
                    modelSelection: { agentTargetKey: 'agent:claude', modelId: 'legacy-model' },
                },
            },
        });
        expect(onConfirmed).toHaveBeenCalledWith(10);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('makes discarding legacy model intent an explicit disclosed choice', async () => {
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_existing', settingsVersion: 12,
        });
        const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek"
            conflict={conflict}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        const discardItem = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.discardLegacyModel');
        expect(discardItem?.props.subtitle).toBe('settingsProviders.migration.discardLegacyModelDescription');
        await React.act(async () => { discardItem?.props.onPress?.(); });
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.keepExisting')?.props.onPress?.();
        });
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                decision: { kind: 'keep_existing', existingConnectionId: 'pc_existing', modelSelection: null },
            }),
        }));
    });

    it('creates a separately named connection without exposing conflict internals', async () => {
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_new', settingsVersion: 11,
        });
        const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek work"
            conflict={conflict}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);
        const nameField = screen.findAllByType('MachineSetupTextField')[0];
        await React.act(async () => { nameField?.props.onChangeText?.('DeepSeek work account'); });
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.createNamed')?.props.onPress?.();
        });
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                decision: expect.objectContaining({
                    kind: 'create_named',
                    connectionId: expect.stringMatching(/^pc_/u),
                    displayName: 'DeepSeek work account',
                }),
            }),
        }));
    });

    it('reviews current profile state after an ambiguous transport failure without replaying the decision', async () => {
        confirm.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const onConfirmed = vi.fn(async () => undefined);
        const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
        const { ProviderErrorItems } = await import('@/components/settings/providers/ProviderErrorItems');
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek"
            conflict={{ ...conflict, kinds: ['credential_binding'], modelChoices: [] }}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={vi.fn()}
        />);
        const create = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.createNamed');
        await React.act(async () => { await create?.props.onPress?.(); });

        const titles = screen.findAllByType('Item').map((item) => item.props.title);
        expect(titles).toContain('settingsProviders.errors.mutationOutcomeUnknownTitle');
        expect(titles).toContain('settingsProviders.errors.actions.reviewCurrentState');
        expect(titles).not.toContain('settingsProviders.errors.migrationConflictTitle');
        expect(screen.findByType(ProviderErrorItems.type).props.retry).toBeUndefined();

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(onConfirmed).not.toHaveBeenCalled();
    });

    it('retries only settings rehydrate after an acknowledged conflict decision', async () => {
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_new', settingsVersion: 19,
        });
        const onConfirmed = vi.fn()
            .mockRejectedValueOnce(new Error('settings rehydrate unavailable'))
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek"
            conflict={{ ...conflict, kinds: ['credential_binding'], modelChoices: [] }}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.createNamed')?.props.onPress?.();
        });
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.retry')?.props.onPress?.();
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(onConfirmed).toHaveBeenCalledTimes(2);
        expect(onConfirmed).toHaveBeenNthCalledWith(1, 19);
        expect(onConfirmed).toHaveBeenNthCalledWith(2, 19);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
