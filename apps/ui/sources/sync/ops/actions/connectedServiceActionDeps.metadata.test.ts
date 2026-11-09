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
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, ConnectedPresentationRecordV1Schema, ConnectedPresentationRowMutationV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

installConnectedServicesCommonModuleMocks();
// Install the real HTTP boundary before collecting the shared Action graph.
// Cold source transformation belongs to collection, not a case's operation deadline.
installHomeGovernanceBoundaries(createHomeGovernanceHarness());
await import('./actionAccountContext');
await import('./connectedServiceActionDeps');
await import('@/sync/api/account/apiConnectedMetadataCatalog');
afterEach(() => { resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('Connected metadata raw read ownership', () => {
    it('does not detach pending row readers for a typed Home read', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Home read control', serverUrl: 'https://home-read-control.test',
            accountId: 'home-read-owner', currentAccount: true });
        const path = '/v1/account/entity-rows/connected-accounts/purposes';
        const held = createDeferred<void>();
        home.answer(serverId, `GET ${path}`, { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } });
        home.answer(serverId, `GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { body: { status: 'deleted', revision: 4 } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readConnectedAccountCatalogRowInContext } = await import('@/sync/api/account/apiConnectedAccountCatalog');
        const { ConnectedAccountCatalogRowReadResponseV1Schema } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
        const { requestHomeDomain } = await import('@/sync/api/home/homeServerActionTransport');
        const context = await captureLazyActionAccountContext(serverId);
        const reads: Promise<unknown>[] = [];
        try {
            reads.push(readConnectedAccountCatalogRowInContext(context, 'purposes', undefined, { fresh: false }));
            await vi.waitFor(() => expect(home.requestsFor(path)).toHaveLength(1));
            await expect(requestHomeDomain({ scope: context.accountLifetime.scope,
                path: CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, method: 'GET', input: undefined, effect: 'read',
                schema: ConnectedAccountCatalogRowReadResponseV1Schema, requestAuthority: context }))
                .resolves.toMatchObject({ ok: true });
            reads.push(readConnectedAccountCatalogRowInContext(context, 'purposes', undefined, { fresh: false }));
            await flushHookEffects();
            expect(home.requestsFor(path)).toHaveLength(1);
            held.resolve();
            await expect(Promise.all(reads)).resolves.toEqual([{ status: 'deleted', revision: 3 }, { status: 'deleted', revision: 3 }]);
        } finally {
            held.resolve(); await Promise.allSettled(reads); context.dispose(); await home.reset();
        }
    });

    it.each(['updated', 'outcome_unknown'] as const)('separates raw rows before, during and after an issued Home write with %s outcome', async outcome => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Composite row writer', serverUrl: `https://composite-row-${outcome}.test`,
            accountId: 'composite-row-owner', currentAccount: true });
        const path = '/v1/account/entity-rows/connected-accounts/purposes';
        const heldReads = createDeferred<void>();
        const heldWrite = createDeferred<void>();
        home.answer(serverId, `GET ${path}`, { respondAfter: heldReads.promise, body: { status: 'deleted', revision: 3 } });
        home.answer(serverId, `POST ${path}`, { respondAfter: heldWrite.promise,
            ...(outcome === 'outcome_unknown' ? { dispatchThenFail: true } : { body: { status: 'updated', revision: 4, cursor: 4 } }) });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readConnectedAccountCatalogRowInContext } = await import('@/sync/api/account/apiConnectedAccountCatalog');
        const { ConnectedAccountCatalogRowMutationResponseV1Schema } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
        const { requestHomeDomain } = await import('@/sync/api/home/homeServerActionTransport');
        const { subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const context = await captureLazyActionAccountContext(serverId);
        const changes: string[] = [];
        const unsubscribe = subscribeHomeAccountChange(event => { changes.push(event.serverId); });
        const reads: Promise<unknown>[] = [];
        let write: Promise<unknown> | undefined;
        try {
            const read = () => readConnectedAccountCatalogRowInContext(context, 'purposes', undefined, { fresh: false });
            reads.push(read());
            await vi.waitFor(() => expect(home.requestsFor(path)).toHaveLength(1));
            write = requestHomeDomain({ scope: context.accountLifetime.scope, path, effect: 'write',
                input: { expectedRevision: 3, content: { t: 'plain', v: { v: 1, bindings: [] } } },
                schema: ConnectedAccountCatalogRowMutationResponseV1Schema, requestAuthority: context });
            await vi.waitFor(() => expect(home.requestsFor(path)).toHaveLength(2));
            reads.push(read());
            await vi.waitFor(() => expect(home.requestsFor(path)).toHaveLength(3));
            heldWrite.resolve();
            await expect(write).resolves.toMatchObject(outcome === 'updated'
                ? { ok: true, value: { status: 'updated', revision: 4 } }
                : { ok: false, failure: { kind: 'outcome_unknown' } });
            home.answer(serverId, `GET ${path}`, { body: { status: 'deleted', revision: 4 } });
            reads.push(read());
            await vi.waitFor(() => expect(home.requestsFor(path)).toHaveLength(4));
            // Join invalidation is not evidence of a committed domain change.
            expect(changes).toEqual([]);
            heldReads.resolve();
            await expect(Promise.all(reads)).resolves.toEqual([
                { status: 'deleted', revision: 3 }, { status: 'deleted', revision: 3 }, { status: 'deleted', revision: 4 },
            ]);
        } finally {
            heldReads.resolve(); heldWrite.resolve(); await Promise.allSettled([...reads, write]);
            unsubscribe(); context.dispose(); await home.reset();
        }
    });

    it.each(['configurations', 'purposes'] as const)('shares the admitted %s row without sharing caller cancellation or mutation witnesses', async key => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Connected row readers', serverUrl: `https://connected-row-${key}.test`,
            accountId: 'connected-row-reader', currentAccount: true });
        const path = `/v1/account/entity-rows/connected-accounts/${key}`;
        const held = createDeferred<void>();
        let physicalSignal: AbortSignal | null | undefined;
        home.answer(serverId, `GET ${path}`, { select: (_input, request) => {
            physicalSignal = request.signal;
            return { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } };
        } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readAdmittedConnectedAccountCatalogInContext, readConnectedAccountCatalogRowInContext,
            readConnectedAccountCatalogForMutationInContext, writeConnectedAccountCatalogRecordInContext } = await import('@/sync/api/account/apiConnectedAccountCatalog');
        const abort = new AbortController();
        const first = await captureLazyActionAccountContext(serverId, abort.signal);
        const second = await captureLazyActionAccountContext(serverId);
        let firstRead: Promise<unknown> | undefined;
        let secondRead: Promise<unknown> | undefined;
        try {
            await Promise.all([first.resolveAccountEncryption(), second.resolveAccountEncryption()]);
            firstRead = readAdmittedConnectedAccountCatalogInContext(first, key);
            secondRead = readAdmittedConnectedAccountCatalogInContext(second, key);
            await vi.waitFor(() => expect(home.requestsFor(path).length).toBeGreaterThan(0));
            await flushHookEffects();
            expect(home.requestsFor(path)).toHaveLength(1);
            abort.abort();
            await expect(firstRead).resolves.toMatchObject({ status: 'unavailable' });
            expect(physicalSignal?.aborted).toBe(false);
            home.answer(serverId, `GET ${path}`, { body: { status: 'deleted', revision: 3 } });
            // Direct raw callers include exact Saved Secret reference censuses.
            await expect(readConnectedAccountCatalogRowInContext(second, key)).resolves.toEqual({ status: 'deleted', revision: 3 });
            await expect(readConnectedAccountCatalogForMutationInContext(second, key)).resolves.toMatchObject({ status: 'ready', revision: 3 });
            home.answer(serverId, `POST ${path}`, { body: { status: 'updated', revision: 4, cursor: 4 } });
            const record = key === 'purposes' ? { key, value: { v: 1 as const, bindings: [] } }
                : { key, value: { v: 1 as const, entries: [] } };
            await expect(writeConnectedAccountCatalogRecordInContext(second, { record, expectedRevision: 3 }))
                .resolves.toMatchObject({ status: 'updated', revision: 4 });
            home.answer(serverId, `GET ${path}`, { body: { status: 'deleted', revision: 4 } });
            await expect(readConnectedAccountCatalogRowInContext(second, key)).resolves.toEqual({ status: 'deleted', revision: 4 });
            held.resolve();
            await expect(secondRead).resolves.toMatchObject({ status: 'ready', revision: 3 });
        } finally {
            held.resolve(); await Promise.allSettled([firstRead, secondRead]);
            first.dispose(); second.dispose(); await home.reset();
        }
    });

    it('leaves opaque request callbacks independent and retries a strict rejected raw observation', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Strict metadata', serverUrl: 'https://metadata-read-strict.test',
            accountId: 'metadata-strict', currentAccount: true });
        const held = createDeferred<void>();
        home.answer(serverId, `GET ${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`, {
            respondAfter: held.promise, body: { status: 'deleted', revision: 3 },
        });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { apiReadConnectedPresentationRow } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const account = await captureLazyActionAccountContext(serverId);
        let opaque: Promise<unknown>[] = [];
        try {
            const captured = { request: account.request, isCurrent: account.accountLifetime.isCurrent };
            opaque = [apiReadConnectedPresentationRow(captured), apiReadConnectedPresentationRow(captured)];
            await vi.waitFor(() => expect(home.requestsFor(CONNECTED_PRESENTATION_ROWS_ROUTE_V1)).toHaveLength(2));
            held.resolve();
            await expect(Promise.all(opaque)).resolves.toEqual([{ status: 'deleted', revision: 3 }, { status: 'deleted', revision: 3 }]);
            const rejected = createDeferred<void>();
            home.answer(serverId, `GET ${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`, {
                respondAfter: rejected.promise, body: { status: 'deleted', revision: 3, foreign: true },
            });
            const neutral = { ...captured, readTransport: account.readTransport };
            const readings = [apiReadConnectedPresentationRow(neutral), apiReadConnectedPresentationRow(neutral)];
            const results = Promise.allSettled(readings);
            try {
                await vi.waitFor(() => expect(home.requestsFor(CONNECTED_PRESENTATION_ROWS_ROUTE_V1).length).toBeGreaterThan(2));
                await flushHookEffects();
                expect(home.requestsFor(CONNECTED_PRESENTATION_ROWS_ROUTE_V1)).toHaveLength(3);
            } finally { rejected.resolve(); }
            expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
            home.answer(serverId, `GET ${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`, { body: { status: 'deleted', revision: 4 } });
            const native = new AbortController();
            Object.defineProperty(native.signal, 'throwIfAborted', { value: undefined });
            await expect(apiReadConnectedPresentationRow(neutral, native.signal)).resolves.toEqual({ status: 'deleted', revision: 4 });
            expect(home.requestsFor(CONNECTED_PRESENTATION_ROWS_ROUTE_V1)).toHaveLength(4);
        } finally {
            held.resolve(); await Promise.allSettled(opaque); account.dispose(); await home.reset();
        }
    });

    it('shares only raw rows across independent callers and leaves the surviving caller admitted', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Metadata readers', serverUrl: 'https://metadata-readers.test',
            accountId: 'metadata-reader', currentAccount: true });
        const held = createDeferred<void>();
        let physicalSignal: AbortSignal | null | undefined;
        for (const route of [CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1]) {
            home.answer(serverId, `GET ${route}`, { select: (_input, request) => {
                physicalSignal = request.signal;
                return { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } };
            } });
        }
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readConnectedMetadataCatalogInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const abort = new AbortController();
        const first = await captureLazyActionAccountContext(serverId, abort.signal);
        const second = await captureLazyActionAccountContext(serverId);
        let firstRead: Promise<unknown> | undefined;
        let secondRead: Promise<unknown> | undefined;
        try {
            await Promise.all([first.resolveAccountEncryption(), second.resolveAccountEncryption()]);
            // No per-call signal: the Action invocation still owns this borrower's cancellation.
            firstRead = readConnectedMetadataCatalogInContext(first, undefined, undefined, false).catch(error => error);
            secondRead = readConnectedMetadataCatalogInContext(second, undefined, undefined, false);
            await vi.waitFor(() => expect(home.requestsFor(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1).length).toBeGreaterThan(0));
            await flushHookEffects();
            expect(home.requestsFor(CONNECTED_PRESENTATION_ROWS_ROUTE_V1)).toHaveLength(1);
            expect(home.requestsFor(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1)).toHaveLength(1);
            abort.abort();
            await expect(firstRead).resolves.toBeInstanceOf(Error);
            expect(physicalSignal?.aborted).toBe(false);
            held.resolve();
            await expect(secondRead).resolves.toMatchObject({ presentation: { status: 'ready', revision: 3 },
                acknowledgements: { status: 'ready', revision: 3 } });
        } finally {
            held.resolve();
            await Promise.allSettled([firstRead, secondRead]);
            first.dispose(); second.dispose(); await home.reset();
        }
    });

    it('retires a held raw transport on Account replacement without an explicit read signal', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Metadata retirement', serverUrl: 'https://metadata-read-retirement.test',
            accountId: 'metadata-original', currentAccount: true });
        const held = createDeferred<void>();
        const signals: (AbortSignal | null | undefined)[] = [];
        for (const route of [CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1]) {
            home.answer(serverId, `GET ${route}`, { select: (_input, request) => {
                signals.push(request.signal);
                return { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } };
            } });
        }
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readConnectedMetadataCatalogInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const account = await captureLazyActionAccountContext(serverId);
        let reading: Promise<unknown> | undefined;
        try {
            reading = readConnectedMetadataCatalogInContext(account, undefined, undefined, false).catch(error => error);
            await vi.waitFor(() => expect(signals).toHaveLength(2));
            await home.switchAccount(serverId, 'metadata-replacement');
            await vi.waitFor(() => expect(signals.every(signal => signal?.aborted)).toBe(true));
            // The server has not answered; settlement must come from retirement.
            await expect(reading).resolves.toBeInstanceOf(Error);
        } finally {
            held.resolve(); await Promise.allSettled([reading]); account.dispose(); await home.reset();
        }
    });

    it('does not borrow a pending pre-write row after an acknowledged metadata mutation', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Metadata receipt', serverUrl: 'https://metadata-read-receipt.test',
            accountId: 'metadata-receipt', currentAccount: true });
        const held = createDeferred<void>();
        let acknowledged = false;
        home.answer(serverId, `GET ${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`, { body: { status: 'deleted', revision: 3 } });
        home.answer(serverId, `GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { select: () => ({
            ...(acknowledged ? {} : { respondAfter: held.promise }), body: { status: 'deleted', revision: acknowledged ? 4 : 3 },
        }) });
        home.answer(serverId, `POST ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { select: () => {
            acknowledged = true;
            return { body: { status: 'updated', revision: 4, cursor: 4 } };
        } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { apiReadConnectedAcknowledgementsRow, setConnectedAcknowledgementInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const account = await captureLazyActionAccountContext(serverId);
        const captured = { request: account.request, isCurrent: account.accountLifetime.isCurrent, readTransport: account.readTransport };
        let incumbent: Promise<unknown> | undefined;
        let writing: Promise<void> | undefined;
        try {
            incumbent = apiReadConnectedAcknowledgementsRow(captured);
            await vi.waitFor(() => expect(home.requestsFor(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1)).toHaveLength(1));
            // This mutation needs its own fresh CAS baseline, while an unrelated
            // ordinary read still owns the held pre-write observation.
            home.answer(serverId, `GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { body: { status: 'deleted', revision: 3 } });
            writing = setConnectedAcknowledgementInContext(account, { subject: { kind: 'warning', warningId: 'receipt',
                scope: { kind: 'account' } }, acknowledged: true });
            await vi.waitFor(() => expect(acknowledged).toBe(true));
            await writing;
            home.answer(serverId, `GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { body: { status: 'deleted', revision: 4 } });
            await expect(apiReadConnectedAcknowledgementsRow(captured)).resolves.toEqual({ status: 'deleted', revision: 4 });
            held.resolve();
            await expect(incumbent).resolves.toEqual({ status: 'deleted', revision: 3 });
        } finally {
            held.resolve(); await Promise.allSettled([incumbent, writing]);
            account.dispose(); await home.reset();
        }
    });

    it('re-admits a read catalog over HTTP when no connection observation is admitted', async () => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Metadata authority', serverUrl: 'https://metadata-read-authority.test',
            accountId: 'metadata-authority', currentAccount: true });
        const held = createDeferred<void>();
        for (const route of [CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1]) {
            home.answer(serverId, `GET ${route}`, { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } });
        }
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { readConnectedMetadataCatalogInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
        const account = await captureLazyActionAccountContext(serverId);
        let reading: Promise<unknown> | undefined;
        try {
            reading = readConnectedMetadataCatalogInContext(account, undefined, undefined, false);
            const failure = expect(reading).rejects.toBeInstanceOf(Error);
            await vi.waitFor(() => expect(home.requestsFor(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1)).toHaveLength(1));
            home.answer(serverId, 'GET /v1/account/encryption/currentness', { status: 403, body: { error: 'forbidden' } });
            held.resolve();
            await failure;
        } finally {
            held.resolve(); await Promise.allSettled([reading]); account.dispose(); await home.reset();
        }
    });
});

describe('Connected metadata deletion receipt admission', () => {
    it.each([
        { status: 503, error: 'database_transaction_conflict_exhausted', expected: 'database_transaction_conflict_exhausted' },
        { status: 503, error: 'internal', expected: 'outcome_unknown' },
        { status: 500, error: 'database_transaction_conflict_exhausted', expected: 'outcome_unknown' },
    ])('preserves only the confirmed rollback witness for a pool DELETE ($status/$error)', async ({ status, error, expected }) => {
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        setRuntimeFetch(home.request);
        const serverId = await home.addHome({ name: 'Pool rollback', serverUrl: 'https://pool-rollback.test',
            accountId: 'pool-rollback-owner', currentAccount: true });
        const input = { group: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'own-pool' },
            expectedIncarnation: 'own-life', expectedGeneration: 1 };
        const deletion = buildQualifiedConnectedAccountGroupMutationRequestV4('delete', input);
        home.answer(serverId, `DELETE ${deletion.path}`, { status, body: { error, statusCode: status } });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { createUiConnectedServiceAction } = await import('./connectedServiceActionDeps');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const result = await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.pools.delete', input,
                context: { surface: 'ui', authority: 'present_user' } });
            expect(result).toMatchObject({ ok: false, errorCode: expected });
            expect(result).not.toHaveProperty('applied');
            expect(home.requestsFor(deletion.path)).toHaveLength(1);
        } finally { account.dispose(); await home.reset(); }
    });

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
            const result = await createUiConnectedServiceAction(account)({ actionId: 'connectedServices.pools.delete', input,
                context: { surface: 'ui', authority: 'present_user' } });
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
                const result = await invoke({ actionId: kind === 'member-delete' ? 'connectedServices.pools.members.remove' : 'connectedServices.pools.delete', input,
                    context: { surface: 'ui', authority: 'present_user' } });
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
