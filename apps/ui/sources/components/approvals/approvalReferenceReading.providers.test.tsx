import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1 } from '@happier-dev/protocol/teams';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { ProviderConnectionsCatalogV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { readActionApprovalSubject } = await import('./actionApprovalPresentation');
const { resolveApprovalRequestTitle, useApprovalRequestTitle } = await import('./approvalRequestTitle');
const { useApprovalReferenceReading, readApprovalReferenceForConfirmation } = await import('./approvalReferenceReading');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');

const actionId = 'providers.models.experimental.confirm';
const input = PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse({ action: 'confirmExperimental',
    connectionId: 'pc_approval', expectedConnectionRevision: 1,
    agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.6-luna',
    compatibilityFingerprint: 'compatibility:v1:experimental' });

describe('Provider approval reference reading', () => {
    beforeEach(async () => {
        standardCleanup();
        resetTeamsSnapshotsForTests();
        resetTeamsDirectoryEngineForTests();
        resetTeamActionClientForTests();
        resetServerFeaturesClientForTests();
        resetSavedSecretCatalogSnapshotsForTests();
        await harness.reset();
    });
    afterEach(() => standardCleanup());

    it('reads a Provider approval computer through its captured Home Machine reference', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-machine-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_approval' });
        const { storage } = await import('@/sync/domains/state/storage');
        const machine = createMachineFixture({ id: 'machine-provider', metadata: {
            ...createMachineFixture().metadata!, displayName: 'Studio computer',
        } });
        storage.setState({ machineListByServerId: { [home]: [machine] },
            machineListStatusByServerId: { [home]: 'idle' } });
        const fields = describeApprovalActionFields({ actionId, actionArgs: { ...input, machineId: machine.id } });
        const field = fields.rows.find(row => row.path === 'machineId');
        if (!field || field.kind !== 'value') throw new Error('Missing computer field');
        const hook = await renderHook(() => useApprovalReferenceReading(field.reference, field.value, home));
        expect(hook.getCurrent()).toMatchObject({ text: 'Studio computer', named: true });
        const account = await captureLazyActionAccountContext(home);
        try {
            expect(await readApprovalReferenceForConfirmation(field.reference, account))
                .toMatchObject({ text: 'Studio computer', named: true });
        } finally { account.dispose(); }
    });

    it('keeps retired Team aliases unavailable without hydrating Team catalogs for a personal approval', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://retired-team-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_retired_team', teamsEnabled: true, credentialResourcesEnabled: true });
        await harness.selectHomes([home]);
        const reference = { kind: 'providerConnection' as const, id: 'connected-source:retired', agentTargetKey: input.agentTargetKey };
        const hook = await renderHook(() => useApprovalReferenceReading(reference, input.connectionId, home));
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ text: 'Unavailable', named: true });
        expect(harness.requestsFor(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1)).toHaveLength(0);
        const account = await captureLazyActionAccountContext(home);
        try {
            expect(await readApprovalReferenceForConfirmation(reference, account))
                .toMatchObject({ text: 'Unavailable', named: true });
        } finally { account.dispose(); }
        expect(harness.requestsFor(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1)).toHaveLength(0);
    });

    it('reads a Saved Secret by its name, and a deleted one as unavailable rather than by its id', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://saved-secret-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_saved_secret' });
        const scope = { serverId: 'srv_saved_secret', accountId: 'recipient' };
        const ref = 'happier:shared-secret:v1:resource-a';
        applySavedSecretCatalogPage({ scope, observedAt: 1, entries: [{ ref, source: 'shared_resource', relationship: 'owner',
            name: 'OpenRouter key', kind: 'apiKey', encryptionMode: null, owner: null, accessSources: [], audience: null,
            ownerAccountId: null, revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }] });
        const account = await captureLazyActionAccountContext(home);
        try {
            expect(await readApprovalReferenceForConfirmation({ kind: 'savedSecret', id: ref }, account))
                .toMatchObject({ text: 'OpenRouter key', named: true });
            expect(await readApprovalReferenceForConfirmation({ kind: 'savedSecret', id: 'happier:shared-secret:v1:deleted' }, account))
                .toMatchObject({ text: 'Unavailable', named: true });
        } finally { account.dispose(); }
    });

    it('names a subscription slot by the purpose title its Provider declares, not by the humanized purpose id', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://purpose-slot-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_purpose_slot' });
        const slot = { kind: 'connectedAccount' as const, id: 'pool-a', service: 'happier.agent.codex/openai-codex', pool: true as const,
            purpose: { id: 'openai-upstream', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' } };
        const hook = await renderHook(() => useApprovalReferenceReading(slot, 'pool-a', home));
        expect(hook.getCurrent().label).toBe('ChatGPT account or pool');
        // A purpose the Provider does not declare leaves the row with its own label.
        const unknown = await renderHook(() => useApprovalReferenceReading(
            { ...slot, purpose: { ...slot.purpose, id: 'not-declared' } }, 'pool-a', home));
        expect(unknown.getCurrent().label).toBeUndefined();
    });

    it('uses the declared model as the subject and names the Agent in the generic approval reader', async () => {
        const home = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://provider-model-reference.test',
            accountId: 'recipient', serverIdentityId: 'srv_approval' });
        const fields = describeApprovalActionFields({ actionId, actionArgs: input });
        const agent = fields.rows.find(row => row.path === 'agentTargetKey');
        expect(agent?.kind).toBe('value');
        if (!agent || agent.kind !== 'value') throw new Error('Missing Agent field');
        const subject = readActionApprovalSubject({ actionId, actionArgs: input });
        expect(subject).toMatchObject({ kind: 'providerModel', id: input.modelId });
        const hook = await renderHook(() => useApprovalReferenceReading(agent.reference, agent.value, home));
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ text: 'Codex', named: true });
        const title = await renderHook(() => useApprovalRequestTitle({ storedTitle: null, actionId, actionArgs: input }, home));
        expect(title.getCurrent().title).toContain(input.modelId);
        // Both presenters read the same personal catalog, without Team discovery.
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
            connections: [{ v: 1, id: input.connectionId, source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
                role: 'named', displayName: 'Personal gateway', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { [input.connectionId]: [{ id: input.modelId, name: 'GPT-5.6 Luna', addedAt: 1 }] },
        });
        applyProviderCatalogSnapshot({ serverId: 'srv_approval', accountId: 'recipient' },
            { status: 'ready', revision: 1, catalog }, true);
        const account = await captureLazyActionAccountContext(home);
        try {
            const reading = await readApprovalReferenceForConfirmation(subject, account);
            expect(reading.text).toBe('GPT-5.6 Luna');
            expect(resolveApprovalRequestTitle({ storedTitle: null, actionId, actionArgs: input, subject: reading.text }).title).toContain(reading.text);
        } finally { account.dispose(); }
        expect(harness.requestsFor(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1)).toHaveLength(0);
    });
});
