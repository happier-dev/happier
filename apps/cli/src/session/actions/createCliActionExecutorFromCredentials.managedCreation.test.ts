import { renderBundledDeclarationAsset } from '@/plugins/projection/registry/builtIn/declarationAssets';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import * as fs from 'node:fs';
import { PLUGIN as VERCEL_PLUGIN } from '../../../../../packages/plugins/machine-vercel/src/manifest';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

const input = { enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
    selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } as const;

function publishPreference(token: string, enabled: boolean) {
    const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ managedMachineCreationEnabled: enabled }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
    return createActionSettingsProvider({ scopeKey });
}

describe('managed creation preference at CLI Action origination', () => {
    let publicationRoot: string | undefined;
    afterEach(() => {
        vi.restoreAllMocks();
        resetActiveAccountSettingsSnapshotForTests();
        if (publicationRoot) fs.rmSync(publicationRoot, { recursive: true, force: true });
        publicationRoot = undefined;
    });

    it.each(['forged-exec', 'forged-provider', 'authentic', 'native-selected', 'power'] as const)('reviews only the selected Account provisioner through the default CLI hook (%s)', async variant => {
        const pluginId = 'happier.machine.vercel';
        // Package-asset bytes are the filesystem boundary; compile current authored declarations
        // rather than letting concurrent semantic publication choose the fixture's contract.
        const published = ingestCanonicalPluginManifest(VERCEL_PLUGIN.manifest, {
            manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource',
        });
        if (!published.ok) throw new Error('The authored Vercel fixture must admit before publication');
        publicationRoot = fs.mkdtempSync(join(tmpdir(), 'happier-managed-vercel-declaration-'));
        const manifestPath = join(publicationRoot, 'machine-vercel.json');
        fs.writeFileSync(manifestPath, renderBundledDeclarationAsset(JSON.stringify(published.manifest)));
        const openSync = fs.openSync;
        vi.spyOn(fs, 'openSync').mockImplementation((path, ...args) =>
            openSync(String(path).replaceAll('\\', '/').endsWith('/bundled-plugin-manifests/machine-vercel.json')
                ? manifestPath : path, ...args));
        const loaded = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] });
        const [plugin] = loaded.loadedPlugins;
        const descriptor = plugin?.manifest.contributes.machineProvisioners?.[0];
        if (!descriptor) throw new Error(`The actual bundled declaration must supply Vercel: ${JSON.stringify(loaded.pluginFailures)}`);
        const bootstrapTransport = descriptor.bootstrapTransport;
        if (bootstrapTransport?.kind !== 'native') throw new Error('The selected Vercel descriptor must own native exec');
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', provenance: {
            v: 1, kind: 'account', authority: 'present_user',
        } })).toString('base64url')}.signature`;
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
        setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: {
            v: 1, actions: { 'action.invoke': { approvalRequiredSurfaces: ['cli'] } },
        } }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
        // Account availability HTTP, approval persistence and effect transport are the system boundaries.
        let accountSelectionReads = 0;
        const preliminaryMachineReads = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected preliminary discovery'));
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            expect(String(url)).toBe(`https://selected-provider.test${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']}`);
            accountSelectionReads++;
            return { status: 200, data: { availabilityCursor: 1, hostingCapability: { enabled: false },
                intent: null, release: null, uiArtifacts: [], packageAssets: [] } };
        });
        let reviews = 0;
        let effects = 0;
        let approval: unknown;
        let powerMachine: ManagedMachineV1 | undefined;
        const harness = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
            sessionId: '', mode: 'plain', ctx: null, serverId: 'srv_home', serverHttpBaseUrl: 'https://selected-provider.test',
            actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
        }, {
            approvalsCreate: async ({ request }) => { approval = request; reviews++; return { artifactId: 'selected-provider-approval' }; },
            managedMachineAction: async ({ actionId, input }) => {
                if (variant === 'power' && actionId === 'machines.managed.get') {
                    expect(input).toEqual({ homeId: 'srv_home', managedId: 'managed' });
                    if (!powerMachine) throw new Error('Missing retained fixture');
                    return powerMachine;
                }
                effects++; return { managedId: 'must-not-create' };
            },
        });
        // A controller's native discovery may select a local/custom plugin absent from the Account catalog.
        const controller = variant === 'native-selected' ? { machineId: 'controller', installationId: 'installation' } : undefined;
        const admittedDescriptor = variant === 'authentic' || variant === 'native-selected' || variant === 'power';
        const launch = { provider: { pluginId: controller ? 'custom.native-only' : pluginId,
            localId: variant === 'forged-provider' ? 'not-selected' : descriptor.id },
            schemaVersion: 1, name: 'guest', choices: { image: 'node22', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 } };
        const reviewedFacts = buildManagedConfigurationFactsV1({
            choicesSchema: createPluginJsonSchemaZodValueAdapter(descriptor.launchSchema), launch, ...(controller ? { controller } : {}),
            provisioner: variant === 'forged-exec' ? { ...descriptor,
                bootstrapTransport: { ...bootstrapTransport, exec: 'not-a-provisioner-role' } } : descriptor,
            optionStatus: 'current', prerequisites: [], billing: descriptor.billing, retentionCapabilities: descriptor.retention,
            machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        const actionInput = {
            enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
            selection: { kind: 'one-off', homeId: 'srv_home', launch, ...(controller ? { controller } : {}),
                retention: reviewedFacts.retention, wakeOnAcceptedMessage: reviewedFacts.wakeOnAcceptedMessage }, reviewedFacts,
        };
        if (variant === 'power') powerMachine = ManagedMachineV1Schema.parse({
            id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch, reviewedFacts,
            allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: reviewedFacts.retention, wakeOnAcceptedMessage: false,
        });
        const result = await harness.executor.execute(variant === 'power' ? 'machines.managed.power.set' : 'machines.managed.acquire',
            variant === 'power' ? { homeId: 'srv_home', managedId: 'managed', expectedRevision: 1, when: 'now', intent: 'start' } : actionInput,
            { surface: 'cli', authority: 'present_user', actionRequestId: 'selected-provider-request',
            runtimeAccountId: 'account', serverId: 'srv_home', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject(admittedDescriptor
            ? { ok: true, result: { kind: 'approval_request_created', artifactId: 'selected-provider-approval' } }
            : { ok: false, errorCode: 'admission_unavailable' });
        expect(reviews).toBe(admittedDescriptor ? 1 : 0);
        expect(effects).toBe(0);
        expect(accountSelectionReads).toBe(controller ? 0 : 1);
        expect(preliminaryMachineReads).not.toHaveBeenCalled();
        if (variant === 'power') expect(approval).toMatchObject({ preview: { hostReviewedChildren: { children: [
            { action: { pluginId, localId: descriptor.actions.inspect }, role: 'inspect' },
            { action: { pluginId, localId: descriptor.actions.power }, role: 'power' },
        ] } } });
    });

    it.each(['api_token', 'stored_session'] as const)('refuses opted-out %s acquisition before the existing public transport shortcut', async provenance => {
        const token = provenance === 'api_token'
            ? `hap_v1_00000000-0000-4000-8000-000000000001_${'a'.repeat(43)}`
            : `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
        const actionsSettingsProvider = publishPreference(token, false);
        // HTTP is the forwarding boundary; credential scopes and both Action
        // factories remain real. A disabled preference must not reach it.
        const post = vi.spyOn(axios, 'post');
        const get = vi.spyOn(axios, 'get');
        const fetch = vi.spyOn(globalThis, 'fetch');
        const executor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null,
            credentialProvenance: provenance }, actionsSettingsProvider, externalActionClient: true });
        expect(await executor.execute('machines.managed.acquire', input, { surface: 'cli' }))
            .toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
        expect(await executor.prepare('machines.managed.acquire', input, { surface: 'cli' }))
            .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'creation_disabled' } });
        expect(post).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses only the originating credential scope and refuses reception without an Automation admission owner', async () => {
        const originToken = 'origin-account-token';
        publishPreference('different-account-token', false);
        const outputs: string[] = [];
        const harness = createCliActionExecutorHarness({ token: originToken, sessionId: '', mode: 'plain', ctx: null }, {
            // Durable Machine admission is the substituted transport boundary.
            managedMachineAction: async ({ actionId }) => { outputs.push(actionId); return { managedId: 'managed' }; },
        });
        const confirmation = { actionId: 'machines.managed.acquire' as const };
        expect(await harness.executor.execute('machines.managed.acquire', input,
            { surface: 'cli', authority: 'present_user', presentUserConfirmation: confirmation })).toMatchObject({ ok: true });
        publishPreference(originToken, false);
        expect(await harness.executor.execute('machines.managed.acquire', input,
            { surface: 'cli', authority: 'present_user', presentUserConfirmation: confirmation }))
            .toMatchObject({ ok: false, errorCode: 'creation_disabled' });
        expect(await harness.executor.execute('machines.managed.acquire', input,
            { surface: 'rpc', authority: 'present_user', runtimeAccountId: 'foreign-requester', presentUserConfirmation: confirmation }))
            .toMatchObject({ ok: true });
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'already-admitted-origin-proof', binding: {
            accountId: 'foreign-requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'srv_home',
            machineId: 'controller', custodianAccountId: 'controller-account', installationId: 'installation',
            actionId: 'machines.managed.acquire', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43), target,
        } });
        const received = await harness.executor.execute('machines.managed.acquire', input, { surface: 'ui', authority: 'present_user',
            runtimeAccountId: 'foreign-requester', externalActionExecutionAuthorization: authorization,
            externalActionTarget: target, presentUserConfirmation: confirmation });
        // A structural authorization does not supply the absent credential-backed Automation owner.
        expect(received).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
            effectAttempted: false, failureCause: { phase: 'action.automations.admission', errorClass: 'Error',
                errorCode: 'target_unavailable', nativeErrorReason: 'action_automation_owner_unavailable', httpStatus: null } });
        expect(outputs).toEqual(['machines.managed.acquire', 'machines.managed.acquire']);
    });
});
