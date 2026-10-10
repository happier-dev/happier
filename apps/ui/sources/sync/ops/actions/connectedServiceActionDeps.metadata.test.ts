import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConnectedServicesCommonModuleMocks } from '@/components/settings/connectedServices/connectedServicesTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildQualifiedConnectedAccountGroupMutationRequestV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountGroupRequestsV4';
import { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountGroupRefSchema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { ConnectedPresentationRecordV1Schema, ConnectedPresentationRowMutationV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { profileDefaults } from '@/sync/domains/profiles/profile';

installConnectedServicesCommonModuleMocks();
afterEach(() => { resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('Connected metadata deletion receipt admission', () => {
    it('preserves required history refusal in pre-delete preparation and the definite cleanup receipt', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const accountId = 'history-cleanup-owner';
        const serverId = await home.addHome({ name: 'History cleanup', serverUrl: 'https://metadata-history-cleanup.test',
            accountId, currentAccount: true });
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' },
            incarnation: 'history-life', generation: 1, runtimeStateRevision: 0, displayName: 'Work',
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null,
            state: {}, createdAt: 0, updatedAt: 0, members: [] });
        const input = { group: group.ref, expectedIncarnation: group.incarnation, expectedGeneration: group.generation,
            expectedRuntimeStateRevision: group.runtimeStateRevision };
        const deletion = buildQualifiedConnectedAccountGroupMutationRequestV4('delete', input);
        let deleted = false;
        home.answer(serverId, 'GET /v1/account/encryption/currentness', { body: { mode: 'plain', version: 1,
            settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        // Genuine preference roots are already canonical and unchanged by deleting
        // this unbound group, so no unrelated purpose cleanup failure masks history.
        home.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
            connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
        } } } });
        home.answer(serverId, `GET ${PROFILE_TRANSFER_ROUTE_V1}`, { body: { status: 'absent' } });
        home.answer(serverId, 'GET /v1/account/profile', { select: () => ({ body: { ...profileDefaults, id: accountId,
            connectedAccountsV4: [], connectedAccountGroupsV4: deleted ? [] : [group] } }) });
        home.answer(serverId, 'GET /v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } });
        const presentationPath = '/v1/account/entity-rows/connected-metadata/presentation';
        const acknowledgementsPath = '/v1/account/entity-rows/connected-metadata/acknowledgements';
        let presentation = ConnectedPresentationRecordV1Schema.parse({ v: 1,
            entries: [{ v: 1, subject: { kind: 'group', ...group.ref }, label: 'Deleted personal label' }] });
        let presentationRevision = 4;
        home.answer(serverId, `GET ${presentationPath}`, { select: () => ({ body: { status: 'present', revision: presentationRevision,
            content: { t: 'plain', v: presentation } } }) });
        home.answer(serverId, `POST ${presentationPath}`, { select: input => {
            expect(deleted).toBe(true);
            const mutation = ConnectedPresentationRowMutationV1Schema.parse(input);
            expect(mutation.expectedRevision).toBe(4);
            if (mutation.content?.t !== 'plain') throw new Error('Expected the admitted Plain metadata mutation');
            presentation = ConnectedPresentationRecordV1Schema.parse(mutation.content.v);
            presentationRevision = 5;
            return { body: { status: 'updated', revision: 5, cursor: 5 } };
        } });
        home.answer(serverId, `GET ${acknowledgementsPath}`, { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, entries: [] } } } });
        const historyPath = '/v2/account/settings/history';
        home.answer(serverId, `GET ${historyPath}`, { status: 403, body: { error: 'history_forbidden' } });
        home.answer(serverId, `DELETE ${deletion.path}`, { select: () => {
            deleted = true;
            return { body: { success: true } };
        } });
        const encodedGroup = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, group.ref));
        home.answer(serverId, `GET /v4/connect/qualified/group?group=${encodedGroup}`, {
            status: 404, body: { error: 'connect_group_not_found' },
        });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiConnectedServiceAction } = await import('./connectedServiceActionDeps');
        const { prepareConnectedMetadataCleanupInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const prepared = await prepareConnectedMetadataCleanupInContext(account, { kind: 'group', ...group.ref });
            expect(prepared.source).toMatchObject({ version: 1, mode: 'plain', incomplete: false });
            expect(home.requestsFor(historyPath).length).toBeGreaterThan(0);
            // Ready rows do not make an explicitly refused required history
            // normalization complete. No historical collapse purge is requested.
            expect(prepared.failure).toMatchObject({ code: 'history-incomplete' });
            const result = await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.pools.delete', input });
            expect(result).toEqual({ applied: true, metadataCleanup: { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' } });
            expect(home.requestsFor(deletion.path)).toHaveLength(1);
            expect(presentation.entries).toEqual([]);
        } finally { account.dispose(); await home.reset(); }
    });

    it.each(['definite-group-delete', 'malformed-group-delete', 'member-delete'] as const)(
        'preserves only a validated definite group DELETE receipt after Account retirement (%s)', async kind => {
            const home = createHomeGovernanceHarness();
            installHomeGovernanceBoundaries(home);
            setRuntimeFetch(home.request);
            const serverId = await home.addHome({ name: 'Deletion owner', serverUrl: `https://delete-receipt-${kind}.test`,
                accountId: 'original-owner', currentAccount: true });
            const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
            const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' },
                incarnation: 'work-life', generation: 1, runtimeStateRevision: 0, displayName: 'Work',
                policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null,
                state: {}, createdAt: 0, updatedAt: 0, members: [] });
            const revision = { expectedIncarnation: group.incarnation, expectedGeneration: group.generation,
                expectedRuntimeStateRevision: group.runtimeStateRevision };
            const input = kind === 'member-delete' ? { group: group.ref, ...revision, connectedAccountId: 'member' }
                : { group: group.ref, ...revision };
            const request = kind === 'member-delete'
                ? buildQualifiedConnectedAccountGroupMutationRequestV4('removeMember', { group: group.ref, ...revision, connectedAccountId: 'member' })
                : buildQualifiedConnectedAccountGroupMutationRequestV4('delete', { group: group.ref, ...revision });
            // The network returns an actual ACK after the initiating credential
            // lifetime retires. Capture, transport, schemas and executor stay real.
            let acknowledgementReturned = false;
            home.answer(serverId, `DELETE ${request.path}`, { select: async () => {
                await home.switchAccount(serverId, 'replacement-owner');
                acknowledgementReturned = true;
                return { body: kind === 'member-delete' ? { group } : { success: kind === 'definite-group-delete' } };
            } });
            const { captureLazyActionAccountContext } = await import('./actionAccountContext');
            const { createUiConnectedServiceAction } = await import('./connectedServiceActionDeps');
            const account = await captureLazyActionAccountContext(serverId);
            try {
                const invoke = createUiConnectedServiceAction(account);
                const result = await invoke({ actionId: kind === 'member-delete' ? 'connectedServices.pools.members.remove' : 'connectedServices.pools.delete', input });
                expect(home.requestsFor(request.path)).toHaveLength(1);
                expect(acknowledgementReturned).toBe(true);
                if (kind === 'definite-group-delete') {
                    // Expose a real admission/transport error before the strict
                    // output parser can hide it behind a schema mismatch.
                    expect(result).toMatchObject({ applied: true });
                    expect(CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.pools.delete'].parse(result)).toEqual({ applied: true,
                        metadataCleanup: { status: 'cleanup-pending', reason: 'connected_metadata_cleanup_pending' } });
                } else {
                    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
                    expect(result).not.toHaveProperty('applied');
                }
            } finally { account.dispose(); await home.reset(); }
        });
});
