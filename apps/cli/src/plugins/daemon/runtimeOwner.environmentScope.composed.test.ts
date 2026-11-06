import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { configuration } from '@/configuration';
import * as persistence from '@/persistence';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createPackedTestConnectedAccountsRuntime } from './packedTestConnectedAccounts';
import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('retains captured daemon deployment custody through startup and registry replacement', async () => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    const root = await mkdtemp(join(tmpdir(), 'happier-daemon-environment-scope-'));
    const happyHomeDir = join(root, 'home');
    const pluginRoot = join(root, 'plugin');
    const pluginId = 'acme.daemon-environment-scope';
    const serverId = configuration.activeServerId;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const template = createDeploymentEnvironmentHeaderV1({ serverId });
    const environment = createDeploymentEnvironmentHeaderV1({ serverId, id: 'preview-child', purpose: 'preview',
        previewTemplateEnvironmentId: template.id, previewRepositoryId: 'source-app',
        previewPullRequestId: 'pr-42', previewTargetLinkId: 'template-link' });
    // Home HTTP and credential persistence are boundaries; startup, activation,
    // source admission, replacement, approval policy and the handler stay real.
    const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
        expect(new URL(request.url!).origin).toBe('https://captured-home.test');
        expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${environment.id}`);
        expect(request.headers?.Authorization).toBe(`Bearer ${token}`);
        return { status: 200, data: { ok: true, environment, targetLinks: [] } };
    });
    const controller = createPluginReloadController({ happyHomeDir });
    const owner = createDaemonPluginRuntimeOwner({ happyHomeDir, staleCandidateCleanup: 'disabled', reloadController: controller,
        connectedAccounts: createPackedTestConnectedAccountsRuntime({ happyHomeDir, pluginId }).owner,
        resolveCurrentMachineId: () => 'machine-1',
        deploymentAccountExecution: { credentials: { token, encryption: null }, serverUrl: 'https://captured-home.test',
            serverId, serverIdentityId: serverId, machineId: 'machine-1', isCurrent: async () => true },
    });
    const actionId = formatQualifiedPluginActionId({ pluginId, localId: 'publish' });
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, scopedApprovalPreferences: [{
        actionId, scope: { kind: 'environment', environmentId: template.id },
        approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['ui'] }] });
    const invoke = () => executeContributedAction({ runtimeRegistry: controller.getState().activeRegistry!,
        actionId: buildQualifiedPluginContributionKey({ pluginId, localId: 'publish' }),
        input: { serverId, environmentId: environment.id }, actionsSettings,
        approvalContext: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }, context: { surface: 'ui' } });
    try {
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
            id: pluginId, activation: { events: [{ kind: 'startup' }] }, contributes: { actions: [{
                id: 'publish', title: 'Publish preview', scopes: ['global'], surfaces: ['ui'],
                placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote', approvalScope: 'environment',
                confirmation: { title: 'Publish preview status?' },
                execution: { target: 'daemon' },
                inputSchema: { type: 'object', properties: { serverId: { type: 'string' }, environmentId: { type: 'string' } },
                    required: ['serverId', 'environmentId'], additionalProperties: false },
                resultSchema: { type: 'object', properties: { published: { type: 'boolean' } }, required: ['published'], additionalProperties: false },
            }] },
        })), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), "export function activate(api) { api.actions.register('publish', async () => ({ published: true })); }", 'utf8');
        await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0', devWatch: false });
        await owner.initialize();
        expect(controller.getState().activeRegistry?.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
        const first = await invoke();
        expect(first, JSON.stringify(first)).toMatchObject({ matched: true, result: { ok: true, result: { published: true } } });
        expect(http).toHaveBeenCalledTimes(1);
        const initial = controller.getState().activeRegistry;
        expect(await owner.changeService.requestPluginChange({ kind: 'setUpdatePolicy', pluginId, policy: 'pinned' }))
            .toMatchObject({ kind: 'committed', pluginId });
        expect(controller.getState().activeRegistry).not.toBe(initial);
        expect(await invoke()).toMatchObject({ matched: true, result: { ok: true, result: { published: true } } });
        expect(http).toHaveBeenCalledTimes(2);
    } finally {
        await owner.changeService.shutdown();
        await controller.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});
