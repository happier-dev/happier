import { afterEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema, ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachinePresetContentV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
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
    it.each([['inspect', true], ['inspect', false], ['delete', true], ['delete', false], ['resize', true]] as const)('opens %s context at the Account owner and seals its native report (reviewed %s)', async (operation, reviewed) => {
        const native = fixture();
        const manifest = native.manifest;
        const provisioner = manifest.contributes.machineProvisioners[0]!;
        const provider = { pluginId: manifest.id, localId: provisioner.id };
        const launch = { provider, schemaVersion: provisioner.schemaVersion, name: 'private-machine', choices: {} };
        const resource = { contributionRef: provider, schemaVersion: provisioner.schemaVersion, value: { id: 'private-native' } };
        const observation = { observedAt: 10, availability: 'present' as const, power: 'stopped' as const, storage: 'retained' as const, ...(operation === 'resize' ? { size: { cpuCores: 4 } } : {}) };
        const app = fastify();
        cleanup.push(() => app.close());
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
        let machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
            preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound', creationState: 'active',
            desired: operation === 'delete' ? 'delete' : 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const content = { t: 'plain' as const, v: ManagedMachinePresetContentV1Schema.parse({ v: 1, name: 'private-preset', launch,
            ...(reviewed ? { reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
                retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } : {}),
            nativeResult: { kind: 'bound', resource }, observation }) };
        // Released raw rows can carry preset metadata while retaining full native fields.
        const legacy = ManagedMachineFullV1Schema.parse({ ...machine, launch, resource, reviewedFacts: content.v.reviewedFacts });
        const reports: unknown[] = [];
        const roles: string[] = [];
        const post: Parameters<typeof executeCliManagedAccountInspect>[0]['post'] = async (path, body, schema) => {
            if (path === 'context') return schema.parse({ machine, presetContent: { content, recipients: [] }, requestId });
            if (path === 'admit-control') return schema.parse(operation === 'resize' ? { machine: legacy, replayed: false }
                : { machine, presetContent: { content, recipients: [] }, replayed: false });
            if (path === 'report-resize') { reports.push(body); return schema.parse({ machine: legacy }); }
            if (path === 'submit-intent') {
                machine = { ...machine, submittedNativeEffect: { intent: 'delete', requestId, intentRevision: machine.intentRevision } };
                return schema.parse({ machine, submitted: true });
            }
            if (path === 'report' || path === 'report-intent') {
                reports.push(body);
                expect(body).not.toHaveProperty('resource');
                expect(body).not.toHaveProperty('launch');
                expect(body).toHaveProperty('presetContent');
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
        expect(roles).toEqual(operation === 'resize' ? [provisioner.actions.resize, provisioner.actions.inspect]
            : [operation === 'delete' ? provisioner.actions.destroy : provisioner.actions.inspect]);
    });
});
