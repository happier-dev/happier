import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { createDeferred, createRenderCommitCounter, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { beginSavedSecretCatalogLoad, getSavedSecretCatalogSnapshot, invalidateSavedSecretCatalog, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;

beforeEach(() => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetTeamActionClientForTests();
});
afterEach(async () => {
    await standardCleanup();
    resetSavedSecretCatalogEngineForTests();
    await home?.dispose();
    home = null;
});

describe('useSavedSecretCatalog resource authority', () => {
    it('preserves typed causes without rerendering boolean-only readers', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { useSavedSecretCatalog, useSavedSecretCatalogError } = await import('./useSavedSecretCatalog');
        const { applySavedSecretCatalogFailure, applySavedSecretCatalogPage } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const scope = home.scope;
        const { entry } = await home.addOwnerResource();
        const catalog = await renderHook(() => useSavedSecretCatalog({ scope }));
        await act(async () => catalog.getCurrent().reload());
        await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)?.legacyImport).not.toBeNull());
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretsList } = await import('./SecretsList');
        const { resolveActionExecutionErrorMessage } = await import('@/sync/ops/actions/resolveActionExecutionFailureMessage');
        function Consumer() {
            const current = useSavedSecretCatalog({ scope });
            return React.createElement(SecretsList, { secrets: [], sharedCatalogError: current.errorCause,
                sharedCatalogStale: current.error, onRetrySharedCatalog: current.reload });
        }
        const screen = await renderScreen(React.createElement(Consumer));
        let renders = 0;
        const selectUnavailable = (error: unknown) => Boolean(error);
        const unavailable = await renderHook(() => { renders++; return useSavedSecretCatalogError({ scope }, selectUnavailable); });
        await act(async () => { applySavedSecretCatalogFailure({ scope, error: { kind: 'unknown', code: 'credential_unavailable', retryable: true } }); });
        expect(catalog.getCurrent().errorCause?.code).toBe('credential_unavailable');
        expect(unavailable.getCurrent()).toBe(true);
        expect(screen.getTextContent()).toContain(resolveActionExecutionErrorMessage(catalog.getCurrent().errorCause, 'missing cause'));
        const baseline = renders;
        await act(async () => { applySavedSecretCatalogFailure({ scope, error: { kind: 'forbidden', code: 'permission_denied', retryable: false } }); });
        expect(renders).toBe(baseline);
        await act(async () => { applySavedSecretCatalogPage({ scope, entries: [], observedAt: 123 }); });
        expect(unavailable.getCurrent()).toBe(false);
        const settled = renders;
        await act(async () => { applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 124 }); });
        expect(renders).toBe(settled);
    });

    it('lists recipient grants in Credentials without fetching secret material and follows withdrawal', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        await home.addOwnerResource();
        const { SavedSecretCatalogEntryV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
        const resource = home.resources[0];
        if (!resource || !('resourceId' in resource)) throw new Error('Expected healthy owner resource');
        const entry = SavedSecretCatalogEntryV1Schema.parse({ ...resource.entry,
            relationship: 'recipient', ownerAccountId: 'sharing-account',
            capabilities: { use: true, reveal: true, rename: false, rotate: false, manageAccess: false, delete: false },
        });
        home.resources[0] = { ...resource, entry };
        const { useCredentialsSecrets } = await import('@/components/settings/connectedServices/index/CredentialsSecretsGroup');
        const hook = await renderHook(() => useCredentialsSecrets());
        await act(async () => hook.getCurrent().retry());
        await vi.waitFor(() => expect(hook.getCurrent().entries).toEqual([entry]));
        expect(hook.getCurrent().state).toBe('ready');
        expect(home.request.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials')).toHaveLength(0);
        home.resources.splice(0);
        await act(async () => hook.getCurrent().retry());
        await vi.waitFor(() => expect(hook.getCurrent().state).toBe('empty'));
        expect(hook.getCurrent().entries).toEqual([]);
    });

    it('joins credential-held resources with their grants, typed material state and canonical Used by references', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const { AccountProfileSchema} = await import('@happier-dev/protocol/account/profile');
        const { SavedSecretCatalogEntryV1Schema, parseSavedSecretCatalogReferenceV1 } = await import('@happier-dev/protocol/account/settings/savedSecretCatalogV1');
        const { applySavedSecretCatalogPage } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { useConnectedAccountCredentialResources } = await import('@/hooks/server/connectedServices/useConnectedAccountCredentialResources');
        const { connectedEntitySubjectKeyV1 } = await import('@happier-dev/protocol/connect/connectedAccountPresentationSchemasV1');
        const resource = parseSavedSecretCatalogReferenceV1(entry.ref);
        if (resource?.kind !== 'shared_resource') throw new Error('Expected a resource fixture');
        const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
        const account = { service, accountId: 'work' };
        const profile = (ref: typeof account, savedSecretResourceIds: readonly string[]) => ({
            ref, displayName: `Credential ${ref.accountId}`, status: 'connected', authenticationModeId: 'api-key', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
            configurationRevision: null, savedSecretResourceIds,
        });
        storage.getState().applyProfile(AccountProfileSchema.parse({ id: home.scope.accountId, connectedAccountsV4: [
            profile(account, [resource.id]), profile({ service, accountId: 'backup' }, [resource.id]),
            profile({ service: { ...service, pluginId: 'other.plugin' }, accountId: 'work' }, ['other-resource']),
        ] }));
        const hook = await renderHook(() => useConnectedAccountCredentialResources(account));
        const projected = SavedSecretCatalogEntryV1Schema.parse({ ...entry, materialStatus: 'update_required',
            audience: { accounts: [], teams: [{ kind: 'team', teamId: 'team-a', name: 'Team A' }], groups: [] },
        });
        await act(async () => applySavedSecretCatalogPage({ scope: home!.scope, entries: [projected], observedAt: 1 }));
        expect(hook.getCurrent().resources).toHaveLength(1);
        expect(hook.getCurrent().resources[0]).toMatchObject({ resourceId: resource.id, ref: entry.ref,
            entry: { materialStatus: 'update_required', audience: projected.audience },
            usedBy: [{ account, reference: { owner: 'connectedAccountCredential',
                referrer: { kind: 'connectedAccountCredential', id: connectedEntitySubjectKeyV1({ kind: 'account', account }), displayName: 'Credential work' } } },
                { account: { service, accountId: 'backup' }, reference: { owner: 'connectedAccountCredential',
                    referrer: { kind: 'connectedAccountCredential',
                        id: connectedEntitySubjectKeyV1({ kind: 'account', account: { service, accountId: 'backup' } }), displayName: 'Credential backup' } } }],
        });
        expect(home.request.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials')).toHaveLength(0);
    });

    it('selects credential metadata by reference and ignores unrelated resource changes without loading material', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const { useSavedSecretCatalogEntries } = await import('./useSavedSecretCatalog');
        const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        const { applySavedSecretCatalogPage } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useSavedSecretCatalogEntries({ scope: home!.scope, refs: [entry.ref] });
        });
        await act(async () => refreshSavedSecretCatalog(home!.scope, { includeMaterial: false }));
        const other = { ...entry, ref: 'happier:shared-secret:v1:other-resource' };
        await act(async () => applySavedSecretCatalogPage({ scope: home!.scope, entries: [entry, other], observedAt: 1 }));
        expect(hook.getCurrent()).toEqual([entry]);
        counter.reset();
        await act(async () => applySavedSecretCatalogPage({ scope: home!.scope,
            entries: [entry, { ...other, name: 'Unrelated rename', revision: 2 }], observedAt: 2 }));
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => applySavedSecretCatalogPage({ scope: home!.scope,
            entries: [{ ...entry, materialStatus: 'update_required' }, other], observedAt: 3 }));
        expect(hook.getCurrent()).toEqual([{ ...entry, materialStatus: 'update_required' }]);
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        expect(home.request.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials')).toHaveLength(0);
    });

    it('keeps a mounted exact name idle across unrelated publications and follows rename and withdrawal', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        if (entry.materialStatus !== 'ready' || entry.revision === null) {
            throw new Error('Expected a ready owner-resource fixture with a known revision');
        }
        const renamedRevision = entry.revision + 1;
        const { useSavedSecretCatalogName } = await import('./useSavedSecretCatalog');
        const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        const { applySavedSecretCatalogPage, applyAcknowledgedSavedSecretCatalogEntry,
            removeDeletedSavedSecretCatalogResource } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useSavedSecretCatalogName(entry.ref, home!.scope);
        });
        await act(async () => refreshSavedSecretCatalog(home!.scope, { includeMaterial: false }));
        // Constructed scale; the selected row came through the real Home HTTP/catalog loader.
        const entries = [...Array.from({ length: 3006 }, (_, index) => ({ ...entry,
            ref: `happier:shared-secret:v1:unrelated-${index}` })), entry];
        await act(async () => applySavedSecretCatalogPage({ scope: home!.scope, entries, observedAt: 1 }));
        counter.reset();
        await act(async () => {
            for (let observedAt = 2; observedAt < 12; observedAt += 1) {
                applySavedSecretCatalogPage({ scope: home!.scope, entries, observedAt });
            }
            applySavedSecretCatalogPage({ scope: home!.scope, entries: entries.map((row, index) => index === 0
                ? { ...row, name: 'Unrelated name', revision: 2 } : row), observedAt: 12 });
            applySavedSecretCatalogPage({ scope: { ...home!.scope, serverId: 'other-home' }, entries, observedAt: 12 });
        });
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => applyAcknowledgedSavedSecretCatalogEntry(home!.scope,
            { ...entry, name: 'Renamed key', revision: renamedRevision }, true));
        expect(hook.getCurrent()).toEqual({ status: 'ready', name: 'Renamed key', resolving: false });
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        await act(async () => removeDeletedSavedSecretCatalogResource(home!.scope,
            entry.ref.slice('happier:shared-secret:v1:'.length), renamedRevision));
        expect(hook.getCurrent()).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'reference_unavailable', retryable: false } });
        expect(counter.read()).toEqual({ renders: 2, commits: 2 });
    });

    it('reads metadata without bodies for reference demand and preserves a material consumer joining the same catalog', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const metadata = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope, includeMaterial: false }));
        await act(async () => metadata.getCurrent().reload());
        const materialReads = () => home!.request.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials').length;
        expect(metadata.getCurrent().entries.map(row => row.ref)).toEqual([entry.ref]);
        expect(metadata.getCurrent().materializedSecrets).toEqual([]);
        expect(materialReads()).toBe(0);

        const material = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await vi.waitFor(() => expect(material.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]));
        expect(materialReads()).toBeGreaterThan(0);
        expect(metadata.getCurrent().materializedSecrets).toEqual([]);
        expect(metadata.getCurrent().resolveReference(entry.ref)).toMatchObject({ status: 'ready', secret: null });
        await material.unmount();
        const before = materialReads();
        await act(async () => metadata.getCurrent().reload());
        expect(metadata.getCurrent().entries.map(row => row.ref)).toEqual([entry.ref]);
        expect(metadata.getCurrent().materializedSecrets).toEqual([]);
        expect(materialReads() - before).toBe(0);
        await metadata.unmount();
    });
    it('honors waived private-secret deletion without a caller confirmation', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [],
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'secrets.delete': ['ui'] } }),
        }) });
        const { entry } = await home.addOwnerResource();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        const secret = hook.getCurrent().usableSecrets.find(secret => secret.id === entry.ref)!;
        expect(secret).toBeDefined();
        await act(async () => { expect(await hook.getCurrent().personalMutations.delete(secret)).toBe(true); });
        expect(home.deletes).toHaveLength(1);
        expect(Modal.confirm).not.toHaveBeenCalled();
    });
    it('preserves the admitted material read when an equivalent Account scope object is replaced', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const firstReadStarted = createDeferred<void>();
        const firstRead = createDeferred<void>();
        const replacementRead = createDeferred<void>();
        const request = home.request.getMockImplementation();
        if (!request) throw new Error('Account HTTP boundary is missing');
        let materialReads = 0;
        home.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v1/account/saved-secrets/resources/materials') {
                materialReads += 1;
                if (materialReads === 1) {
                    firstReadStarted.resolve();
                    await firstRead.promise;
                } else {
                    await replacementRead.promise;
                }
            }
            return request(input, init);
        });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const scope = home.scope;
        const hook = await renderHook(({ scope }) => useSavedSecretCatalog({ scope }), { initialProps: { scope } });
        try {
            await firstReadStarted.promise;
            await hook.rerender({ scope: { ...scope } });
            await act(async () => { firstRead.resolve(); });
            await vi.waitFor(() => expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]));
            const material = hook.getCurrent().materializedSecrets;
            expect(material).toHaveLength(1);
            await act(async () => { beginSavedSecretCatalogLoad(scope); });
            expect(hook.getCurrent().status).toBe('refreshing');
            expect(hook.getCurrent().materializedSecrets).toBe(material);
            expect(hook.getCurrent().resolveReference(entry.ref)).toMatchObject({ status: 'ready', secret: material[0] });
            await act(async () => { invalidateSavedSecretCatalog(scope); });
            expect(hook.getCurrent().materializedSecrets).toEqual([]);
            expect(hook.getCurrent().usableSecrets).toEqual([]);
            expect(hook.getCurrent().resolveReference(entry.ref).secret).toBeNull();
        } finally {
            firstRead.resolve();
            replacementRead.resolve();
            await hook.unmount();
        }
    });

    it.each([
        ['private', { accounts: [], teams: [], groups: [] }, true, true],
        ['shared', { accounts: [], teams: [{ kind: 'team', teamId: 'team-a', name: 'Research' }], groups: [] }, false, true],
        ['unknown audience', null, false, true],
        ['private material without use authority', { accounts: [], teams: [], groups: [] }, false, false],
    ] as const)('keeps the full catalog and projects mutation rows only for an active private resource: %s', async (_kind, audience, privateRow, canUse) => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const resource = home.resources[0];
        if (!resource || !('resourceId' in resource)) throw new Error('Missing owner resource');
        home.resources[0] = SavedSecretResourceMaterialV1Schema.parse({ ...resource,
            entry: { ...entry, audience, capabilities: { ...entry.capabilities, use: canUse } } });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        expect(hook.getCurrent().entries.map(row => row.ref)).toEqual([entry.ref]);
        expect(hook.getCurrent().personalSecrets.map(secret => secret.id)).toEqual(privateRow ? [entry.ref] : []);
        expect(hook.getCurrent().sharedEntries.map(row => row.ref)).toEqual(privateRow ? [] : [entry.ref]);
        expect(hook.getCurrent().picker.personalSecrets.map(secret => secret.id)).toEqual(privateRow ? [entry.ref] : []);
        expect(hook.getCurrent().picker.sharedEntries.map(row => row.ref)).toEqual(privateRow ? [] : [entry.ref]);
        if (!canUse) {
            expect(hook.getCurrent().materializedSecrets.map(secret => secret.id)).toEqual([entry.ref]);
            expect(hook.getCurrent().usableSecrets).toEqual([]);
            expect(hook.getCurrent().resolveReference(entry.ref).status).toBe('temporarily_unavailable');
        }
        if (privateRow) {
            const secret = hook.getCurrent().picker.personalSecrets[0]!;
            await act(async () => {
                expect(await hook.getCurrent().personalMutations.rename(secret, 'Renamed private resource')).toBe(true);
            });
            expect(home.updates).toHaveLength(1);
            // The catalog remains addressable, but the newly focused Home cannot authorize its mutations.
            const { storage } = await import('@/sync/domains/state/storage');
            await act(async () => { storage.setState({ settingsScope: null }); });
            expect(hook.getCurrent().picker.personalSecrets).toEqual([]);
            expect(hook.getCurrent().picker.sharedEntries.map(row => row.ref)).toEqual([entry.ref]);
            await act(async () => {
                expect(await hook.getCurrent().personalMutations.rotate(secret, 'must-not-write')).toBe(false);
            });
            expect(home.updates).toHaveLength(1);
        } else if (_kind === 'shared') {
            const { Modal } = await import('@/modal');
            vi.mocked(Modal.confirm).mockClear();
            await act(async () => {
                const result = await hook.getCurrent().updateResource({ resourceId: resource.resourceId,
                    expectedRevision: entry.revision!, nextName: 'Shared rename', decryptDataKeyEnvelope: async () => null });
                expect(result.ok).toBe(true);
            });
            // A reversible rename uses canonical Action admission; it has no
            // extra caller confirmation (OWNER-RULINGS 2026-10-16).
            expect(Modal.confirm).not.toHaveBeenCalled();
            expect(home.updates).toHaveLength(1);
        }
        expect(home.settingsWrites).toEqual([]);
    });
    it('converts a private resource source through the same catalog update owner and revision', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource('plain');
        const resource = home.resources[0];
        if (!resource || !('resourceId' in resource)) throw new Error('Missing owner resource');
        home.resources[0] = SavedSecretResourceMaterialV1Schema.parse({ ...resource,
            entry: { ...entry, audience: { accounts: [], teams: [], groups: [] } } });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        const source = { kind: 'external' as const, contribution: { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' },
            account: 'vault-account', reference: 'op://vault/item/password' };
        await act(async () => {
            expect(await hook.getCurrent().updateResource({ resourceId: resource.resourceId, expectedRevision: entry.revision!,
                nextSource: source, decryptDataKeyEnvelope: async () => null })).toEqual({ ok: true });
        });
        expect(home.updates).toHaveLength(1);
        expect(home.updates[0]).toMatchObject({ resourceId: resource.resourceId, expectedRevision: entry.revision });
        const updated = home.resources[0];
        if (!updated || !('resourceId' in updated) || !updated.storedContent) throw new Error('Missing updated material');
        expect(openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', storedContent: updated.storedContent }))
            .toMatchObject({ v: 2, source });
        expect(home.settingsWrites).toEqual([]);
    });
    it('keeps private resource selection and personal Actions available while Teams sharing is disabled', async () => {
        home = await createSecretSettingsTestHarness({ sharedEnabled: false, settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope, sharedEnabled: false }));
        await act(async () => hook.getCurrent().reload());
        expect(hook.getCurrent().sharedEnabled).toBe(false);
        expect(hook.getCurrent().entries.map(row => row.ref)).toEqual([entry.ref]);
        expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]);
        expect(hook.getCurrent().personalMutationsAvailable).toBe(true);
        let ref: string | null = null;
        await act(async () => { ref = await hook.getCurrent().personalMutations.create({ name: 'Private without Teams', value: 'private-no-teams-value' }); });
        expect(ref).toMatch(/^happier:shared-secret:v1:/);
        expect(home.creations).toMatchObject([{ accountGrants: [], teamGrants: [], groupGrants: [] }]);
        expect(home.settingsWrites).toEqual([]);
    });
    it.each(['plain','e2ee'] as const)('uses personal Actions over private resources with revision conflict and no Settings writer: %s',async mode=>{
        home=await createSecretSettingsTestHarness({mode,settings:settingsParse({secrets:[]})});
        const {createDefaultActionExecutor}=await import('@/sync/ops/actions/defaultActionExecutor');
        const executor=createDefaultActionExecutor();
        const {PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1}=await import('@happier-dev/protocol/account/settings/personalSavedSecretActionsV1');
        const {useSavedSecretCatalog}=await import('./useSavedSecretCatalog');
        const hook=await renderHook(()=>useSavedSecretCatalog({scope:home!.scope}));
        await act(async()=>hook.getCurrent().reload());
        let ref:string|null=null;
        await act(async()=>{ref=await hook.getCurrent().personalMutations.create({name:'Registry private',value:'private-producer-value'});});
        expect(ref).toMatch(/^happier:shared-secret:v1:/);
        const resource=home.resources.find(resource=>'resourceId'in resource&&resource.entry.ref===ref);
        if(!resource||!('resourceId'in resource))throw new Error('Expected private resource producer');
        expect(resource.storedContent?.t).toBe(mode==='plain'?'plain':'encrypted');
        if(mode==='e2ee')expect(JSON.stringify(resource.storedContent)).not.toContain('private-producer-value');
        expect(resource.entry.audience).toEqual({accounts:[],teams:[],groups:[]});
        expect(home.creations).toMatchObject([{accountGrants:[],teamGrants:[],groupGrants:[]}]);
        const listed=await executor.execute('secrets.list',{}, {surface:'ui',authority:'present_user',serverId:home.scope.serverId,expectedAccountId:home.scope.accountId});
        if(!listed.ok)throw new Error(listed.error);
        const metadata=PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].parse(listed.result);
        expect(metadata.secrets).toContainEqual({secretId:resource.resourceId,secretRef:resource.entry.ref,name:'Registry private',kind:'apiKey',updatedAt:1});
        expect(JSON.stringify(listed)).not.toContain('private-producer-value');
        const update=await executor.execute('secrets.update',{secretId:resource.resourceId,name:'Renamed private',expectedUpdatedAt:1},
            {surface:'ui',authority:'present_user',serverId:home.scope.serverId,expectedAccountId:home.scope.accountId});
        expect(update).toMatchObject({ok:true,result:{secretId:resource.resourceId,updatedAt:2}});
        const stale=await executor.execute('secrets.update',{secretId:resource.resourceId,value:'never-written',expectedUpdatedAt:1},
            {surface:'ui',authority:'present_user',serverId:home.scope.serverId,expectedAccountId:home.scope.accountId});
        expect(stale).toMatchObject({ok:false,errorCode:'revision_conflict'});
        expect(home.updates).toHaveLength(1);
        expect(home.settingsWrites).toEqual([]);
    });
    it('settles personal creation while the acknowledged material refresh is pending', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'secrets.shared.create': ['ui'] },
            }),
        }) });
        const { SharedSavedSecretCreateInputV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretResourceActionsV1');
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        const revalidation = createDeferred<void>();
        const request = home.request.getMockImplementation()!;
        let acknowledgedRef: string | null = null;
        home.request.mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/saved-secrets/resources' && init?.method === 'POST') {
                const created = SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(String(init?.body)));
                acknowledgedRef = `happier:shared-secret:v1:${created.resourceId}`;
                return Response.json({ resourceId: created.resourceId, revision: 1 });
            }
            if (path === '/v1/account/saved-secrets/resources/materials' && acknowledgedRef !== null) await revalidation.promise;
            return request(input, init);
        });
        let settled = false;
        let operation!: Promise<string | null>;
        await act(async () => {
            operation = hook.getCurrent().personalMutations.create({ name: 'Acknowledged key', value: 'value' }).then(result => {
                settled = true;
                return result;
            });
        });
        try {
            await vi.waitFor(() => expect(acknowledgedRef).not.toBeNull());
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
            expect(hook.getCurrent().entries.find(row => row.ref === acknowledgedRef)).toMatchObject({ name: 'Acknowledged key' });
        } finally {
            await act(async () => { revalidation.resolve(); await operation; });
        }
    });

    it('settles personal rename while the acknowledged material refresh is pending', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'secrets.shared.update': ['ui'] },
            }),
        }) });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const { entry } = await home.addOwnerResource();
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        const secret = hook.getCurrent().usableSecrets.find(secret => secret.id === entry.ref);
        expect(secret).toBeDefined();
        if (!secret) throw new Error('Expected an admitted owner resource');
        const revalidation = createDeferred<void>();
        const request = home.request.getMockImplementation()!;
        home.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v1/account/saved-secrets/resources/materials'
                && home!.updates.length > 0) await revalidation.promise;
            return request(input, init);
        });
        let settled = false;
        let operation!: Promise<boolean>;
        await act(async () => {
            operation = hook.getCurrent().personalMutations.rename(secret, 'Acknowledged name').then(result => {
                settled = true;
                return result;
            });
        });
        try {
            await vi.waitFor(() => expect(home!.updates).toHaveLength(1));
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
            expect(hook.getCurrent().entries.find(row => row.ref === entry.ref)).toMatchObject({ name: 'Acknowledged name', revision: entry.revision! + 1 });
        } finally {
            await act(async () => { revalidation.resolve(); await operation; });
        }
    });

    // Private creation, Teams-off selection and collision import are exercised
    // through real HTTP/Action owners in savedSecretResourceOperations.test.ts.
    it('does not project caller-supplied legacy Settings values while private resource ownership stays available', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        // Match the app entry: restore the canonical Sync singleton before its consumers load.
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const scope = home.scope;
        const hook = await renderHook(() => useSavedSecretCatalog({ scope, sharedEnabled: false,
            personalSecrets: [{ id: 'legacy-personal', name: 'Legacy token', kind: 'token',
                encryptedValue: { _isSecretValue: true, value: 'legacy-value' }, createdAt: 1, updatedAt: 1 }],
        }));
        await hook.getCurrent().reload();

        expect(hook.getCurrent().usableSecrets).toEqual([]);
        expect(hook.getCurrent().personalSecrets).toEqual([]);
        expect(hook.getCurrent().personalMutationsAvailable).toBe(true);
        expect(hook.getCurrent().resolveReference('legacy-personal')).toMatchObject({ status: 'deleted', secret: null });
        expect(hook.getCurrent().resolveReference('happier:shared-secret:v1:resource-a')).toMatchObject({
            kind: 'shared_resource', status: 'access_removed', secret: null, revision: null,
        });
        expect(home.request.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials')).toBe(true);
    });

    it('keeps always-mounted reference readers idle across catalog lifecycle and follows a catch-up through the real loader', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        const { entry } = await home.addOwnerResource();
        const resource = home.resources[0];
        if (!resource || !('resourceId' in resource)) throw new Error('Missing owner resource');
        home.resources[0] = SavedSecretResourceMaterialV1Schema.parse({ ...resource,
            entry: { ...entry, audience: { accounts: [], teams: [], groups: [] } } });
        const { useSavedSecretReferenceResolver, useSavedSecretCatalogPersonalSecrets } = await import('./useSavedSecretCatalog');
        const { invalidateSavedSecretCatalogProjection } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        const scope = home.scope;
        const unused = createRenderCommitCounter();
        const selected = createRenderCommitCounter();
        const personal = createRenderCommitCounter();
        // A runtime with no Saved Secret bound resolves nothing during render.
        const unusedReader = await renderHook(() => {
            useRenderCommitCounter(unused);
            return useSavedSecretReferenceResolver({ scope });
        });
        const selectedReader = await renderHook(() => {
            useRenderCommitCounter(selected);
            return useSavedSecretReferenceResolver({ scope }).resolve(entry.ref);
        });
        const personalReader = await renderHook(() => {
            useRenderCommitCounter(personal);
            return useSavedSecretCatalogPersonalSecrets({ scope });
        });
        await vi.waitFor(() => expect(selectedReader.getCurrent()).toMatchObject({ status: 'ready', secret: { id: entry.ref } }));
        await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)?.legacyImport).not.toBeNull());
        expect(personalReader.getCurrent().map(secret => secret.id)).toEqual([entry.ref]);
        const idleResolver = unusedReader.getCurrent();
        const selectedResolution = selectedReader.getCurrent();
        const personalSecrets = personalReader.getCurrent();
        for (const counter of [unused, selected, personal]) counter.reset();

        // Lifecycle only: the admitted material stays current while a read is in flight.
        await act(async () => beginSavedSecretCatalogLoad(scope));
        expect(getSavedSecretCatalogSnapshot(scope)?.status).toBe('refreshing');
        for (const counter of [unused, selected, personal]) expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(selectedReader.getCurrent()).toBe(selectedResolution);
        expect(personalReader.getCurrent()).toBe(personalSecrets);

        // An Account-change catch-up withdraws then re-admits material through the real HTTP loader.
        await act(async () => invalidateSavedSecretCatalogProjection(scope));
        await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', stale: false }));
        expect(unused.read()).toEqual({ renders: 0, commits: 0 });
        expect(unusedReader.getCurrent()).toBe(idleResolver);
        expect(selectedReader.getCurrent()).toMatchObject({ status: 'ready', secret: { id: entry.ref } });
        expect(personalReader.getCurrent().map(secret => secret.id)).toEqual([entry.ref]);
        await act(async () => invalidateSavedSecretCatalog(scope));
        expect(selectedReader.getCurrent()).toMatchObject({ status: 'temporarily_unavailable', secret: null });
        expect(personalReader.getCurrent()).toEqual([]);
        expect(unused.read()).toEqual({ renders: 0, commits: 0 });
    });

    it('keeps healthy material selectable beside a corrupt row and reconciles its owner repair', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'secrets.shared.delete': ['ui'] },
            }),
        }) });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const { entry } = await home.addOwnerResource();
        const corrupt = SavedSecretResourceMaterialV1Schema.parse({ entry: {
            materialStatus: 'resource_corrupt', relationship: 'owner',
            repair: { kind: 'delete_resource', resourceId: 'opaque-row-id', expectedRevision: -3 },
        } });
        if ('resourceId' in corrupt || corrupt.entry.relationship !== 'owner') throw new Error('Expected an owner repair fixture');
        const corruptEntry = corrupt.entry;
        home.resources.push(corrupt);
        const scope = home.scope;
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useSavedSecretCatalog({ scope }); });
        await act(async () => hook.getCurrent().reload());
        await vi.waitFor(() => expect(hook.getCurrent().corruptEntries).toEqual([corruptEntry]));
        expect(hook.getCurrent().entries.map(row => row.ref)).toEqual([entry.ref]);
        expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]);

        const repair = hook.getCurrent().deleteCorruptResource;
        // The finite reload resolves its usable foreground before legacy-import
        // maintenance publishes. Measure unrelated Settings only once that
        // independently owned catalog publication has settled.
        await vi.waitFor(() => expect(getSavedSecretCatalogSnapshot(scope)?.legacyImport).not.toBeNull());
        const baseline = renders;
        const currentSettings = home.persistedSettings;
        for (let version = 2; version <= 21; version += 1) {
            await act(async () => { home!.replaceSettings(currentSettings, { version }); });
        }
        expect(renders - baseline).toBe(0);
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => { storage.setState({ settingsScope: { ...scope, accountId: 'another-account' } }); });
        expect(await repair(corruptEntry)).toEqual({ ok: false, reason: 'unavailable' });
        expect(home.deletes).toEqual([]);
        await act(async () => { storage.setState({ settingsScope: scope }); });
        await act(async () => {
            const result = await repair(corruptEntry);
            // Keep failures attributable to their real HTTP boundary without
            // printing bodies, credentials or Saved Secret material.
            const boundary = !result.ok ? await Promise.all(home!.request.mock.calls.map(async ([url, init], index) => {
                const response = home!.request.mock.results[index];
                return { path: new URL(String(url)).pathname, method: init?.method ?? 'GET',
                    status: response?.type === 'return' ? (await response.value).status : response?.type };
            })) : [];
            expect(result, JSON.stringify(boundary)).toEqual({ ok: true });
        });
        expect(home.deletes).toEqual([expect.objectContaining({
            resourceId: 'opaque-row-id', expectedRevision: -3, expectedSettingsVersion: 21,
            referenceCensus: expect.objectContaining({ notificationChannels: { revision: 'absent', resourceRefs: [] } }),
        })]);
        await vi.waitFor(() => expect(hook.getCurrent().corruptEntries).toEqual([]));
        await vi.waitFor(() => expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]));
    });
});
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
