import { afterEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema, ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { fixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { executeCliManagedAccountInspect } from './accountInspect';
import { executeCliManagedAccountDelete } from './accountDelete';
import { executeCliManagedAccountResize } from './accountResize';

const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
const serverUrl = 'http://opaque-account.test';
const requestId = 'opaque-lifecycle';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('Account opaque preset lifecycle entries', () => {
    it('checks a terminal migrated preset without requiring an installed provider', async () => {
        const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'terminal', homeId: 'home', custodianAccountId: 'owner',
            preset: { id: 'old-preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'confirmed-absent',
            creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 2,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'old-preset',
            launch: { provider: { pluginId: 'missing.provider', localId: 'vm' }, schemaVersion: 1, name: 'old-machine', choices: {} } }) };
        const app = fastify();
        cleanup.push(() => app.close());
        await app.ready();
        cleanup.push(installAxiosFastifyAdapter({ app, origin: serverUrl }));
        await expect(executeCliManagedAccountInspect({ machine, context: {}, credentials: { token, encryption: null }, serverUrl,
            post: async (path, _body, schema) => {
                expect(path).toBe('context');
                return schema.parse({ machine, presetContent: { content, recipients: [] }, requestId });
            } })).resolves.toEqual({ machine });
    });
    it.each([
        ['inspect', true, 'opaque'], ['inspect', false, 'opaque'], ['delete', true, 'opaque'], ['delete', false, 'opaque'],
        ['resize', true, 'opaque'], ['delete', true, 'full'],
    ] as const)('settles %s through the Account owner (reviewed %s, %s row)', async (operation, reviewed, layout) => {
        const native = fixture();
        const manifest = native.manifest;
        const provisioner = manifest.contributes.machineProvisioners[0]!;
        const provider = { pluginId: manifest.id, localId: provisioner.id };
        const launch = { provider, schemaVersion: provisioner.schemaVersion, name: 'private-machine', choices: {} };
        const resource = { contributionRef: provider, schemaVersion: provisioner.schemaVersion, value: { id: 'private-native' } };
        const observation = { observedAt: 10, availability: 'present' as const, power: 'stopped' as const, storage: 'retained' as const, ...(operation === 'resize' ? { size: { cpuCores: 4 } } : {}) };
        const app = fastify();
        cleanup.push(() => app.close());
        const credentials = { token, encryption: null };
        const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway', source: { kind: 'contribution',
            contributionKey: 'happier.provider.deepseek/deepseek' }, role: 'named', displayName: 'Gateway',
            displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
        const accountGrant = { v: 1 as const, connectionId: connection.id, connectionSecurityFingerprint: 'connection-fingerprint', confirmedAt: 1 };
        const standingGrant = { ...accountGrant, machineId: 'standing', endpointSetFingerprint: 'endpoint-fingerprint' };
        const retiredGrant = { ...standingGrant, machineId: 'enrolled' };
        const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection], accountGrants: [accountGrant], machineGrants: [standingGrant, retiredGrant] };
        const catalogWrites: unknown[] = [];
        const events: string[] = [];
        runWithServerHttpBaseUrl(serverUrl, () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
            rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }));
        cleanup.push(resetActiveAccountSettingsSnapshotForTests);
        app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
        app.get(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, async request => {
            expect(request.headers.authorization).toBe(`Bearer ${token}`);
            return { status: 'present', revision: 4, content: { t: 'plain', v: catalog } };
        });
        app.post(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, async request => {
            expect(request.headers.authorization).toBe(`Bearer ${token}`);
            events.push('catalog');
            catalogWrites.push(ProviderConnectionsRowMutationV1Schema.parse(request.body));
            return { status: 'updated', revision: 5, cursor: 5 };
        });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
            availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
            intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            uiArtifacts: [], packageAssets: [],
        }));
        await app.ready();
        cleanup.push(installAxiosFastifyAdapter({ app, origin: serverUrl }));
        const structural = ManagedOpaquePresetMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            ...(operation === 'delete' && layout === 'opaque'
                ? { enrolledMachineId: retiredGrant.machineId, ...(reviewed ? {} : { enrollmentAccountId: 'member' }) } : {}),
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound', creationState: 'active',
            desired: operation === 'delete' ? 'delete' : 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'private-preset', launch,
            ...(reviewed ? { reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } : {}),
            nativeResult: { kind: 'bound', resource }, observation }) };
        // Released raw rows can carry preset metadata while retaining full native fields.
        const legacy = ManagedMachineFullV1Schema.parse({ ...structural, launch, resource, reviewedFacts: content.v.reviewedFacts });
        let machine: typeof structural | typeof legacy = layout === 'full' ? legacy : structural;
        const reports: unknown[] = [];
        const roles: string[] = [];
        const post: Parameters<typeof executeCliManagedAccountInspect>[0]['post'] = async (path, body, schema) => {
            if (path === 'context') return schema.parse({ machine, presetContent: { content, recipients: [] }, requestId });
            if (path === 'admit-control') return schema.parse(operation === 'resize' ? { machine: legacy, replayed: false }
                : { machine, ...(layout === 'opaque' ? { presetContent: { content, recipients: [] } } : {}), replayed: false });
            if (path === 'report-resize') { reports.push(body); return schema.parse({ machine: legacy }); }
            if (path === 'submit-intent') {
                machine = { ...machine, submittedNativeEffect: { intent: 'delete', requestId, intentRevision: machine.intentRevision } };
                return schema.parse({ machine, submitted: true });
            }
            if (path === 'report' || path === 'report-intent') {
                reports.push(body);
                events.push('report');
                expect(body).not.toHaveProperty('resource');
                expect(body).not.toHaveProperty('launch');
                if (layout === 'opaque') {
                    expect(body).toHaveProperty('presetContent');
                } else {
                    // The signed CLI request validates the body before JSON transport.
                    signExternalActionMachineRequestV1({
                        authorizationToken: 'fixture-authorization', effectActionId: 'machines.managed.delete',
                        target: { kind: 'machine', machineId: 'account-host' }, installationId: 'installation',
                        requestId, method: 'POST', path: '/v1/machines/managed/controller/report-intent', body,
                        privateKey: new Uint8Array(64),
                    });
                    expect(body).toMatchObject({
                        requestId, expectedIntentRevision: machine.intentRevision, result: { kind: 'confirmed' },
                        observation: { availability: 'absent' },
                    });
                }
                const { submittedNativeEffect: _settled, ...current } = machine;
                machine = { ...current, allocation: operation === 'delete' ? 'confirmed-absent' : 'bound',
                    observation: operation === 'delete' ? { observedAt: 11, availability: 'absent' } : observation };
                return schema.parse({ machine });
            }
            throw new Error(`Unexpected Home boundary: ${path}`);
        };
        const actionId = operation === 'inspect' ? 'machines.managed.inspect'
            : operation === 'resize' ? 'machines.managed.resize' : 'machines.managed.delete';
        const actionInput = operation === 'inspect' ? { homeId: 'home', managedId: machine.id }
            : operation === 'resize' ? { homeId: 'home', managedId: machine.id, size: { cpuCores: 4 } }
            : { homeId: 'home', managedId: machine.id, when: 'now', expectedRevision: 1, intent: 'delete', reviewedDependencies: true };
        const executor = createActionExecutor({
            managedMachineAction: async ({ context, input }) => operation === 'inspect'
                ? await executeCliManagedAccountInspect({ machine, context, credentials: { token, encryption: null }, serverUrl, post })
                : operation === 'resize' ? await executeCliManagedAccountResize({ body: ManagedMachineActionInputSchemasV1['machines.managed.resize'].parse(input),
                    context, credentials: { token, encryption: null }, serverUrl, post })
                : await executeCliManagedAccountDelete({ body: ManagedMachineActionInputSchemasV1['machines.managed.delete'].parse(input),
                    context, credentials: { token, encryption: null }, serverUrl, post }),
            // Native plugin execution is the process boundary; Account selection,
            // private opening, reviewed-child routing, and reporting stay real.
            routeHostChildAction: async ({ input }) => {
                if (!input || typeof input !== 'object' || !('action' in input) || !input.action
                    || typeof input.action !== 'object' || !('localId' in input.action)) throw new Error('Expected native role');
                const role = String(input.action.localId);
                roles.push(role);
                return { ok: true, result: role === provisioner.actions.destroy || role === provisioner.actions.resize ? { kind: 'confirmed' } : observation };
            },
        });
        const result = await executor.execute(actionId, actionInput, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: 'home', runtimeAccountId: 'owner', actionRequestId: requestId, externalActionTarget: { kind: 'machine', machineId: 'account-host' },
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
            presentUserConfirmation: { actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, actionInput), requestId,
                accountId: 'owner', serverId: 'home', target: { kind: 'machine', machineId: 'account-host' } } });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(JSON.stringify(result)).not.toContain('private-machine');
        expect(JSON.stringify(result)).not.toContain('private-native');
        expect(reports).toHaveLength(1);
        const retiresProviderGrant = operation === 'delete' && reviewed && layout === 'opaque';
        expect(events).toEqual(retiresProviderGrant ? ['report', 'catalog'] : operation === 'resize' ? [] : ['report']);
        expect(catalogWrites).toEqual(retiresProviderGrant ? [expect.objectContaining({
            expectedRevision: 4, content: { t: 'plain', v: { ...catalog, machineGrants: [standingGrant] } },
        })] : []);
        expect(roles).toEqual(operation === 'resize' ? [provisioner.actions.resize, provisioner.actions.inspect]
            : [operation === 'delete' ? provisioner.actions.destroy : provisioner.actions.inspect]);
    });
});
