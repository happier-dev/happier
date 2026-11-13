import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readMachineProvisionerActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { standardCleanup } from '@/dev/testkit';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-vercel/src/manifest';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installApprovalCommonModuleMocks();
const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');
afterEach(standardCleanup);

it('reads installed guest diagnostics through the retained Account native Inspect path without allocation or pairing', async () => {
    const actionId = 'machines.managed.inspect';
    const { Modal } = await import('@/modal');
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
    onTestFinished(() => confirm.mockRestore());
    const homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    onTestFinished(() => homes.reset());
    const accountId = 'recovery-owner';
    const token = createAccountTokenForTests(accountId, { currentAccount: true });
    const credentials = { token };
    const serverUrl = 'https://account-recovery.example.test';
    const homeId = 'srv_account_recovery';
    const serverId = await homes.addHome({ name: 'Recovery', serverUrl, accountId, credentials,
        serverIdentityId: homeId, accountEncryptionMode: 'plain', credentialResourcesEnabled: true });
    await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }, source: 'manual' });
    homes.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse({
        features: { encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: homeId } },
    }) });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    const [provisioner] = manifest.contributes.machineProvisioners;
    if (!provisioner) throw new Error('Missing Vercel provisioner fixture');
    const provider = { pluginId: manifest.id, localId: provisioner.id };
    const selectedAccount = { service: { pluginId: provider.pluginId, localId: 'vercel-account' }, accountId: 'selected' };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
        purpose: { consumer: provider, purpose: 'cloud-api' }, account: selectedAccount,
    }] };
    let machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: accountId,
        enrollmentAccountId: accountId, enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, launch,
        enrolledMachineId: 'joined',
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
        resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
            retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
        packageName: '@fixture/compute', displayName: 'Cloud', normalizedManifest: manifest,
        hasMachineProvisioners: true, entriesById: projectPluginPortableUiDeclarationsV1(manifest, []) }]));
    const paths: string[] = [];
    const connection = await restoreServerAccountForTest({ serverUrl, accountId, credentials,
        configureSocket: configureConnectedServerSocketBoundary,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            if (path.endsWith('/actions/get')) return Response.json({ ...machine,
                resource: { ...machine.resource, value: { id: 'stale-public' } } });
            if (path.endsWith('/controller/context')) {
                expect(await new Response(init?.body).json()).toEqual({ homeId, managedId: machine.id, expectedIntentRevision: 2 });
                return Response.json({ machine, requestId: 'retained-creation' });
            }
            if (path.endsWith('/controller/report')) {
                const body = await new Response(init?.body).json();
                expect(body).toMatchObject({ requestId: 'retained-creation', result: { kind: 'bound', resource: machine.resource } });
                machine = ManagedMachineV1Schema.parse({ ...machine, observation: body.observation });
                return Response.json({ machine });
            }
            return homes.request(url, init);
        } });
    onTestFinished(() => connection.dispose());
    const account = await captureLazyActionAccountContext(serverId);
    onTestFinished(() => account.dispose());
    replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const input = { homeId, managedId: machine.id, includeGuestDiagnostics: true as const };
    const base: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionRequestId: 'new-recovery-review',
        runtimeAccountId: accountId };
    const roles: string[] = [];
    // Native role execution and Home HTTP are external effect boundaries. The
    // reviewed child port, reconciliation and diagnostic reader stay real.
    const context: ActionExecutorContext = { ...base, hostReviewedChild: createHostReviewedChildPortV1({ actionId, input, context: base,
        plan: { children: readMachineProvisionerActionRolesV1(provisioner).map(({ action, role }) => ({
            action: { pluginId: provider.pluginId, localId: action }, role })) },
        execute: async body => {
            if (!body || typeof body !== 'object' || !('action' in body) || !('input' in body)) throw new Error('Expected native role');
            const action = body.action;
            if (!action || typeof action !== 'object' || !('localId' in action)) throw new Error('Expected native identity');
            const role = readMachineProvisionerActionRolesV1(provisioner).find(candidate => candidate.action === action.localId)?.role;
            if (!role) throw new Error('Expected declared role');
            roles.push(role);
            if (role === 'inspect') {
                expect(body.input).toMatchObject({ resource: { id: 'same-native' } });
                return { ok: true, result: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } };
            }
            if (role !== 'exec' || !body.input || typeof body.input !== 'object' || !('argv' in body.input)
                || !Array.isArray(body.input.argv) || typeof body.input.argv[2] !== 'string') {
                throw new Error(`Unexpected native role ${role}`);
            }
            expect(body.input.argv.slice(0, 2)).toEqual(['sh', '-c']);
            const command = body.input.argv[2];
            expect(command).toContain("'doctor' '--json' '--include-daemon-log'");
            const stdout = JSON.stringify({
                daemonState: { pid: 1, httpPort: 1, startedAt: 1, startedWithCliVersion: 'guest-version', machineId: 'joined',
                    hasControlToken: true, daemonLogPath: null }, daemonLogs: [], doctorSnapshot: null, stackContext: null,
                runtime: { cwd: '', platform: 'linux', nodeVersion: '' },
                sessionDiagnostics: { context: { sessionId: '', metadataStatus: 'unavailable' }, logs: [{ kind: 'daemon', status: 'collected',
                    artifact: { filename: 'daemon.log', sourceKind: 'daemon', contentType: 'text/plain', content: 'browser guest diagnostic evidence' } }] },
            });
            return { ok: true, result: {
                stdoutBase64: encodeBase64(new TextEncoder().encode(stdout)), stderrBase64: '',
                stdoutTruncated: false, stderrTruncated: false,
                termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
            } };
        } }) };
    const result = await executeManagedMachineNativeAction({ account, actionId, input, context });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
        machine: { id: machine.id, observation: { power: 'running' } },
        guestDiagnostics: { status: 'collected', snapshot: { daemonState: { machineId: 'joined' }, sessionDiagnostics: { logs: [
            { status: 'collected', artifact: { content: 'browser guest diagnostic evidence' } },
        ] } } },
    } });
    expect(roles).toEqual(['inspect', 'exec']);
    expect(paths).not.toContain('/v1/auth/response');
    expect(roles).not.toContain('acquire');
    expect(paths.some(path => /admit|submit|operations|execution-authorization/.test(path))).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
});
