import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, createProviderErrorV1 } from '@happier-dev/protocol';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ method: string }>) => {
        if (request.method === 'daemon.providers.profileMigration.preview') return preview(request);
        if (request.method === 'daemon.providers.profileMigration.confirm') return confirm(request);
        throw new Error(`Unexpected Provider RPC method: ${request.method}`);
    },
}));
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const [{ Item }, { DropdownMenu }, { ProviderErrorItems }] = await Promise.all([
    import('@/components/ui/lists/Item'),
    import('@/components/ui/forms/dropdown/DropdownMenu'),
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

const profile = AIBackendProfileSchema.parse({
    id: 'legacy-a', name: 'Legacy A',
    environmentVariables: [
        { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test' },
        { name: 'SAFE_LAUNCH_FLAG', value: 'private-value-never-rendered' },
    ],
    envVarRequirements: [{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', required: true }],
});

const multiCredentialProfile = AIBackendProfileSchema.parse({
    id: 'legacy-multi', name: 'Legacy multi',
    environmentVariables: [
        { name: 'OPENAI_BASE_URL', value: 'https://gateway.example.test' },
        { name: 'SAFE_LAUNCH_FLAG', value: 'private-value-never-rendered' },
    ],
    envVarRequirements: [
        { name: 'OPENAI_API_KEY', kind: 'secret', required: true },
        { name: 'COMPANY_GATEWAY_TOKEN', kind: 'secret', required: true },
    ],
});

describe('LegacyProfileMigrationReview', () => {
    afterEach(async () => { vi.useRealTimers(); standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        preview.mockReset(); confirm.mockReset(); vi.useRealTimers();
        serverId = (await account.restore({ waivedActions: ['launch_profiles.legacy.convert'] })).serverId;
    });

    it('requires a preview before confirm and rehydrates the acknowledged settings version after success', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'a'.repeat(43)}`;
        preview.mockResolvedValueOnce({ status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint });
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-a', connectionId: 'pc_result', settingsVersion: 8,
        });
        const onConfirmed = vi.fn(async () => undefined);
        const onClose = vi.fn();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        expect(screen.findAllByType(Item).some((item) => item.props.title === 'settingsProviders.migration.confirm')).toBe(false);
        const redactedFacts = screen.findAllByType(Item).map((item) => item.props.title);
        expect(redactedFacts).toEqual(expect.arrayContaining([
            'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'SAFE_LAUNCH_FLAG',
        ]));
        const previewRows = JSON.stringify({ text: screen.getTextContent(), values: screen.findAll(node => typeof node.type === 'string' && typeof node.props.value === 'string').map(node => node.props.value) });
        expect(previewRows).not.toContain('private-value-never-rendered');
        expect(previewRows).not.toContain('saved-secret-id');
        await pressRow(screen, 'settingsProviders.migration.preview');
        vi.setSystemTime(2_000);
        const confirmAction = screen.findAllByType(Item).find((item) => item.props.title === 'settingsProviders.migration.confirm');
        expect(confirmAction).toBeDefined();
        await pressRow(screen, 'settingsProviders.migration.confirm');

        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ expectedSourceFingerprint: fingerprint }),
        }));
        expect(confirm.mock.calls[0]?.[0].payload.reviewedMapping)
            .toEqual(preview.mock.calls[0]?.[0].payload.reviewedMapping);
        expect(onConfirmed).toHaveBeenCalledWith(8);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('cancels without an RPC or settings rehydrate', async () => {
        const onConfirmed = vi.fn(async () => undefined);
        const onClose = vi.fn();
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);
        await pressRow(screen, 'common.cancel');
        expect(preview).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(onConfirmed).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('returns to preview when the source changes after review', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'b'.repeat(43)}`;
        preview.mockResolvedValueOnce({ status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint });
        confirm.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_profile_migration_source_changed', { sourceProfileId: 'legacy-a' }),
        });
        const onConfirmed = vi.fn(async () => undefined);
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={vi.fn()}
        />);
        await pressRow(screen, 'settingsProviders.migration.preview');
        await pressRow(screen, 'settingsProviders.migration.confirm');
        expect(screen.findAllByType(Item).some((item) => item.props.title === 'settingsProviders.migration.preview')).toBe(true);
        expect(onConfirmed).not.toHaveBeenCalled();
    });

    it('requires an exact credential choice and keeps every non-selected requirement visible', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'c'.repeat(43)}`;
        preview.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-multi', sourceFingerprint: fingerprint,
        });
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={multiCredentialProfile}
            secretBindings={{
                OPENAI_API_KEY: 'saved-openai',
                COMPANY_GATEWAY_TOKEN: 'saved-company',
            }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        const previewActionBefore = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.migration.preview');
        expect(previewActionBefore?.props.disabled).toBe(true);
        const initialRows = screen.findAllByType(Item).map((item) => item.props.title);
        expect(initialRows).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'COMPANY_GATEWAY_TOKEN']));

        const credentialPicker = screen.findAllByType(DropdownMenu)
            .find((item) => item.props.itemTrigger?.title === 'settingsProviders.migration.credentialTitle');
        expect(credentialPicker?.props.items.map((item: { id: string }) => item.id))
            .toEqual(['__none__', 'COMPANY_GATEWAY_TOKEN', 'OPENAI_API_KEY']);
        await React.act(async () => { credentialPicker?.props.onSelect?.('__none__'); });
        expect(screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.migration.preview')?.props.disabled).toBe(false);
        await React.act(async () => { credentialPicker?.props.onSelect?.('COMPANY_GATEWAY_TOKEN'); });

        const previewActionWithoutFormat = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.migration.preview');
        expect(previewActionWithoutFormat?.props.disabled).toBe(true);
        const stylePicker = screen.findAllByType(DropdownMenu)
            .find((item) => item.props.itemTrigger?.title === 'settingsProviders.authoring.credentialStyleTitle');
        expect(stylePicker?.props.items.map((item: { id: string }) => item.id)).toEqual(['bearer', 'x-api-key']);
        await React.act(async () => { stylePicker?.props.onSelect?.('bearer'); });

        const previewAction = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.migration.preview');
        expect(previewAction?.props.disabled).toBe(false);
        await pressRow(screen, 'settingsProviders.migration.preview');
        expect(preview.mock.calls[0]?.[0].payload.reviewedMapping.credentialMoves).toEqual([
            { legacyEnvVarName: 'COMPANY_GATEWAY_TOKEN', credentialSlotId: 'apiKey', credentialStyle: 'bearer' },
        ]);
        expect(preview.mock.calls[0]?.[0].payload.reviewedMapping.connection.source.template.credential)
            .toMatchObject({ transports: [{ destination: { name: 'authorization', format: 'bearer' } }] });
        expect(JSON.stringify({ text: screen.getTextContent(), values: screen.findAll(node => typeof node.type === 'string' && typeof node.props.value === 'string').map(node => node.props.value) }))
            .not.toContain('saved-company');
    });

    it('keeps a preview transport failure typed and retries the exact preview action', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'d'.repeat(43)}`;
        preview
            .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'machine_offline' }))
            .mockResolvedValueOnce({ status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint });
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        await pressRow(screen, 'settingsProviders.migration.preview');
        expect(screen.findByType(ProviderErrorItems).props.error).toEqual(createProviderErrorV1('machine_offline', {
            machineId: 'machine-a', sourceProfileId: profile.id,
        }));
        expect(screen.getTextContent()).toContain('settingsProviders.errors.actions.retry');
        await pressRecovery(screen);
        expect(preview).toHaveBeenCalledTimes(2);
        expect(preview.mock.calls[1]?.[0].payload).toEqual(preview.mock.calls[0]?.[0].payload);
        expect(screen.findAllByType(Item).map((item) => item.props.title))
            .toContain('settingsProviders.migration.confirm');
    });

    it('reviews current profile state after an unknown confirm outcome without replaying confirm', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'e'.repeat(43)}`;
        preview.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint,
        });
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-a',
        });
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        await pressRow(screen, 'settingsProviders.migration.preview');
        await pressRow(screen, 'settingsProviders.migration.confirm');
        expect(screen.getTextContent()).toContain('settingsProviders.errors.mutationOutcomeUnknownTitle');
        expect(screen.getTextContent()).toContain('settingsProviders.errors.actions.reviewCurrentState');
        expect(screen.findByType(ProviderErrorItems).props.retry).toBeUndefined();
        await pressRecovery(screen);
        expect(confirm).toHaveBeenCalledOnce();
    });

    it('retries only settings rehydrate after an acknowledged migration', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'f'.repeat(43)}`;
        preview.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint,
        });
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-a', connectionId: 'pc_result', settingsVersion: 18,
        });
        const onConfirmed = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('settings rehydrate unavailable'), { code: 'ENETUNREACH' }))
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId={serverId}
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        await pressRow(screen, 'settingsProviders.migration.preview');
        await pressRow(screen, 'settingsProviders.migration.confirm');
        expect(screen.getTextContent())
            .toContain('settingsProviders.errors.actions.retry');

        await pressRecovery(screen);
        expect(confirm).toHaveBeenCalledOnce();
        expect(onConfirmed).toHaveBeenCalledTimes(2);
        expect(onConfirmed).toHaveBeenNthCalledWith(1, 18);
        expect(onConfirmed).toHaveBeenNthCalledWith(2, 18);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
