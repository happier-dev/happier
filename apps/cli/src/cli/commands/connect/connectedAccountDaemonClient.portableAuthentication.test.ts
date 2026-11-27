import { expect, it, vi } from 'vitest';
import { createConnectedAccountDaemonClient } from './connectedAccountDaemonClient';
import { createPortableConnectedAccountAuthenticationHttpFixture } from '@/testkit/connectedAccountAuthentication';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as daemonControl from '@/daemon/controlClient';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import * as persistence from '@/persistence';
import { resolveConnectNativeImportIntent } from './resolveConnectNativeImportIntent';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import * as sockets from '@/api/session/sockets';

it('keeps portable CLI approval custody local when its contextual Machine is not enrolled', async () => {
    const origin = 'http://cli-portable-approval.test';
    const accountId = 'portable-cli-approval-owner';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { accountId });
    // Retain the ordinary Ask policy rather than the direct-policy fixture's waiver.
    fixture.settings.actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1 });
    const credentials = { ...fixture.credentials, credentialProvenance: 'stored_session' as const,
        token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature` };
    // Socket transport is an external boundary. Its refusal must come from the
    // local approval publisher, before an effect, rather than Machine admission.
    const approvalSocket = vi.spyOn(sockets, 'createUserScopedSocketConnection').mockImplementation(() => {
        throw new Error('Approval socket is offline');
    });
    const credentialFiles = vi.spyOn(persistence, 'readCredentials').mockRejectedValue(new Error('No credential files in fixture'));
    const client = runWithServerHttpBaseUrl(origin, () => createConnectedAccountDaemonClient({
        credentials, serverId: fixture.serverId, serverHttpBaseUrl: origin, machineId: 'local-unenrolled-identity',
    }));
    try {
        await expect(client.authenticate({ operation: 'beginConnect', service: fixture.service, modeId: 'manual' }))
            .rejects.toMatchObject({ code: 'action_failed' });
        expect(approvalSocket).toHaveBeenCalled();
        expect(fixture.machineRequests).toBe(0);
        expect(fixture.promotedResourceCount).toBe(0);
        expect(fixture.directCredentialWrites).toBe(0);
    } finally {
        await client.dispose();
        approvalSocket.mockRestore();
        credentialFiles.mockRestore();
        await fixture.close();
    }
});

it.each([false, true])('completes authored Account manual sign-in without a Machine or daemon (required configuration: %s)', async requireAccountConfiguration => {
    const origin = 'http://cli-portable-authentication.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { requireAccountConfiguration });
    const daemon = vi.spyOn(daemonControl, 'readDaemonPluginCatalog').mockRejectedValue(new Error('No daemon in portable Account fixture'));
    const nativeRpc = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('No Machine in portable Account fixture'));
    // Credential-file IO is an OS boundary; this fixture supplies its own custody.
    const credentialFiles = vi.spyOn(persistence, 'readCredentials').mockRejectedValue(new Error('Credential files are unavailable in this fixture'));
    const client = runWithServerHttpBaseUrl(origin,
        () => createConnectedAccountDaemonClient({ credentials: fixture.credentials, serverId: fixture.serverId, serverHttpBaseUrl: origin }));
    try {
        let begun = await runWithServerHttpBaseUrl(origin, () => client.authenticate({ operation: 'beginConnect', service: fixture.service, modeId: 'manual' }))
            .catch((failure: unknown) => {
                const rawCode = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null;
                const code = typeof rawCode === 'string' && /^[a-z][a-z0-9_-]*$/.test(rawCode) ? rawCode : 'unclassified_failure';
                throw new Error(`CLI Account authentication Action refused: ${code}`);
            });
        if (requireAccountConfiguration) {
            expect(begun).toMatchObject({ status: 'configurationRequired', missingFieldIds: ['region'] });
            if (begun.status !== 'configurationRequired' || !begun.attemptId) throw new Error('Missing configuration attempt');
            const target = { kind: 'attempt' as const, attemptId: begun.attemptId };
            const current = await client.control({ operation: 'readConfiguration', target });
            expect(current).toMatchObject({ status: 'configuration', configuration: { missingFieldIds: ['region'] } });
            const replacement = await client.control({ operation: 'replaceConfiguration', target,
                expectedRevision: null, values: { region: 'fixture-region' }, secretValues: {} });
            expect(replacement.status).toBe('configurationCommitted');
            if (replacement.status !== 'configurationCommitted') throw new Error('Missing configuration commit');
            begun = await client.authenticate({ operation: 'continueConnect', attemptId: begun.attemptId,
                expectedConfigurationRevision: replacement.configuration.revision });
        }
        expect(begun).toMatchObject({ status: 'awaitingManual' });
        if (begun.status !== 'awaitingManual') throw new Error('Manual authentication did not request fields');
        // The retained client belongs to its captured Home, even when another
        // command changes the ambient Home before this continuation.
        const completed = await runWithServerHttpBaseUrl('http://other-cli-home.test', () => client.authenticate({ operation: 'submitManual', attemptId: begun.attemptId,
            fields: { token: 'portable-manual-fixture-token' } }));
        expect(completed, completed.status === 'unavailable' ? completed.code : completed.status)
            .toMatchObject({ status: 'connected', account: { service: fixture.service, accountId: 'example-account' } });
        const stored = await fixture.readCredential({ service: fixture.service, accountId: 'example-account' });
        expect(stored).not.toBeNull();
        if (!stored) throw new Error('Missing settled credential');
        expect(stored.metadata).not.toHaveProperty('authenticationProvenance');
        expect(JSON.stringify(stored)).not.toContain('portable-manual-fixture-token');
        expect((await fixture.reopenCredential(stored)).values).toEqual({ token: 'portable-manual-fixture-token' });
        expect(fixture.promotedResourceCount).toBe(1);
        expect(fixture.initialConfiguration === undefined).toBe(!requireAccountConfiguration);
        if (requireAccountConfiguration) expect(fixture.reopenInitialConfiguration()).toMatchObject({ values: { region: 'fixture-region' } });
        expect(fixture.directCredentialWrites).toBe(0);
        expect(fixture.machineRequests).toBe(0);
        expect(nativeRpc).not.toHaveBeenCalled();
        expect(daemon).not.toHaveBeenCalled();
        expect(credentialFiles).not.toHaveBeenCalled();
        expect(client).toHaveProperty('dispose', expect.any(Function));
        await client.dispose();
        await expect(client.authenticate({ operation: 'read', attemptId: begun.attemptId }))
            .rejects.toMatchObject({ name: 'AbortError' });
    } finally {
        // Cleanup must not mask the deciding pre-implementation failure.
        if ('dispose' in client && typeof client.dispose === 'function') await client.dispose();
        nativeRpc.mockRestore();
        daemon.mockRestore();
        credentialFiles.mockRestore();
        await fixture.close();
    }
});


it.each([undefined, 'native-import-machine'])('describes Codex native import through the real CLI host without activating Account authentication (Machine: %s)', async machineId => {
    const origin = 'http://cli-native-import-description.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { includeBundledPluginIds: ['happier.agent.codex'] });
    const nativeRpc = vi.fn(async () => { throw new Error('Service description must not require a Machine runtime'); });
    // Credential-file IO is an OS boundary; the signed-in fixture supplies custody.
    const credentialFiles = vi.spyOn(persistence, 'readCredentials').mockRejectedValue(new Error('No credential files in this fixture'));
    const client = runWithServerHttpBaseUrl(origin, () => createConnectedAccountDaemonClient({
        credentials: fixture.credentials, serverId: fixture.serverId, serverHttpBaseUrl: origin,
        ...(machineId ? { machineId } : {}), callMachineRpc: nativeRpc,
    }));
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    try {
        const described = await client.control({ operation: 'describeService', service });
        expect(described, described.status === 'unavailable' ? described.code : described.status)
            .toMatchObject({ status: 'described', service, accounts: [] });
        if (described.status !== 'described') throw new Error('Missing Codex service description');
        expect(resolveConnectNativeImportIntent(described.descriptor.authentication.modes, null))
            .toEqual({ modeId: 'native-import', fields: { source: 'native' } });
        expect(nativeRpc).not.toHaveBeenCalled();
        expect(fixture.machineRequests).toBe(0);
        expect(fixture.promotedResourceCount).toBe(0);
        expect(credentialFiles).not.toHaveBeenCalled();
    } finally {
        await client.dispose();
        credentialFiles.mockRestore();
        await fixture.close();
    }
});
