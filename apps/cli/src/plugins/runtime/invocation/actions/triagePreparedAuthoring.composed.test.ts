import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginOpenNewSessionHandler } from '../../../../../../ui/sources/components/plugins/surfaces/pluginOpenNewSessionHostApi';
import { executeContributedAction } from './executeContributedAction';

// Credential storage is an OS boundary. Source declarations, activation,
// Action admission, handler validation and New Session settlement stay real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => null }));
afterEach(() => vi.unstubAllEnvs());

describe('Triage prepared New Session authoring', () => {
    it('admits the current forge manifests that consume the preparation role', async () => {
        const manifests = await Promise.all([
            import('../../../../../../../packages/plugins/scm-github/src/manifest'),
            import('../../../../../../../packages/plugins/scm-gitlab/src/manifest'),
            import('../../../../../../../packages/plugins/scm-bitbucket/src/manifest'),
            import('../../../../../../../packages/plugins/scm-azure-devops/src/manifest'),
        ]);
        for (const { PLUGIN_MANIFEST } of manifests) {
            const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
            expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics)).toBe(true);
        }
    });

    it('admits the source preparation role from mounted UI before opening the exact prepared workspace', async () => {
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
        const values = createTriageSourceV1Fixture();
        const prepared = values.prepareReviewWorkspaceResult;
        if (prepared.kind !== 'prepared') throw new Error('Expected a prepared workspace fixture');
        const role = TriageSourcesContributionProtocolV1.operations.prepareReviewWorkspace.declaration;
        const source = values.configuredInstance.instance.source;
        const pluginId = source.pluginId;
        const action = { pluginId, localId: 'prepare-review-workspace' };
        const effects: unknown[] = [];
        const plugin = definePlugin({
            id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            actions: {
                [action.localId]: {
                    title: 'Prepare review workspace',
                    surfaces: role.surfaces,
                    dangerLevel: role.dangerLevel,
                    confirmation: { title: 'Prepare review workspace', confirmLabel: 'Prepare workspace' },
                    confirmationWhen: { presentUserUi: false },
                    inputSchema: role.input.schema.jsonSchema,
                    resultSchema: role.resultSchema.jsonSchema,
                    run: async input => {
                        effects.push(input);
                        return prepared;
                    },
                },
            },
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
                instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            runtimeOptions: { resolveCurrentMachineId: () => 'machine-1',
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'machine-1' }) },
        });
        try {
            const operation = {
                point: { pointId: 'triage-sources', protocol: { id: 'triage-sources', version: 1 } },
                contributor: { pluginId, contributionId: source.localId,
                    occurrenceId: 'source-occurrence',
                    sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } },
                role: 'prepareReviewWorkspace', action,
            };
            const selected = {
                kind: 'submitted' as const, action, input: values.prepareReviewWorkspaceInput,
                selection: {
                    target: { pluginId: 'happier.triage', sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' } },
                    point: operation.point,
                    contributor: { pluginId, contributionId: operation.contributor.contributionId,
                        sourceCustody: operation.contributor.sourceCustody },
                },
                connectedAccount: { kind: 'none' as const },
                presentation: { connectedAccountLabel: null, machineDisplayName: 'Review machine' },
            };
            const openNewSession = vi.fn(async () => ({ kind: 'opened' as const, dataId: 'handoff', draftId: 'draft' }));
            const handler = createPluginOpenNewSessionHandler({
                pluginId: 'happier.triage',
                accountLifetime: { scope: { serverId: 'server-1', accountId: 'account-1' },
                    isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
                isCurrent: () => true,
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                // Replace only the cross-process Action transport with the real
                // daemon dispatcher. Preserve the UI origin stamped by ingress;
                // a mounted press must never acquire plugin-only authority.
                executeSelectedOperation: async payload => {
                    const dispatched = await executeContributedAction({
                        runtimeRegistry: fixture.registry,
                        actionId: `${payload.action.pluginId}/${payload.action.localId}`,
                        input: payload.input,
                        approvalContext: { surface: 'ui', authority: 'present_user' },
                        context: { surface: 'ui', invocationSurface: 'ui', caller: {
                            kind: 'plugin', pluginId: 'happier.triage',
                            contribution: { id: 'triage-app', qualifiedId: 'happier.triage/triage-app' },
                            occurrenceId: 'triage-occurrence',
                            sourceCustody: { kind: 'development', registeredRootId: 'triage-root' },
                            materialization: { machineId: 'machine-1', materializationId: 'triage-materialization', pluginId: 'happier.triage' },
                            originSurface: 'ui',
                        } },
                    });
                    if (!dispatched.matched) throw new Error('Preparation Action missing');
                    return dispatched.result.ok ? dispatched.result.result
                        : { code: 'unavailable', diagnostics: [dispatched.result.errorCode] };
                },
                openNewSession,
            });
            await expect(handler({ checkoutIntent: 'preparedReviewWorkspace', prompt: 'Review this' }, {
                targetedOperation: operation, selectedActionInput: selected,
            })).resolves.toBeNull();
            expect(effects).toEqual([values.prepareReviewWorkspaceInput]);
            expect(openNewSession).toHaveBeenCalledWith(expect.objectContaining({ seed: {
                checkoutIntent: 'reuseWorkspace', prompt: 'Review this',
                placement: { kind: 'exactTarget', serverId: 'server-1', machineId: 'machine-1',
                    directory: prepared.repositoryPath },
            } }));
        } finally {
            await fixture.dispose();
        }
    });
});
