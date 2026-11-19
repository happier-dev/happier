import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { WorkflowAcceptedAuthorizationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createMachineInstallationIdentityFixture } from '../../../../../packages/tests/src/testkit/machineIdentity';

vi.mock('undici', async importOriginal => {
    const actual = await importOriginal<typeof import('undici')>();
    return { ...actual, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
        default: { ...actual.default, fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) } };
});

describe('deployment read placement from a CLI on another Machine', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('reads a Team Environment from Home without a requester daemon', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-environment-reader-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'reader', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const serverId = configuration.activeServerId;
            const environment = createDeploymentEnvironmentHeaderV1({ id: 'env', serverId,
                controllerMachineId: 'collector-machine' });
            const detail = { ok: true, environment, targetLinks: [] };
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const url = new URL(String(request.url));
                if (url.origin + url.pathname === 'https://home.test/v1/deployments/environments/env'
                    && request.method === 'GET' && request.headers?.Authorization === `Bearer ${token}`) {
                    return { status: 200, data: detail };
                }
                return { status: 404, data: { error: 'not_found' } };
            });
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
                externalActionClient: true, serverId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
            });
            expect(await executor.execute('deployments.environments.get', { serverId, environmentId: environment.id },
                { surface: 'cli', authority: 'present_user' })).toMatchObject({ ok: true, result: detail });
        });
    });

    it.each(['terminal', 'account'] as const)('dispatches current health to the controller the read names, not this CLI Machine (%s)', async kind => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-health-probe-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: kind === 'terminal' ? { v: 1, kind: 'terminal', authority: 'account_automation' }
                    : { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const calls: string[] = [];
            vi.stubGlobal('fetch', vi.fn(async (url: unknown, options: RequestInit) => {
                calls.push(`fetch ${String(url)} ${String(options?.body).slice(0, 300)}`);
                return Response.json({ ok: false, errorCode: 'probe', error: 'probe' });
            }));
            const record = (method: string) => vi.spyOn(axios, method as 'get').mockImplementation(async (url: unknown, body?: unknown) => {
                calls.push(`axios.${method} ${String(url)} ${JSON.stringify(body)?.slice(0, 300)}`);
                return { status: 418, data: { ok: false, error: 'probe' } };
            });
            record('get'); record('post'); record('request');
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                machineId: 'own-machine',
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const result = await executor.execute('deployments.health.current', { serverId: 'srv_home', environmentId: 'env',
                targetLinkId: 'link', machineId: 'controller-machine' }, { surface: 'cli' });
            // Dispatch first reads the receiving Machine it will ask Home to mint for.
            // It must be the controller the read names, never this CLI's own Machine.
            const evidence = `${JSON.stringify(result)}\n${calls.join('\n')}`;
            expect(calls.some(call => call.includes('/v1/machines/controller-machine')), evidence).toBe(true);
            expect(calls.some(call => call.includes('/v1/machines/own-machine')
                || call.includes('/actions/root/execute')), evidence).toBe(false);
        });
    });

    it.each([undefined, 'own-machine'])('places an Environment child using the recorded controller or explicit Machine (%s)', async machineId => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-deployment-child-placement-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'own-machine', accountId: 'owner' });
            const calls: string[] = [];
            vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, errorCode: 'probe', error: 'probe' })));
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                calls.push(`axios.get ${url}`);
                return { status: 418, data: { ok: false, error: 'probe' } };
            });
            vi.spyOn(axios, 'post').mockResolvedValue({ status: 418, data: { ok: false, error: 'probe' } });
            vi.spyOn(axios, 'request').mockImplementation(async config => {
                calls.push(`axios.request ${String(config.url)}`);
                if (new URL(String(config.url)).pathname === '/v1/deployments/environments/env') {
                    return { status: 200, data: { ok: true, environment: createDeploymentEnvironmentHeaderV1({
                        id: 'env', serverId: configuration.activeServerId, controllerMachineId: 'controller-machine',
                    }), targetLinks: [] } };
                }
                return { status: 418, data: { ok: false, error: 'probe' } };
            });
            const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1 });
            const executor = createCliActionExecutorFromCredentials({ credentials, ...(machineId ? { machineId } : {}),
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                actionsSettingsProvider: {
                    getActionsSettings: () => actionsSettings,
                    getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: actionsSettings }),
                } });
            const result = await executor.execute('deployments.domains.add', {
                serverId: configuration.activeServerId, environmentId: 'env', domainId: 'domain',
                expectedRevision: 1, requestKey: 'add-domain', targetLinkId: 'link', expectedTargetLinkRevision: 1,
                content: { hostname: 'example.test', target: { service: 'web', containerPort: 3000 } },
            }, { surface: 'cli' });
            const evidence = `${JSON.stringify(result)}\n${calls.join('\n')}`;
            expect(calls.filter(call => call.includes('/v1/deployments/environments/env')), evidence).toHaveLength(machineId ? 0 : 1);
            expect(evidence).toContain(`/v1/machines/${machineId ?? 'controller-machine'}`);
            expect(evidence).not.toContain(`/v1/machines/${machineId ? 'controller-machine' : 'own-machine'}`);
        });
    });

    it('places a Workflow Environment child at its controller, independent of the Run workspace', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-workflow-deployment-placement-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            const identity = createMachineInstallationIdentityFixture();
            const environment = createDeploymentEnvironmentHeaderV1({ id: 'env', serverId: 'srv_home',
                controllerMachineId: 'controller-machine' });
            const environmentReads = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200,
                data: { ok: true, environment, targetLinks: [] } });
            const machineReads: string[] = [];
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(url).pathname;
                if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
                machineReads.push(path);
                return { status: 404, data: { error: 'machine_not_found' } };
            });
            const workspace = { machineId: 'workflow-machine', directory: process.cwd() };
            const runId = 'workflow-run';
            const context = buildWorkflowActionContext({ runId, workspace,
                authorization: WorkflowAcceptedAuthorizationV1Schema.parse({
                    admittedPermissionCeiling: 'default', principal: { kind: 'host' },
                }),
            });
            const deps = createCliActionDeps({ token, credentials, sessionId: '', ctx: null, mode: 'plain',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test',
                machineActionDirectTargetTransport: { machineId: workspace.machineId, invoke: async () => {
                    throw new Error('The child must not execute on the Run workspace');
                } },
                externalActionMachineRequestPrivateKey: identity.privateKeyBase64,
                externalActionMachineInstallationId: identity.installationId,
            });
            const result = await deps.deploymentAction!('deployments.domains.remove', {
                serverId: environment.serverId, environmentId: environment.id, domainId: 'domain',
                expectedRevision: 1, expectedDomainRevision: 1, requestKey: 'remove-domain',
            }, { ...context, actionRequestId: `${runId}/deployment/0`,
                externalActionTarget: { kind: 'machine', machineId: workspace.machineId, project: workspace } });
            const evidence = JSON.stringify({ result, machineReads });
            expect(environmentReads.mock.calls.map(([request]) => request), evidence).toEqual([expect.objectContaining({
                method: 'GET', url: expect.stringContaining('/v1/deployments/environments/env'),
            })]);
            expect(machineReads, evidence).toContain('/v1/machines/controller-machine');
            expect(machineReads, evidence).not.toContain('/v1/machines/workflow-machine');
        });
    });

    it('dispatches an installed Workflow Publish Prepare to its selected Machine through the original-root owner', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-workflow-publish-prepare-' }, async () => {
            // Home is the network boundary: record the submitted request, refuse it typed.
            const posts: Array<{ path: string; body: unknown }> = [];
            const request = vi.fn(async (config: { url?: string; method?: string; data?: unknown }) => {
                const path = String(config.url ?? '');
                if ((config.method ?? 'get').toLowerCase() === 'get') {
                    if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 }, headers: {}, config };
                    return { status: 404, data: { error: 'machine_not_found' }, headers: {}, config };
                }
                posts.push({ path, body: config.data });
                return { status: 403, data: { error: 'credential_scope_denied' }, headers: {}, config };
            });
            vi.spyOn(axios, 'request').mockImplementation(request as never);
            vi.spyOn(axios, 'post').mockImplementation(((url: string, data: unknown, config?: object) =>
                request({ ...config, url, data, method: 'post' })) as never);
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            const identity = createMachineInstallationIdentityFixture();
            const machineReads: string[] = [];
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(url).pathname;
                if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
                machineReads.push(path);
                return { status: 404, data: { error: 'machine_not_found' } };
            });
            const workspace = { machineId: 'workflow-machine', directory: process.cwd() };
            const runId = 'workflow-run';
            const context = buildWorkflowActionContext({ runId, workspace,
                authorization: WorkflowAcceptedAuthorizationV1Schema.parse({
                    admittedPermissionCeiling: 'default', principal: { kind: 'host' },
                }),
            });
            const deps = createCliActionDeps({ token, credentials, sessionId: '', ctx: null, mode: 'plain',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test',
                machineActionDirectTargetTransport: { machineId: workspace.machineId, invoke: async () => {
                    throw new Error('Publish Prepare must not execute on the Run workspace');
                } },
                externalActionMachineRequestPrivateKey: identity.privateKeyBase64,
                externalActionMachineInstallationId: identity.installationId,
            });
            const result = await deps.deploymentAction!('deployments.publish.prepare', {
                serverId: 'srv_home', machineId: 'publisher-machine', installationId: 'publisher-installation',
                projectSourceId: 'source', sourceRevision: 1,
                templateRef: { sourceId: 'apps', itemId: 'app', version: '1.0.0', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            }, { ...context, actionRequestId: `${runId}/deployment/0`,
                externalActionTarget: { kind: 'machine', machineId: workspace.machineId, project: workspace } });
            const evidence = JSON.stringify({ result, machineReads, posts });
            // The original-root owner admits the installed Run: it submits the Run's
            // signed Workflow origin to Home for the selected publisher Machine.
            expect(result, evidence).not.toMatchObject({ errorCode: 'deployment_executor_unavailable' });
            const submitted = posts.find(post => post.path.endsWith('deployments.publish.prepare'));
            expect(submitted, evidence).toBeDefined();
            const body = typeof submitted!.body === 'string' ? submitted!.body : JSON.stringify(submitted!.body);
            expect(body, evidence).toContain('"runId":"workflow-run"');
            expect(body, evidence).toContain('"machineId":"publisher-machine"');
        });
    });

    it('keeps a CI API token out of the full Environment read during placement', async () => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-ci-placement-' }, async () => {
            const calls: URL[] = [];
            const record = (url: unknown) => calls.push(new URL(String(url), 'https://home.test'));
            vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
                record(url);
                return Response.json({ ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' }, { status: 403 });
            }));
            for (const method of ['get', 'post'] as const) {
                vi.spyOn(axios, method).mockImplementation(async url => {
                    record(url);
                    return { status: 403, data: { ok: false, error: 'action_forbidden' } };
                });
            }
            vi.spyOn(axios, 'request').mockImplementation(async config => {
                record(config.url);
                return { status: 403, data: { ok: false, error: 'action_forbidden' } };
            });
            const executor = createCliActionExecutorFromCredentials({
                credentials: { token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
                    encryption: null, credentialProvenance: 'api_token' },
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
            });
            await executor.execute('deployments.deploy', { serverId: 'srv_home', environmentId: 'env',
                targetLinkId: 'link' }, { surface: 'cli' });
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.map(url => url.pathname)).not.toContain('/v1/deployments/environments/env');
        });
    });
});
