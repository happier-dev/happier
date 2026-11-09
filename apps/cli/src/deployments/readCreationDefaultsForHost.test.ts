import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, ProjectDeploymentDefaultsOutputV1Schema } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import { PROJECT_SOURCE_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectSourcesActionIdsV1';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { readDeploymentCreationDefaultInputsForHost } from './readCreationDefaultsForHost';
import * as creationPreparation from './readCreationDefaultsForHost';

afterEach(() => vi.restoreAllMocks());

async function fixture(mode: 'plain' | 'e2ee') {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const machineKey = new Uint8Array(32).fill(17);
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
        : { type: 'dataKey', machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    let current = true;
    const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
        snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: {
            buildMachineId: 'account-build', controllerMachineId: 'account-controller', retainPreviousDeployments: 7,
        } }), settingsVersion: 1, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] },
        isCurrent: async () => current });
    const payload = { projectSourceId: 'source', deploymentDefaults: { buildMachineId: 'project-build', retainPreviousDeployments: 0 } };
    const resource = await createResourceDataKey({ credentials, mode });
    const seal = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    let artifact = { id: 'defaults', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
        dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
        header: seal({ kind: 'project-deployment-defaults.v1', title: 'Defaults' }),
        body: seal({ body: JSON.stringify(payload) }), headerVersion: 2, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1 };
    let defaults = ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: 'source', sourceRevision: 6, revision: 2,
        content: { contentArtifactId: 'defaults', contentHeaderVersion: 2, contentBodyVersion: 3 } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (new URL(url).pathname === '/v1/artifacts/defaults') return { status: 200, data: artifact };
        throw new Error('Unexpected Artifact transport');
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
        expect(config.method).toBe('GET');
        if (config.url === 'https://home.test/v1/projects/sources/source?serverId=home') {
            return { status: 200, data: { ok: true, canManage: true, source: {
                id: 'source', revision: 6, name: 'Project', owner: projectOwner,
                audience: [], createdByAccountId: 'owner',
            } } };
        }
        expect(config.url).toBe('https://home.test/v1/projects/source/deployment-defaults?serverId=home');
        return { status: defaults.ok ? 200 : 403, data: defaults };
    });
    let projectOwner: { kind: 'account'; accountId: string } | { kind: 'team'; teamId: string } = { kind: 'account', accountId: 'owner' };
    // Account mode is an external owner fact. The real Artifact store retains mode checks and both document codecs.
    const artifacts = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => mode });
    const host: Parameters<typeof readDeploymentCreationDefaultInputsForHost>[1] = {
        serverId: 'home', serverHttpBaseUrl: 'https://home.test', accountId: 'owner', expectedScopeKey: scopeKey,
        async assertCurrent(context) {
            if (!await operation.isCurrent(context.signal)) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
        },
        async headers() { return { Authorization: `Bearer ${token}` }; },
        open: (artifactId, context) => artifacts.read(artifactId, { signal: context.signal, prepareRecipients: false, includeSharedAudience: false }),
        readAccountSnapshot: operation.readSnapshot,
    };
    const request = { projectSourceId: 'source', sourceRevision: 6, projectOwner: { kind: 'account' as const, accountId: 'owner' },
        context: { runtimeAccountId: 'owner' } };
    return { host, request, payload, retire() { current = false; },
        setProjectOwner(value: typeof projectOwner) { projectOwner = value; },
        setDefaults(value: unknown) { defaults = ProjectDeploymentDefaultsOutputV1Schema.parse(value); },
        changeArtifact(value: Partial<typeof artifact>) { artifact = { ...artifact, ...value }; },
        changePayload(value: unknown) { artifact = { ...artifact, body: seal({ body: JSON.stringify(value) }) }; } };
}

describe('deployment creation defaults at the captured Account and exact Project Artifact owners', () => {
    it.each(['plain', 'e2ee'] as const)('prepares an unsaved %s Project from its intended owner without Source reads or writes', async mode => {
        const { host, request } = await fixture(mode);
        const transport = vi.mocked(axios.request);
        transport.mockClear();
        for (const owner of [{ kind: 'account' as const, accountId: 'owner' }, { kind: 'team' as const, teamId: 'team' }]) {
            const prepared = await creationPreparation.prepareDeploymentCreationDefaultsForHost({
                newProject: { name: 'App', owner, requestKey: 'new-app-project' },
                actionId: 'deployments.environments.create', context: request.context,
                target: { kind: 'ownServer', machines: ['runtime'] },
            }, owner.kind === 'team' ? { ...host, readAccountSnapshot: () => { throw new Error('No personal defaults for Team'); } } : host);
            expect(prepared.projectOwner).toEqual(owner);
            expect(prepared.values).toMatchObject(owner.kind === 'team'
                ? { controllerMachineId: 'runtime', buildMachineId: 'runtime', retainPreviousDeployments: 1 }
                : { controllerMachineId: 'account-controller', buildMachineId: 'account-build', retainPreviousDeployments: 7 });
            expect(prepared).not.toHaveProperty('reviewBasis');
        }
        expect(transport).not.toHaveBeenCalled();
    });

    it.each(['plain', 'e2ee'] as const)('prepares ordinary %s creation once from the admitted Source and preserves its reviewed values', async mode => {
        const { host, request, setDefaults, changePayload } = await fixture(mode);
        const headers = vi.fn(host.headers);
        const prepared = await creationPreparation.prepareDeploymentCreationDefaultsForHost({
            projectSourceId: request.projectSourceId, actionId: 'deployments.environments.create', context: request.context,
            explicit: { controllerMachineId: 'explicit-controller' }, target: { kind: 'ownServer', machines: ['runtime'] },
        }, { ...host, headers });
        const sourceRead = headers.mock.calls.find(([, , transport]) => transport.path
            === '/v1/projects/sources/source?serverId=home');
        expect(sourceRead?.[1]).toBe(PROJECT_SOURCE_READ_ACTION_ID_V1);
        expect(prepared).toEqual({ projectOwner: { kind: 'account', accountId: 'owner' },
            values: { buildMachineId: 'project-build', controllerMachineId: 'explicit-controller', retainPreviousDeployments: 0 },
            sources: { buildMachineId: 'project', controllerMachineId: 'explicit', retainPreviousDeployments: 'project' },
            reviewBasis: { projectSourceId: 'source', sourceRevision: 6, projectDefaultsRevision: 2,
                content: { contentArtifactId: 'defaults', contentHeaderVersion: 2, contentBodyVersion: 3 } } });
        changePayload({ projectSourceId: 'source', deploymentDefaults: { retainPreviousDeployments: 8 } });
        setDefaults({ ok: true, projectSourceId: 'source', sourceRevision: 6, revision: 3,
            content: { contentArtifactId: 'defaults', contentHeaderVersion: 2, contentBodyVersion: 3 } });
        expect(prepared.values.retainPreviousDeployments).toBe(0);
        expect(prepared.sources.retainPreviousDeployments).toBe('project');
    });

    it('prepares Team creation without reading the invoking Account preferences', async () => {
        const { host, request, setProjectOwner, setDefaults } = await fixture('plain');
        setProjectOwner({ kind: 'team', teamId: 'team' });
        setDefaults({ ok: true, projectSourceId: 'source', sourceRevision: 6, revision: 0, content: null });
        const prepared = await creationPreparation.prepareDeploymentCreationDefaultsForHost({
            projectSourceId: request.projectSourceId, actionId: 'deployments.environments.create', context: request.context,
            target: { kind: 'ownServer', machines: ['runtime'] },
        }, { ...host, readAccountSnapshot: () => { throw new Error('Team creation cannot read personal defaults'); } });
        expect(prepared.values).toEqual({ buildMachineId: 'runtime', controllerMachineId: 'runtime', retainPreviousDeployments: 1 });
        expect(prepared.sources).toEqual({ buildMachineId: 'builtin', controllerMachineId: 'builtin', retainPreviousDeployments: 'builtin' });
        expect(prepared.projectOwner).toEqual({ kind: 'team', teamId: 'team' });
    });

    it.each(['plain', 'e2ee'] as const)('feeds admitted %s Project and captured Account values to the sole precedence resolver', async mode => {
        const { host, request, payload } = await fixture(mode);
        const inputs = await readDeploymentCreationDefaultInputsForHost(request, host);
        expect(inputs).toEqual({ projectDefaults: payload, account: { accountId: 'owner', defaults: {
            buildMachineId: 'account-build', controllerMachineId: 'account-controller', retainPreviousDeployments: 7,
        } }, reviewBasis: { projectSourceId: 'source', sourceRevision: 6, projectDefaultsRevision: 2,
            content: { contentArtifactId: 'defaults', contentHeaderVersion: 2, contentBodyVersion: 3 } } });
        expect(resolveDeploymentCreationDefaultsV1({ ...request, ...inputs,
            target: { kind: 'ownServer', machines: ['target'] }, explicit: { controllerMachineId: 'explicit-controller' } }).values)
            .toEqual({ buildMachineId: 'project-build', controllerMachineId: 'explicit-controller', retainPreviousDeployments: 0 });
    });

    it('uses Account preferences only for their owner and never borrows them for a Team Project', async () => {
        const { host, request, setDefaults } = await fixture('plain');
        setDefaults({ ok: true, projectSourceId: 'source', sourceRevision: 6, revision: 0, content: null });
        const personal = await readDeploymentCreationDefaultInputsForHost(request, host);
        expect(resolveDeploymentCreationDefaultsV1({ ...request, ...personal, target: { kind: 'ownServer', machines: ['target'] } }).values)
            .toEqual({ buildMachineId: 'account-build', controllerMachineId: 'account-controller', retainPreviousDeployments: 7 });
        const team = { ...request, projectOwner: { kind: 'team' as const, teamId: 'team' } };
        const shared = await readDeploymentCreationDefaultInputsForHost(team, host);
        expect(shared).toEqual({ reviewBasis: { projectSourceId: 'source', sourceRevision: 6, projectDefaultsRevision: 0, content: null } });
        expect(resolveDeploymentCreationDefaultsV1({ ...team, ...shared, target: { kind: 'ownServer', machines: ['target'] } }).values)
            .toEqual({ buildMachineId: 'target', controllerMachineId: 'target', retainPreviousDeployments: 1 });
    });

    it('opens a Team Project recipient Artifact without borrowing the recipient Account defaults', async () => {
        const { host, request, payload, changeArtifact } = await fixture('e2ee');
        changeArtifact({ ownerAccountId: 'author', access: 'view' });
        expect(await readDeploymentCreationDefaultInputsForHost({ ...request,
            projectOwner: { kind: 'team', teamId: 'team' } }, host)).toEqual({ projectDefaults: payload,
                reviewBasis: { projectSourceId: 'source', sourceRevision: 6, projectDefaultsRevision: 2,
                    content: { contentArtifactId: 'defaults', contentHeaderVersion: 2, contentBodyVersion: 3 } } });
    });

    it('delegates Account-mode mismatch rejection to the Artifact owner before opening private defaults', async () => {
        const { host, request, changeArtifact } = await fixture('plain');
        changeArtifact({ encryptionMode: 'e2ee' });
        await expect(readDeploymentCreationDefaultInputsForHost(request, host)).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    });

    it('rejects a changed Source revision and substituted private Artifact rather than silently using builtins', async () => {
        const { host, request, setDefaults, changeArtifact, changePayload, payload } = await fixture('plain');
        await expect(readDeploymentCreationDefaultInputsForHost({ ...request, sourceRevision: 5 }, host))
            .rejects.toMatchObject({ code: 'project_defaults_conflict' });
        changeArtifact({ bodyVersion: 4 });
        await expect(readDeploymentCreationDefaultInputsForHost(request, host)).rejects.toMatchObject({ code: 'project_defaults_conflict' });
        changeArtifact({ bodyVersion: 3 });
        changePayload({ ...payload, projectSourceId: 'foreign' });
        await expect(readDeploymentCreationDefaultInputsForHost(request, host)).rejects.toMatchObject({ code: 'project_defaults_content_unavailable' });
        setDefaults({ ok: false, error: 'project_defaults_access_denied' });
        await expect(readDeploymentCreationDefaultInputsForHost(request, host)).rejects.toMatchObject({ code: 'project_defaults_access_denied' });
    });

    it('fails retired or wrong-scope Account custody closed without falling back to ambient settings', async () => {
        const { host, request, retire } = await fixture('plain');
        await expect(readDeploymentCreationDefaultInputsForHost(request, { ...host, expectedScopeKey: 'foreign' }))
            .rejects.toMatchObject({ code: 'account_settings_unavailable' });
        await expect(readDeploymentCreationDefaultInputsForHost({ ...request, context: { runtimeAccountId: 'foreign' } }, host))
            .rejects.toMatchObject({ code: 'action_forbidden' });
        retire();
        await expect(readDeploymentCreationDefaultInputsForHost(request, host)).rejects.toMatchObject({ code: 'action_forbidden' });
    });
});
