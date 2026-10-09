import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsMigrationPendingConflictV1Schema } from '@happier-dev/protocol';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirm = vi.hoisted(() => vi.fn());

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ method: string }>) => {
        if (request.method === 'daemon.providers.profileMigration.conflict.confirm') return confirm(request);
        throw new Error(`Unexpected Provider RPC method: ${request.method}`);
    },
}));
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const [{ Item }, { MachineSetupTextField }, { ProviderErrorItems }] = await Promise.all([
    import('@/components/ui/lists/Item'),
    import('@/components/ui/forms/MachineSetupTextField'),
    import('@/components/settings/providers/ProviderErrorItems'),
]);
let serverId = '';

async function pressRow(screen: RenderScreenResult, title: string) {
    const row = screen.findAllByType(Item).find(item => item.props.title === title);
    expect(row).toBeDefined();
    expect(row?.props.disabled).not.toBe(true);
    await React.act(async () => { row!.props.onPress(); });
    await flushHookEffects();
    await waitForHomeGovernance(() => expect(screen.findAllByType(Item).some(item => item.props.loading)).toBe(false));
}

async function pressRecovery(screen: RenderScreenResult) {
    const error = screen.findByType(ProviderErrorItems).props.error;
    await screen.pressByTestIdAsync(`provider-error-action:${error.code}`);
    await flushHookEffects();
    await waitForHomeGovernance(() => expect(screen.findAllByType(Item).some(item => item.props.loading)).toBe(false));
}

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
    afterEach(async () => { standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        confirm.mockReset();
        serverId = (await account.restore({ waivedActions: ['launch_profiles.legacy.resolve_conflict'] })).serverId;
    });

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
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        const serialized = JSON.stringify({ text: screen.getTextContent(), values: screen.findAll(node => typeof node.type === 'string' && typeof node.props.value === 'string').map(node => node.props.value) });
        expect(serialized).toContain('settingsProviders.migration.conflictCredential');
        expect(serialized).toContain('settingsProviders.migration.conflictModels');
        expect(serialized).not.toContain(fingerprint);
        expect(serialized).not.toContain('pc_existing');
        expect(serialized).not.toContain('happier.provider.deepseek');

        const keepItem = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.migration.keepExisting');
        expect(keepItem?.props.disabled).toBe(true);
        await pressRow(screen, 'settingsProviders.migration.preserveLegacyModel');
        await pressRow(screen, 'settingsProviders.migration.keepExisting');
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId,
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
        }));
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
            serverId={serverId}
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        const discardItem = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.migration.discardLegacyModel');
        expect(discardItem?.props.subtitle).toBe('settingsProviders.migration.discardLegacyModelDescription');
        await pressRow(screen, 'settingsProviders.migration.discardLegacyModel');
        await pressRow(screen, 'settingsProviders.migration.keepExisting');
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
            serverId={serverId}
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);
        const nameField = screen.findAllByType(MachineSetupTextField)[0];
        await React.act(async () => { nameField?.props.onChangeText?.('DeepSeek work account'); });
        await pressRow(screen, 'settingsProviders.migration.createNamed');
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
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek"
            conflict={{ ...conflict, kinds: ['credential_binding'], modelChoices: [] }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={vi.fn()}
        />);
        await pressRow(screen, 'settingsProviders.migration.createNamed');

        const titles = screen.getTextContent();
        expect(titles).toContain('settingsProviders.errors.mutationOutcomeUnknownTitle');
        expect(titles).toContain('settingsProviders.errors.actions.reviewCurrentState');
        expect(titles).not.toContain('settingsProviders.errors.migrationConflictTitle');
        expect(screen.findByType(ProviderErrorItems).props.retry).toBeUndefined();

        await pressRecovery(screen);
        expect(confirm).toHaveBeenCalledOnce();
        expect(onConfirmed).not.toHaveBeenCalled();
    });

    it('retries only settings rehydrate after an acknowledged conflict decision', async () => {
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'deepseek', connectionId: 'pc_new', settingsVersion: 19,
        });
        const onConfirmed = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('settings rehydrate unavailable'), { code: 'ENETUNREACH' }))
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        const { LegacyProfileMigrationConflictReview } = await import('./LegacyProfileMigrationConflictReview');
        const screen = await renderScreen(<LegacyProfileMigrationConflictReview
            profileName="DeepSeek"
            conflict={{ ...conflict, kinds: ['credential_binding'], modelChoices: [] }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        await pressRow(screen, 'settingsProviders.migration.createNamed');
        expect(screen.getTextContent())
            .toContain('settingsProviders.errors.actions.retry');

        await pressRecovery(screen);
        expect(confirm).toHaveBeenCalledOnce();
        expect(onConfirmed).toHaveBeenCalledTimes(2);
        expect(onConfirmed).toHaveBeenNthCalledWith(1, 19);
        expect(onConfirmed).toHaveBeenNthCalledWith(2, 19);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
