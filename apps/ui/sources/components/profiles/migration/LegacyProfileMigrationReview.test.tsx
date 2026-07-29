import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, createProviderErrorV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks();
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ method: string }>) => {
        if (request.method === 'daemon.providers.profileMigration.preview') return preview(request);
        if (request.method === 'daemon.providers.profileMigration.confirm') return confirm(request);
        throw new Error(`Unexpected Provider RPC method: ${request.method}`);
    },
}));
vi.mock('@/components/ui/forms/MachineSetupTextField', () => ({
    MachineSetupTextField: (props: Record<string, unknown>) => React.createElement('MachineSetupTextField', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('Item', props) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemList', props, props.children),
}));

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
    afterEach(standardCleanup);
    beforeEach(() => { preview.mockReset(); confirm.mockReset(); vi.useRealTimers(); });

    it('requires a preview before confirm and rehydrates the acknowledged settings version after success', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'a'.repeat(43)}`;
        preview.mockResolvedValueOnce({ status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint });
        confirm.mockResolvedValueOnce({
            status: 'success', sourceProfileId: 'legacy-a', connectionId: 'pc_result', settingsVersion: 8,
        });
        const onConfirmed = vi.fn(async () => undefined);
        const onClose = vi.fn();
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        expect(screen.findAllByType('Item').some((item) => item.props.title === 'settingsProviders.migration.confirm')).toBe(false);
        const redactedFacts = screen.findAllByType('Item').map((item) => item.props.title);
        expect(redactedFacts).toEqual(expect.arrayContaining([
            'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'SAFE_LAUNCH_FLAG',
        ]));
        const previewRows = JSON.stringify(screen.findAllByType('Item').map((item) => item.props));
        expect(previewRows).not.toContain('private-value-never-rendered');
        expect(previewRows).not.toContain('saved-secret-id');
        const previewAction = screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.migration.preview');
        await React.act(async () => { await previewAction?.props.onPress?.(); });
        vi.setSystemTime(2_000);
        const confirmAction = screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.migration.confirm');
        expect(confirmAction).toBeDefined();
        await React.act(async () => { await confirmAction?.props.onPress?.(); });

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
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);
        const cancel = screen.findAllByType('Item').find((item) => item.props.title === 'common.cancel');
        await React.act(async () => { cancel?.props.onPress?.(); });
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
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={vi.fn()}
        />);
        await React.act(async () => {
            await screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.migration.preview')?.props.onPress?.();
        });
        await React.act(async () => {
            await screen.findAllByType('Item').find((item) => item.props.title === 'settingsProviders.migration.confirm')?.props.onPress?.();
        });
        expect(screen.findAllByType('Item').some((item) => item.props.title === 'settingsProviders.migration.preview')).toBe(true);
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
            serverId="server-a"
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        const previewActionBefore = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.preview');
        expect(previewActionBefore?.props.disabled).toBe(true);
        const initialRows = screen.findAllByType('Item').map((item) => item.props.title);
        expect(initialRows).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'COMPANY_GATEWAY_TOKEN']));

        const credentialPicker = screen.findAllByType('DropdownMenu')
            .find((item) => item.props.itemTrigger?.title === 'settingsProviders.migration.credentialTitle');
        expect(credentialPicker?.props.items.map((item: { id: string }) => item.id))
            .toEqual(['__none__', 'COMPANY_GATEWAY_TOKEN', 'OPENAI_API_KEY']);
        await React.act(async () => { credentialPicker?.props.onSelect?.('__none__'); });
        expect(screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.preview')?.props.disabled).toBe(false);
        await React.act(async () => { credentialPicker?.props.onSelect?.('COMPANY_GATEWAY_TOKEN'); });

        const previewActionWithoutFormat = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.preview');
        expect(previewActionWithoutFormat?.props.disabled).toBe(true);
        const stylePicker = screen.findAllByType('DropdownMenu')
            .find((item) => item.props.itemTrigger?.title === 'settingsProviders.authoring.credentialStyleTitle');
        expect(stylePicker?.props.items.map((item: { id: string }) => item.id)).toEqual(['bearer', 'x-api-key']);
        await React.act(async () => { stylePicker?.props.onSelect?.('bearer'); });

        const previewAction = screen.findAllByType('Item')
            .find((item) => item.props.title === 'settingsProviders.migration.preview');
        expect(previewAction?.props.disabled).toBe(false);
        await React.act(async () => { await previewAction?.props.onPress?.(); });
        expect(preview.mock.calls[0]?.[0].payload.reviewedMapping.credentialMoves).toEqual([
            { legacyEnvVarName: 'COMPANY_GATEWAY_TOKEN', credentialSlotId: 'apiKey', credentialStyle: 'bearer' },
        ]);
        expect(preview.mock.calls[0]?.[0].payload.reviewedMapping.connection.source.template.credential)
            .toMatchObject({ transports: [{ destination: { name: 'authorization', format: 'bearer' } }] });
        expect(JSON.stringify(screen.findAllByType('Item').map((item) => item.props)))
            .not.toContain('saved-company');
    });

    it('keeps a preview transport failure typed and retries the exact preview action', async () => {
        const fingerprint = `legacy-profile-migration-source:v1:${'d'.repeat(43)}`;
        preview
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ status: 'success', sourceProfileId: 'legacy-a', sourceFingerprint: fingerprint });
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.preview')?.props.onPress?.();
        });
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toEqual(expect.arrayContaining([
            'settingsProviders.errors.unreachableTitle',
            'settingsProviders.errors.actions.retry',
        ]));
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.retry')?.props.onPress?.();
        });
        expect(preview).toHaveBeenCalledTimes(2);
        expect(screen.findAllByType('Item').map((item) => item.props.title))
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
        const { ProviderErrorItems } = await import('@/components/settings/providers/ProviderErrorItems');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={vi.fn(async () => undefined)}
            onClose={vi.fn()}
        />);

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.preview')?.props.onPress?.();
        });
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.confirm')?.props.onPress?.();
        });
        expect(screen.findAllByType('Item').map((item) => item.props.title)).toEqual(expect.arrayContaining([
            'settingsProviders.errors.mutationOutcomeUnknownTitle',
            'settingsProviders.errors.actions.reviewCurrentState',
        ]));
        expect(screen.findByType(ProviderErrorItems.type).props.retry).toBeUndefined();
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.reviewCurrentState')
                ?.props.onPress?.();
        });
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
            .mockRejectedValueOnce(new Error('settings rehydrate unavailable'))
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        const { LegacyProfileMigrationReview } = await import('./LegacyProfileMigrationReview');
        const screen = await renderScreen(<LegacyProfileMigrationReview
            profile={profile}
            secretBindings={{ ANTHROPIC_AUTH_TOKEN: 'saved-secret-id' }}
            machineId="machine-a"
            serverId="server-a"
            onConfirmed={onConfirmed}
            onClose={onClose}
        />);

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.preview')?.props.onPress?.();
        });
        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.migration.confirm')?.props.onPress?.();
        });
        expect(screen.findAllByType('Item').map((item) => item.props.title))
            .toContain('settingsProviders.errors.actions.retry');

        await React.act(async () => {
            await screen.findAllByType('Item')
                .find((item) => item.props.title === 'settingsProviders.errors.actions.retry')?.props.onPress?.();
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(onConfirmed).toHaveBeenCalledTimes(2);
        expect(onConfirmed).toHaveBeenNthCalledWith(1, 18);
        expect(onConfirmed).toHaveBeenNthCalledWith(2, 18);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
