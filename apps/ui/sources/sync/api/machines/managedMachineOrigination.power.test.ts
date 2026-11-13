import { executeManagedAccountPowerOutputScenario } from '@/dev/testkit/machineAccountOutputContractFixture';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readRuntimeFetchHost, resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { standardCleanup } from '@/dev/testkit';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-vercel/src/manifest';
import { Modal } from '@/modal';
import { log } from '@/log';

const vendorHttp = vi.hoisted(() => vi.fn<typeof fetch>());
const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vendorHttp }));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Only packaged inventory and asset IO are replaced; compilation, public
// activation, selected-purpose resolution and authentication stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({
    localUri: `file:///managed-power-fixture/${asset}`, downloadAsync: async () => {},
}) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads++;
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing packaged power fixture');
        return bytes;
    }
} }));

installApprovalCommonModuleMocks();
const { executeManagedMachineNativeAction } = await import('./managedMachineOrigination');
const { prepareAuthenticationInventory } = await import('@/dev/testkit/fixtures/connectedAccountAuthentication');
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/manifest.ts',
    additionalArtifacts: [{ target: { artifactId: 'connected-account-authentication', exportName: 'activate' },
        entryPath: 'packages/plugins/machine-vercel/src/account.ts' }],
    packageName: '@happier-dev/plugins-machine-vercel' });
afterEach(async () => {
    await (await import('@/components/plugins/reactNative/clientExecutableContributions'))
        .getInstalledPluginUiClientExecutableComposition().unload();
    await standardCleanup();
});

describe('Account native power through the original reviewed role port', () => {
    it.each(['confirmed', 'refused', 'unknown', 'inspect-unavailable', 'after-idle', 'delayed'] as const)('uses one admitted retained intent, outcome=%s', async outcome => {
        const refused = outcome === 'refused';
        const homeId = `srv_native_power_${outcome}`;
        const serverUrl = `https://native-power-${outcome}.example.test`;
        const accountId = 'owner';
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64')}.signature`;
        await upsertAndActivateServer({ serverUrl });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token });
        const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
        const provisioner = manifest.contributes.machineProvisioners[0]!;
        const provider = { pluginId: manifest.id, localId: provisioner.id };
        const selectedAccount = { service: { pluginId: provider.pluginId, localId: 'vercel-account' }, accountId: 'selected' };
        const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
            purpose: { consumer: provider, purpose: 'cloud-api' }, account: selectedAccount,
        }] };
        let machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: accountId,
            launch, allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 2,
            resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
        });
        const input = outcome === 'after-idle'
            ? { homeId, managedId: machine.id, when: 'after-idle' as const, intent: 'stop' as const }
            : { homeId, managedId: machine.id, expectedRevision: machine.intentRevision, when: 'now' as const, intent: 'start' as const };
        const paths: string[] = [];
        const native: string[] = [];
        let inspections = 0;
        // Home HTTP and the provider role effect are system boundaries. Parsing,
        // retained control and reviewed-child custody use their real owners.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            // A foreign public row read is refused; power authority comes from
            // the canonical admission, which must return managed_power_required.
            if (path.endsWith('/actions/get')) return refused
                ? Response.json({ code: 'permission_denied' }, { status: 403 })
                : Response.json({ ...machine, resource: { ...machine.resource, value: { id: 'stale-before-admission' } } });
            if (path.endsWith('/admit-control')) {
                if (refused) return Response.json({ code: 'managed_power_required' }, { status: 403 });
                machine = { ...machine, desired: input.intent, desiredWhen: input.when, intentRevision: 3 };
                return Response.json({ machine, replayed: false });
            }
            if (path.endsWith('/submit-intent')) return Response.json({ machine, submitted: true });
            if (path.endsWith('/report-intent')) {
                const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
                expect(body).toMatchObject({ expectedIntentRevision: 3, requestId: 'original-power',
                    result: { kind: outcome === 'unknown' ? 'unknown' : 'confirmed' } });
                if (outcome === 'delayed') expect(body).toMatchObject({ observation: {
                    observedAt: 30, availability: 'present', power: 'running', storage: 'retained',
                } });
                if (outcome === 'inspect-unavailable') expect(body).not.toHaveProperty('observation');
                else machine = { ...machine, observation: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } };
                return Response.json({ machine });
            }
            throw new Error(`Unexpected HTTP path ${path}`);
        });
        onTestFinished(resetRuntimeFetch);
        const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionRequestId: 'original-power',
            runtimeAccountId: accountId, operationAcceptance: { operationId: 'original-operation', accept() {} }, operationOwnerUpdate: { update() {} } };
        context.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input, context,
            reviewAdmitted: true, plan: { children: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role })) },
            execute: async (body, _context, actionId) => {
                expect(actionId).toBe('action.invoke');
                if (!body || typeof body !== 'object' || !('action' in body)) throw new Error('Expected provider role envelope');
                const action = body.action;
                if (!action || typeof action !== 'object' || !('localId' in action) || typeof action.localId !== 'string') {
                    throw new Error('Expected native Action identity');
                }
                const role = action.localId;
                expect(_context.invocationServices?.managedMachine).toEqual(machine);
                expect(_context.invocationServices?.connectedAccountPurposeBinding).toMatchObject({
                    identity: { pluginId: provider.pluginId, localId: role },
                    purposeBindings: { v: 1, bindings: [{ purpose: { consumer: { pluginId: provider.pluginId, localId: role },
                        purpose: 'cloud-api' }, target: { kind: 'account', account: selectedAccount } }] },
                });
                expect(['power', 'inspect']).toContain(role);
                expect(body).toMatchObject({ input: { resource: { id: 'same-native' } } });
                native.push(role);
                if (role === 'inspect') {
                    inspections++;
                    if (outcome === 'inspect-unavailable' && inspections > 1) {
                        return { ok: false, errorCode: 'provider_unavailable', error: 'provider_unavailable' };
                    }
                    return { ok: true, result: { observedAt: outcome === 'delayed' ? inspections * 10 : inspections,
                        availability: 'present', power: inspections < (outcome === 'delayed' ? 3 : 2) ? 'stopped' : 'running',
                        storage: 'retained' } };
                }
                return { ok: true, result: outcome === 'unknown'
                    ? { kind: 'unknown', code: 'action_outcome_unknown' } : { kind: 'confirmed' } };
            } });
        const account = await captureLazyActionAccountContext(homeId);
        expect(account).not.toBeNull();
        if (!account) throw new Error('Expected Account');
        onTestFinished(() => account.dispose());
        replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const result = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.power.set', input, context });
        if (refused) {
            expect(result).toMatchObject({ ok: false, errorCode: 'managed_power_required' });
            expect(native).toEqual([]);
        } else if (outcome === 'unknown' || outcome === 'inspect-unavailable') {
            expect(result).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            expect(native).toEqual(['inspect', 'power', 'inspect']);
        } else if (outcome === 'after-idle') {
            expect(result).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 } });
            expect(machine.desiredWhen).toBe('after-idle');
            expect(native).toEqual([]);
            expect(paths.some(path => path.endsWith('/submit-intent') || path.endsWith('/report-intent'))).toBe(false);
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 } });
            expect(native).toEqual(outcome === 'delayed' ? ['inspect', 'power', 'inspect', 'inspect'] : ['inspect', 'power', 'inspect']);
            if (outcome === 'delayed') expect(paths.filter(path => path.endsWith('/report-intent'))).toHaveLength(1);
        }
        expect(paths.filter(path => path.endsWith('/admit-control'))).toHaveLength(1);
        expect(paths.some(path => path.endsWith('/execution-authorization'))).toBe(false);
    });
});

it.each(['confirmed', 'admission-refused', 'guest-startup-report-failed', 'native-refused-report-failed', 'confirmed-report-failed', 'native-refused-report-confirmed', 'resize-unsupported-report-failed', 'delete-refused-report-failed', 'delete-refused-report-confirmed', 'delete-confirmed-report-failed'] as const)(
    'settles retained Account power through public activation and its selected credential, outcome=%s', async outcome => {
    const { refused, guestStartup, nativeRefused, reportFailed, resizeUnsupported, deleting, deleteRefused, actionId, logStart, result, reported, roles, requests, admissions, submitted, reports, nativeResumes, guestBoots, secret, machine } = await executeManagedAccountPowerOutputScenario(outcome, vendorHttp);
    // The original Action already owns review. A provider role cannot ask the
    // person a second time instead of consuming its exact reviewed-child proof.
    expect(Modal.show).not.toHaveBeenCalled();
    if (deleting) {
        expect(result).toMatchObject({ ok: false, errorCode: deleteRefused ? 'vercel_scope_mismatch' : 'managed_request_failed' });
        expect(reported).toEqual([expect.objectContaining({ result: expect.objectContaining(deleteRefused
            ? { kind: 'refused', code: 'vercel_scope_mismatch' } : { kind: 'confirmed' }) })]);
        expect({ admissions, submitted, reports, nativeResumes, guestBoots }).toEqual({
            admissions: 1, submitted: 1, reports: 1, nativeResumes: 0, guestBoots: 0 });
        expect(roles).toContain('destroy');
        const retainedLogs = log.getLogs().slice(logStart);
        if (deleteRefused && reportFailed) expect(retainedLogs).toContain(JSON.stringify({ phase: actionId,
            errorClass: 'ManagedMachineControllerError', errorCode: 'managed_request_failed', httpStatus: null }));
        else expect(retainedLogs.some(entry => entry.includes('"errorCode":"managed_request_failed"'))).toBe(false);
        expect(JSON.stringify({ result, retainedLogs })).not.toMatch(/private-home-report-body|private-selected-power-token/);
        return;
    }
    if (resizeUnsupported) {
        expect(result).toMatchObject({ ok: true, result: { result: { kind: 'unsupported', dimension: 'memoryBytes' } } });
        if (!result.ok) throw new Error(result.errorCode);
        const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
        expect(getActionSpec(actionId).outputSchema!.safeParse(result.result).success).toBe(true);
        expect({ admissions, submitted, reports, nativeResumes, guestBoots, roles }).toEqual({
            admissions: 1, submitted: 0, reports: 1, nativeResumes: 0, guestBoots: 0, roles: [] });
        const retainedLogs = log.getLogs().slice(logStart);
        expect(retainedLogs).toContain(JSON.stringify({ phase: actionId, errorClass: 'ManagedMachineControllerError',
            errorCode: 'managed_request_failed', httpStatus: null }));
        expect(JSON.stringify({ result, retainedLogs })).not.toMatch(/private-home-report-body|private-selected-power-token/);
        return;
    }
    if (refused) {
        expect(result).toMatchObject({ ok: false, errorCode: 'managed_power_required' });
        expect({ submitted, reports, nativeResumes, guestBoots, roles }).toEqual({
            submitted: 0, reports: 0, nativeResumes: 0, guestBoots: 0, roles: [] });
        return;
    }
    if (reportFailed || nativeRefused) {
        // The first guest command is the public provider's platform probe;
        // its nonzero exit authors this bootstrap failure before daemon start.
        expect(result).toMatchObject({ ok: false, errorCode: guestStartup ? 'vercel_guest_unsupported'
            : nativeRefused ? 'provider_unavailable' : 'managed_request_failed' });
        if (nativeRefused) expect(result).toMatchObject({ details: {
            kind: 'managedNative', nativeCause: { httpStatusClass: '4xx' },
        } });
        expect(reported).toEqual([expect.objectContaining({ result: expect.objectContaining(nativeRefused
            ? { kind: 'refused', code: 'provider_unavailable' } : { kind: 'confirmed' }) })]);
        expect({ admissions, submitted, reports, nativeResumes, guestBoots }).toEqual({
            admissions: 1, submitted: 1, reports: 1, nativeResumes: nativeRefused ? 0 : 1, guestBoots: guestStartup ? 1 : 0 });
        const retainedLogs = log.getLogs().slice(logStart);
        if (reportFailed && (guestStartup || nativeRefused)) expect(retainedLogs).toContain(JSON.stringify({ phase: 'machines.managed.power.set',
            errorClass: 'ManagedMachineControllerError', errorCode: 'managed_request_failed', httpStatus: null }));
        else expect(retainedLogs.some(entry => entry.includes('"errorCode":"managed_request_failed"'))).toBe(false);
        const publicEvidence = JSON.stringify({ result, retainedLogs });
        for (const privateValue of [secret, 'private-home-report-body', 'private-guest-startup-output', 'private-native-refusal-body']) {
            expect(publicEvidence).not.toContain(privateValue);
        }
        return;
    }
    expect(result, JSON.stringify({ result, reported, roles, requests })).toMatchObject({ ok: true,
        result: { kind: 'accepted', managedId: machine.id, intentRevision: 3 } });
    expect(reported).toEqual([expect.objectContaining({ result: { kind: 'confirmed' },
        observation: expect.objectContaining({ power: 'running', storage: 'retained' }) })]);
    expect(result.ok && result.result).not.toHaveProperty('operation');
    expect({ admissions, submitted, reports, nativeResumes, guestBoots, roles }).toEqual({
        admissions: 1, submitted: 1, reports: 1, nativeResumes: 1, guestBoots: 0, roles: ['inspect', 'power', 'inspect'] });
    expect(machine.observation?.power).toBe('running');
    expect(JSON.stringify(result)).not.toContain(secret);
});
