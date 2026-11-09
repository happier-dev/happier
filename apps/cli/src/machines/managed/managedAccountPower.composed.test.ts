// This CLI-hosted journey imports the real UI graph; reuse its native platform boundaries.
import '../../../../ui/sources/dev/vitestSetup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installApprovalCommonModuleMocks } from '../../../../ui/sources/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '../../../../ui/sources/auth/storage/tokenStorage';
import { setServerProfileIdentityForUrl } from '../../../../ui/sources/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '../../../../ui/sources/sync/ops/actions/actionAccountContext';
import { resetRuntimeFetch, setRuntimeFetch } from '../../../../ui/sources/utils/system/runtimeFetch';
import { replacePluginAccountAvailabilityProjection } from '../../../../ui/sources/sync/domains/plugins/availability/projection';
import { upsertAndActivateServer } from '../../../../ui/sources/sync/domains/server/serverRuntime';
import { standardCleanup } from '../../../../ui/sources/dev/testkit';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/machine-vercel/src/manifest';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { initializeServerIdentityCache, getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerManagedMachineRoutes } from '../../../../server/sources/app/machines/managed/managedRoutes';
import { createReleaseLessDeclarationV1 } from '../../../../server/sources/app/plugins/availability/currentDeclaration';

const packaged = vi.hoisted(() => ({ artifacts: [] as unknown[], declarations: [] as unknown[],
    files: new Map<number, Uint8Array>(), reads: 0 }));
// Packaged declarations/assets are platform IO. Account availability and the
// reviewed native role binding beneath them use the production owners.
vi.mock('../../../../ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
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
const { executeManagedMachineNativeAction } = await import('../../../../ui/sources/sync/api/machines/managedMachineOrigination');
const { prepareAuthenticationInventory } = await import('../../../../ui/sources/dev/testkit/fixtures/connectedAccountAuthentication');
await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
    target: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    projectPath: 'packages/plugins/machine-vercel', entryPath: 'packages/plugins/machine-vercel/src/manifest.ts',
    additionalArtifacts: [{ target: { artifactId: 'connected-account-authentication', exportName: 'activate' },
        entryPath: 'packages/plugins/machine-vercel/src/account.ts' }],
    packageName: '@happier-dev/plugins-machine-vercel' });

let database: LightSqliteHarness;
beforeAll(async () => {
    database = await createLightSqliteHarness({ tempDirPrefix: 'happier-account-power-', initAuth: true });
    await initializeServerIdentityCache();
}, 120_000);
afterAll(async () => {
    await (await import('../../../../ui/sources/components/plugins/reactNative/clientExecutableContributions'))
        .getInstalledPluginUiClientExecutableComposition().unload();
    await standardCleanup();
    if (database) await database.close();
});

it('settles a delayed Account wake with one final native report and preserves the submitted effect while still stopped', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const serverUrl = 'https://account-power-composed.example';
    const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
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
    await db.accountPluginIntent.create({ data: { accountId: owner.id, pluginId: manifest.id, enabled: true,
        writableCollections: [], releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) } });
    const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
        admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
        desired: 'stop', desiredWhen: 'now', intentRevision: 2, launch,
        resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
            retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } } });
    const input = { homeId, managedId: row.id, expectedRevision: row.intentRevision, when: 'now' as const, intent: 'start' as const };
    const requestId = randomUUID();
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    registerManagedMachineRoutes(app);
    await app.ready();
    onTestFinished(() => app.close());
    const reports: Array<{ body: unknown; status: number }> = [];
    // HTTP is adapted to the real authenticated Home router and SQLite storage.
    setRuntimeFetch(async (url, init) => {
        const address = new URL(String(url));
        const response = await app.inject({ method: 'POST', url: address.pathname,
            headers: Object.fromEntries(new Headers(init?.headers)),
            payload: typeof init?.body === 'string' ? init.body : undefined });
        if (address.pathname.endsWith('/report-intent')) {
            reports.push({ body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, status: response.statusCode });
        }
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    onTestFinished(resetRuntimeFetch);
    const nativeRoles: string[] = [];
    let inspections = 0;
    let beforeFinalObservation: unknown;
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionRequestId: requestId,
        runtimeAccountId: owner.id, operationAcceptance: { operationId: requestId, accept() {} }, operationOwnerUpdate: { update() {} } };
    context.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input, context,
        reviewAdmitted: true, plan: { children: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role })) },
        // Native vendor power is external; all retained intent and reporting logic stays real.
        execute: async body => {
            if (!body || typeof body !== 'object' || !('action' in body)) throw new Error('Expected provider role envelope');
            const action = body.action;
            if (!action || typeof action !== 'object' || !('localId' in action) || typeof action.localId !== 'string') {
                throw new Error('Expected native Action identity');
            }
            nativeRoles.push(action.localId);
            if (action.localId === 'power') return { ok: true, result: { kind: 'confirmed' } };
            if (action.localId !== 'inspect') throw new Error('Unexpected native role');
            inspections++;
            if (inspections === 3) {
                beforeFinalObservation = (await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } })).admittedInput;
            }
            return { ok: true, result: { observedAt: inspections * 10, availability: 'present',
                power: inspections < 3 ? 'stopped' : 'running', storage: 'retained' } };
        } });
    const account = await captureLazyActionAccountContext(homeId);
    if (!account) throw new Error('Expected captured Account');
    onTestFinished(() => account.dispose());
    replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const result = await executeManagedMachineNativeAction({ account, actionId: 'machines.managed.power.set', input, context });
    expect(result, JSON.stringify({ result, reports })).toMatchObject({ ok: true,
        result: { kind: 'accepted', managedId: row.id, intentRevision: 3 } });
    expect(nativeRoles).toEqual(['inspect', 'power', 'inspect', 'inspect']);
    expect(beforeFinalObservation).toMatchObject({ submittedEffect: { requestId, expectedIntentRevision: 3, intent: 'start' } });
    expect(reports).toEqual([{ status: 200, body: expect.objectContaining({ requestId, expectedIntentRevision: 3,
        result: { kind: 'confirmed' }, observation: { observedAt: 30, availability: 'present', power: 'running', storage: 'retained' } }) }]);
    const settled = await db.managedMachine.findUniqueOrThrow({ where: { id: row.id } });
    expect(settled).toMatchObject({ desired: 'start', intentRevision: 3,
        observation: { observedAt: 30, availability: 'present', power: 'running' } });
    expect(settled.admittedInput).not.toHaveProperty('submittedEffect');
});
