import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import * as React from 'react';
import { renderHook, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { useApprovalReferenceReading, readApprovalReferenceForConfirmation } = await import('./approvalReferenceReading');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { storage } = await import('@/sync/domains/state/storage');
const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
const initialSettingsScope = storage.getState().settingsScope;

describe('Saved Secret names in binding approvals', () => {
    beforeEach(async () => {
        standardCleanup();
        resetSavedSecretCatalogSnapshotsForTests();
        await harness.reset();
    });
    afterEach(() => {
        storage.setState({ settingsScope: initialSettingsScope });
        standardCleanup();
    });

    it('reads both nested binding references by name and an unreadable reference as unavailable', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://binding-secret-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_binding_secrets' });
        storage.setState({ settingsScope: { serverId: 'srv_binding_secrets', accountId: 'recipient' } });
        const refs = ['happier:shared-secret:v1:first', 'happier:shared-secret:v1:second'];
        const names = ['Production key', 'Build key'];
        applySavedSecretCatalogPage({ scope: { serverId: 'srv_binding_secrets', accountId: 'recipient' }, observedAt: 1,
            entries: refs.map((ref, index) => ({ ref, source: 'shared_resource' as const, relationship: 'owner' as const,
                name: names[index]!, kind: 'apiKey' as const, encryptionMode: null, owner: null, accessSources: [], audience: null,
                ownerAccountId: null, revision: 1, materialStatus: 'ready' as const,
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } })) });
        const actionId = 'deployments.bindings.set';
        const actionArgs = getActionSpec(actionId).inputSchema.parse({ serverId: home, environmentId: 'environment', expectedRevision: 1,
            set: [...refs, 'happier:shared-secret:v1:unreadable'].map((ref, index) => ({ purpose: 'variable', name: `KEY_${index}`,
                phase: 'runtime', source: { kind: 'secret', ref, resourceRevision: 1 } })), remove: [] });
        const fields = describeApprovalActionFields({ actionId, actionArgs });
        const row = fields.rows.find(row => row.kind === 'value' && row.path === 'set');
        if (row?.kind !== 'value') throw new Error('Missing binding context');
        const references = row.entries?.filter(entry => entry.reference?.kind === 'savedSecret') ?? [];
        expect(references).toHaveLength(3);
        const account = await captureLazyActionAccountContext(home);
        try {
            for (const [index, entry] of references.entries()) {
                const expected = { text: names[index] ?? 'Unavailable', named: true };
                const hook = await renderHook(() => useApprovalReferenceReading(entry.reference, entry.value ?? '', home));
                expect(hook.getCurrent()).toMatchObject(expected);
                expect(await readApprovalReferenceForConfirmation(entry.reference, account)).toMatchObject(expected);
            }
            const voiceFields = describeApprovalActionFields({ actionId: 'settings.invoke', actionArgs: {
                anchor: 'voiceConversations.provider.acme.voice/realtime.credential',
                input: { kind: 'voice_saved_secret', credentialSlotId: 'api_key', operation: 'bind',
                    expectedSettingsVersion: 3, expectedSecretId: null, expectedSecretUpdatedAt: null, secretId: refs[0] },
            } });
            const voiceReference = voiceFields.rows.flatMap(row => row.kind === 'value'
                ? row.entries?.map(entry => entry.reference).filter((reference): reference is NonNullable<typeof reference> => reference?.kind === 'savedSecret') ?? []
                : []).at(0);
            expect(voiceReference).toEqual({ kind: 'savedSecret', id: refs[0] });
            const voiceReading = await renderHook(() => useApprovalReferenceReading(voiceReference!, refs[0], home));
            expect(voiceReading.getCurrent()).toMatchObject({ text: names[0], named: true });
            const card = await renderScreen(<ActionApprovalFieldsCard presentation={voiceFields} serverId={home} />);
            expect(card.getTextContent()).toContain(names[0]);
            expect(card.getTextContent()).not.toContain(refs[0]);
            await card.unmount();
        } finally { account.dispose(); }
    });
});
