import { randomUUID } from 'node:crypto';
import * as undici from 'undici';
import { expect, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import {
    DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentGetResultV1Schema,
    DeploymentObservationGetResultV1Schema, DeploymentReceiptGetResultV1Schema,
    DeploymentReceiptResultV1Schema, DeploymentTargetLinkResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentArtifactContentReferenceV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import { DeploymentEnvironmentContentV1Schema, DeploymentPlatformContentV1Schema, DeploymentTargetLinkContentV1Schema, type DeploymentSourceIntentV1 } from '@happier-dev/deployments/contracts/v1';
import {
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
} from '@happier-dev/deployment-protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { mutateQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { manifest as vercelManifest } from '../../../../packages/plugins/deploy-vercel/src/manifest';
import { PLUGIN_MANIFEST as vercelAccountManifest } from '../../../../packages/plugins/machine-vercel/src/manifest';
import type { DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';

/** Both provider-only roots consume an actual Vercel receipt created by the
 * public deployment flow. Only the third-party HTTP boundary is substituted. */
export async function runDeploymentRootProviderCoverage(input: Readonly<{
    home: DeploymentSocketHomeFixture;
    invoke(name: string, input: unknown): Promise<ActionExecuteResult>;
    projectSourceId: string;
    sourceIntent: Extract<DeploymentSourceIntentV1, { kind: 'repository' }>;
    prepareContent(content: unknown, kind: typeof DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
        | typeof DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 | typeof DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    title?: string): Promise<DeploymentArtifactContentReferenceV1>;
}>) {
    const { home, invoke, sourceIntent, prepareContent } = input;
    expect(sourceIntent.projectSourceId).toBe(input.projectSourceId);
    if (home.encryptionMode === 'e2ee' && !home.encryption) throw new Error('Provider coverage requires the E2EE Account material');
    const descriptor = vercelAccountManifest.contributes.connectedAccountDescriptors?.[0];
    if (!descriptor) throw new Error('The bundled Vercel Account descriptor is required');
    const credentialRef = { service: { pluginId: vercelAccountManifest.id, localId: descriptor.id }, accountId: randomUUID() };
    const providerAccountId = 'team_root_coverage';
    const projectId = 'prj_root_coverage';
    const providerDeploymentId = 'dpl_root_coverage';
    const token = `vercel-root-coverage-${randomUUID()}`;
    const seal = (kind: 'credential' | 'configuration', payload: unknown) => sealQualifiedConnectedAccountContentEnvelope(
        home.encryptionMode === 'e2ee' && home.encryption
            ? { kind, accountMode: 'e2ee', material: home.encryption, payload,
                randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }
            : { kind, accountMode: 'plain', payload, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) });
    await runWithServerHttpBaseUrl(home.baseUrl, () => mutateQualifiedConnectedAccountCredentialV4({ token: home.token,
        mutation: { ref: credentialRef, authenticationModeId: PluginConnectedAccountAuthenticationV2Schema.parse(descriptor.authentication).defaultModeId,
            expectedCredentialRevision: null,
            content: seal('credential', { v: 1, values: { token } }),
            initialConfiguration: { expectedConfigurationRevision: null,
                replacementContentEnvelope: seal('configuration', { values: { teamId: providerAccountId, projectId }, secretRefs: {} }) },
            metadata: { displayName: 'Root coverage Vercel', scopes: [],
                providerIdentity: { accountId: null, email: null, organizationId: providerAccountId } },
        } }));
    const requests: { method: string; path: string }[] = [];
    const nativeFetch = undici.fetch;
    const providerHttp = vi.spyOn(undici, 'fetch').mockImplementation(async (url, init) => {
        const parsed = new URL(typeof url === 'object' && 'url' in url ? url.url : String(url));
        if (parsed.origin !== 'https://api.vercel.com') return nativeFetch(url, init);
        const method = init?.method ?? 'GET';
        expect(new undici.Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
        expect(parsed.searchParams.get('teamId')).toBe(providerAccountId);
        requests.push({ method, path: parsed.pathname });
        let body: unknown;
        if (method === 'GET' && parsed.pathname === `/v9/projects/${projectId}`) {
            body = { id: projectId, accountId: providerAccountId, name: 'root-coverage',
                link: { type: 'github', org: 's0', repo: 'app', repoId: '123', productionBranch: 'main' } };
        } else if (method === 'GET' && parsed.pathname === '/v1/integrations/search-repo') {
            body = { repos: [{ id: '123', provider: 'github', namespace: 's0', slug: 'app' }] };
        } else if (method === 'POST' && parsed.pathname === '/v13/deployments') {
            if (!(init?.body instanceof Uint8Array)) throw new Error('The provider deployment must send its reviewed source');
            expect(JSON.parse(new TextDecoder().decode(init.body))).toMatchObject({ project: projectId, target: 'production',
                gitSource: { type: 'github', repoId: '123', ref: sourceIntent.sha, sha: sourceIntent.sha } });
            body = { id: providerDeploymentId, projectId, readyState: 'BUILDING' };
        } else if (method === 'GET' && parsed.pathname === `/v13/deployments/${providerDeploymentId}`) {
            body = { id: providerDeploymentId, projectId, readyState: 'READY', url: 'root-coverage.vercel.app' };
        } else throw new Error(`Unexpected Vercel request: ${method} ${parsed.pathname}`);
        return new undici.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const resultOf = async (name: string, operand: unknown) => {
        const result = await invoke(name, operand);
        if (!result.ok) throw new Error(`${name} refused: ${result.errorCode}`);
        return result.result;
    };
    try {
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Provider root coverage', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: sourceIntent.sha, compose: sourceIntent.compose }, bindings: [] });
        const created = DeploymentEnvironmentCreateResultV1Schema.parse(await resultOf('deployments.environments.create', {
            serverId: home.serverId, projectSourceId: input.projectSourceId, requestKey: randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: home.machineId,
            ...await prepareContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content.name),
        }));
        if (!created.ok) throw new Error(`Provider Environment create refused: ${created.error}`);
        const address = { serverId: home.serverId, environmentId: created.environmentId };
        const action = { pluginId: vercelManifest.id, localId: 'targets-inspect-v1' };
        const principal = { kind: 'account', accountId: home.accountId,
            purpose: { consumer: action, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } };
        const prepared = DeploymentTargetLinkContentV1Schema.parse(await resultOf('action.invoke', { action,
            input: { v: 1, ...address, expectedRevision: created.revision, credentialRef, credentialPrincipal: principal,
                providerIdentity: { providerAccountId, providerResourceId: projectId, providerEnvironment: 'production' },
                providerEnvironment: { kind: 'native', selection: { kind: 'production' } },
                repository: { kind: 'github', deployment: 'https://github.com', repository: 's0/app' } },
        }));
        const linked = DeploymentTargetLinkResultV1Schema.parse(await resultOf('deployments.targets.link', {
            ...address, expectedRevision: created.revision, requestKey: randomUUID(), targetId: `${vercelManifest.id}/runtime`,
            role: 'runtime', targetKind: 'vercel', source: { kind: 'plugin', contribution: { pluginId: vercelManifest.id, localId: 'runtime' } },
            machines: [], ...await prepareContent(prepared, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1),
        }));
        if (!linked.ok) throw new Error(`Provider target link refused: ${linked.error}`);
        if (!('targetLinkId' in linked)) throw new Error('Provider coverage requires the newly created target link');
        const candidate = DeploymentPlatformContentV1Schema.parse({ sourceIntent, sourceMethod: 'gitIntegration',
            machines: [], images: [], machineResults: [], steps: [], platform: { ...prepared,
                targetLinkRevision: linked.targetLinkRevision, observation: { v: 1, state: 'queued', observedAtMs: Date.now() } } });
        const deployed = DeploymentReceiptResultV1Schema.parse(await resultOf('deployments.deploy', {
            ...address, expectedRevision: linked.revision, targetLinkId: linked.targetLinkId,
            expectedTargetLinkRevision: linked.targetLinkRevision, requestKey: randomUUID(),
            ...await prepareContent(candidate, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1),
        }));
        if (!deployed.ok) throw new Error(`Provider deploy refused: ${deployed.error}`);
        if (!('deploymentId' in deployed)) throw new Error('Provider coverage requires the completed deployment admission');
        expect(deployed.state).toBe('running');
        const observed = DeploymentReceiptResultV1Schema.parse(await resultOf('deployments.receipts.observe', {
            ...address, deploymentId: deployed.deploymentId,
        }));
        expect(observed).toMatchObject({ ok: true, deploymentId: deployed.deploymentId, state: 'succeeded' });
        const observation = DeploymentObservationGetResultV1Schema.parse(await resultOf('deployments.observation.get', {
            ...address, targetLinkId: linked.targetLinkId, deploymentId: deployed.deploymentId,
        }));
        expect(observation).toMatchObject({ ok: true, credentialPrincipal: principal,
            receipt: { deployment: { id: deployed.deploymentId, state: 'succeeded' }, providerDeploymentId } });
        const retained = DeploymentReceiptGetResultV1Schema.parse(await resultOf('deployments.receipts.get', {
            ...address, deploymentId: deployed.deploymentId,
        }));
        expect(retained).toMatchObject({ ok: true, deployment: { state: 'succeeded' } });
        expect(requests).toEqual([
            { method: 'GET', path: `/v9/projects/${projectId}` },
            { method: 'GET', path: '/v1/integrations/search-repo' },
            { method: 'POST', path: '/v13/deployments' },
            { method: 'GET', path: `/v13/deployments/${providerDeploymentId}` },
        ]);
        expect(JSON.stringify({ observed, observation, retained })).not.toContain(token);
        const environment = DeploymentEnvironmentGetResultV1Schema.parse(await resultOf('deployments.environments.get', address));
        expect(environment).toMatchObject({ ok: true, environment: { id: created.environmentId },
            targetLinks: [expect.objectContaining({ id: linked.targetLinkId, activeDeploymentId: deployed.deploymentId })] });
    } finally { providerHttp.mockRestore(); }
}
