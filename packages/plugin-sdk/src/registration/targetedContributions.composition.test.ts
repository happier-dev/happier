import { describe, expect, it, vi } from 'vitest';
import { readAdmittedTargetedOperationExecutionBinding as readPrivateHostOperationBinding } from '@happier-dev/cli-common/plugins/registration';

import { definePlugin } from '../definePlugin.js';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { AccountReleasePluginSourceCustodyV1Schema, DevelopmentPluginSourceCustodyV1Schema, normalizePluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { defineContributionProtocol } from '../targetedContributionAuthoring.js';
import { createPluginContributionIdentity } from '@happier-dev/protocol/plugins/contribution-identity';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '../protocol/protocolFacade.js';
import { selectCurrentTargetedContribution } from '../services/targetedContributions.js';
import { QualifiedConnectedAccountRefSchema } from '../connected-accounts/index.js';
import { PluginUiSelectedActionInputCarrierV1Schema } from '@happier-dev/protocol/plugins/ui/selectedActionInput';
import { PluginTargetedContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/targeted';
import { PluginUiRendererChainBindingV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/rendererChainBinding';
import {
    createManifestTargetedContributionsService,
    mergeTargetedContributionManifestDeclarations,
    projectTargetedContributionActionDefinition,
    resolveAdmittedTargetedContributions,
    requireAdmittedTargetedOperationExecutionBinding,
    resolveAdmittedTargetedOperationInput,
    validateTargetedOperationInput,
    validateTargetedOperationResult,
    type TargetedContributionManifestDeclaration,
} from '@happier-dev/cli-common/plugins/registration';

const inputSchema = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ accepted: defineProtocolLiteral(true) }, { policy: 'closed' });
const protocol = defineContributionProtocol({
    id: 'external-account-source',
    version: 1,
    operations: {
        inspect: {
            required: true,
            input: { kind: 'protocolDefined', schema: inputSchema },
            resultSchema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        scan: {
            required: false,
            input: { kind: 'protocolDefined', schema: inputSchema },
            resultSchema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        call: {
            required: false,
            input: { kind: 'protocolDefined', schema: inputSchema },
            resultSchema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
    },
});
const target = definePlugin({
    id: 'external.account-target',
    version: '1.0.0',
    contributionPoints: { sources: protocol.point() },
});
const source = definePlugin({
    id: 'external.account-source',
    version: '1.0.0',
    actions: {
        inspect: {
            title: 'Inspect',
            surfaces: ['plugin'],
            dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'portable-source', exportName: 'activateAccount' } },
            inputSchema,
            resultSchema,
            run: async () => ({ accepted: true as const }),
        },
    },
    contributesTo: {
        'external.account-target': {
            sources: {
                'personal-source': protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
            },
        },
    },
});

function rows() {
    return [target, source].map((plugin) => {
        const parsed = ingestPluginManifestV2(plugin.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        return {
            manifest: parsed.manifest,
            occurrenceId: `${parsed.manifest.id}:occurrence`,
            sourceCustody: AccountReleasePluginSourceCustodyV1Schema.parse({
                kind: 'account_release',
                pluginId: parsed.manifest.id,
                version: parsed.manifest.version,
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            }),
        };
    });
}

async function admittedOperation(declarations: readonly TargetedContributionManifestDeclaration[] = rows()) {
    const controller = new AbortController();
    const service = createManifestTargetedContributionsService({
        readCurrentDeclarations: () => declarations,
        subscribeToCatalogChanges: () => () => {},
    }).bind({ pluginId: target.manifest.id, signal: controller.signal, isCurrent: () => true });
    const observation = service.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
    try {
        const snapshot = await observation.readCurrent();
        const contribution = snapshot.contributions[0];
        if (!contribution) throw new Error('Expected separately authored source to be admitted');
        return { declarations, operation: contribution.operations.inspect, targetSourceCustody: snapshot.sourceCustody,
            contributorSourceCustody: contribution.contributor.sourceCustody };
    } finally {
        observation.dispose();
    }
}

async function readContributions(declarations: readonly TargetedContributionManifestDeclaration[]) {
    const service = createManifestTargetedContributionsService({
        readCurrentDeclarations: () => declarations, subscribeToCatalogChanges: () => () => {},
    }).bind({ pluginId: target.manifest.id, signal: new AbortController().signal, isCurrent: () => true });
    const observation = service.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
    try { return (await observation.readCurrent()).contributions; }
    finally { observation.dispose(); }
}

function mixedRoleRows() {
    const declarations = rows();
    const selected = declarations[1]!;
    const account: TargetedContributionManifestDeclaration = {
        ...selected,
        manifest: { ...selected.manifest, contributes: { ...selected.manifest.contributes,
            actions: [...selected.manifest.contributes.actions,
                { ...selected.manifest.contributes.actions[0]!, id: 'machine-inspect', execution: { target: 'daemon' } }],
            targetedPluginContributions: selected.manifest.contributes.targetedPluginContributions.map((entry) => ({
                ...entry, operations: { inspect: 'inspect', scan: 'machine-inspect' },
            })),
        } },
    };
    const machine: TargetedContributionManifestDeclaration = {
        ...account, occurrenceId: 'actual-machine-source',
        sourceCustody: DevelopmentPluginSourceCustodyV1Schema.parse({ kind: 'development', registeredRootId: 'actual-machine-root' }),
        manifest: { ...account.manifest, contributes: { ...account.manifest.contributes,
            pluginContributionPoints: [],
            actions: account.manifest.contributes.actions.map((action) => action.id === 'machine-inspect'
                ? { ...action, id: 'machine-inspect-current' } : action),
            targetedPluginContributions: account.manifest.contributes.targetedPluginContributions.map((entry) => ({
                ...entry, operations: { inspect: 'inspect', scan: 'machine-inspect-current' },
            })),
        } },
    };
    return { targetRow: declarations[0]!, account, machine };
}

describe('portable targeted contribution admission', () => {
    it.each([
        { dangerLevel: 'safe', admitted: true },
        { dangerLevel: 'writesRemote', admitted: true },
        { dangerLevel: 'destructive', admitted: false },
    ] as const)('enforces the role danger ceiling for $dangerLevel while retaining the Action declaration', ({ dangerLevel, admitted: expected }) => {
        const actionOwned = defineContributionProtocol({ id: 'action-owned-effects', version: 1,
            operations: { inspect: { required: true, input: { kind: 'protocolDefined', schema: inputSchema },
                resultSchema, action: { surfaces: ['plugin'], dangerLevel: 'writesRemote' } } },
        });
        const actionTarget = definePlugin({ id: 'external.effect-target', version: '1.0.0',
            contributionPoints: { sources: actionOwned.point() } });
        const actionSource = definePlugin({
            id: `external.effect-${dangerLevel.toLowerCase()}`, version: '1.0.0',
            actions: { inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel,
                inputSchema, resultSchema, run: async () => ({ accepted: true as const }) } },
            contributesTo: { [actionTarget.manifest.id]: { sources: { source: actionOwned.contribute({
                operations: { inspect: actionOwned.operations.inspect.bind('inspect') },
            }) } } },
        });
        const manifests = [actionTarget, actionSource].map(plugin => {
            const parsed = ingestPluginManifestV2(plugin.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return parsed.manifest;
        });
        const params = {
            pluginContributionPoints: manifests.flatMap(manifest => manifest.contributes.pluginContributionPoints.map(definition => ({ pluginId: manifest.id, definition }))),
            targetedPluginContributions: manifests.flatMap(manifest => manifest.contributes.targetedPluginContributions.map(definition => ({ pluginId: manifest.id, definition }))),
            actions: manifests.flatMap(manifest => manifest.contributes.actions.map(definition => ({ pluginId: manifest.id,
                definition: projectTargetedContributionActionDefinition(definition) }))),
            uiRenderersV2: [], occurrenceIdsByPluginId: Object.fromEntries(manifests.map(manifest => [manifest.id, manifest.id])),
        };
        const read = (resolved: ReturnType<typeof resolveAdmittedTargetedContributions>) => resolved.read({
            targetPluginId: actionTarget.manifest.id, pointId: 'sources', protocol: { id: actionOwned.id, version: 1 },
        });
        const admitted = resolveAdmittedTargetedContributions(params);
        expect(read(admitted)?.contributions ?? []).toHaveLength(expected ? 1 : 0);
        const diagnostics = Object.values(admitted.diagnosticsByPluginId).flat();
        if (expected) expect(diagnostics).toEqual([]);
        else expect(diagnostics).toMatchObject([{ code: 'action_danger_level_mismatch' }]);
        expect(manifests[1]!.contributes.actions[0]!.dangerLevel).toBe(dangerLevel);
        const mixed = resolveAdmittedTargetedContributions({ ...params,
            targetedPluginContributions: params.targetedPluginContributions.map(contribution => ({ ...contribution,
                operationSourcesByRole: { inspect: { occurrenceId: contribution.pluginId, localId: 'inspect' } },
            })),
        });
        // A withdrawn mixed-source role stays in the snapshot as unavailable;
        // it cannot regain invocation just because a sibling source is admitted.
        const mixedOperation = read(mixed)?.contributions[0]?.operations[0];
        expect(mixedOperation).toBeDefined();
        expect(mixedOperation?.unavailable === true).toBe(!expected);
    });
    it('preserves an explicitly native credential in retained setup without accepting missing or substituted Accounts', async () => {
        const nativeInput = defineProtocolObject({ id: defineProtocolString(), credential: defineProtocolObject({
            account: QualifiedConnectedAccountRefSchema.nullable(),
        }, { policy: 'closed' }) }, { policy: 'closed' });
        const nativeProtocol = defineContributionProtocol({ id: 'native-credential-source', version: 1, operations: {
            inspect: { required: true, input: { kind: 'contributorDefined' }, resultSchema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const nativeTarget = definePlugin({ id: 'external.native-target', version: '1.0.0',
            contributionPoints: { sources: nativeProtocol.point() },
        });
        const nativeSource = definePlugin({ id: 'external.native-source', version: '1.0.0', actions: {
            inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: nativeInput, resultSchema,
                connectedAccountPurposeBindings: [{ path: 'credential.account', purpose: 'native-credential' }],
                execution: { target: 'account', account: { artifactId: 'native-source', exportName: 'activateAccount' } },
                run: async () => ({ accepted: true as const }),
            },
        }, contributesTo: { [nativeTarget.manifest.id]: { sources: {
            source: nativeProtocol.contribute({ operations: { inspect: nativeProtocol.operations.inspect.bind('inspect') } }),
        } } } });
        const declarations = [nativeTarget, nativeSource].map(plugin => {
            const parsed = ingestPluginManifestV2(plugin.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return { manifest: parsed.manifest, occurrenceId: `${plugin.manifest.id}:current`,
                sourceCustody: AccountReleasePluginSourceCustodyV1Schema.parse({ kind: 'account_release',
                    pluginId: plugin.manifest.id, version: plugin.manifest.version, archiveDigestSha256: `sha256:${'a'.repeat(64)}` }),
            };
        });
        const signal = new AbortController().signal;
        const observation = createManifestTargetedContributionsService({ readCurrentDeclarations: () => declarations,
            subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: nativeTarget.manifest.id, signal, isCurrent: () => true })
            .observeForSelf(nativeTarget.contributionPoints.sources, { onInvalidated() {} });
        try {
            const operation = (await observation.readCurrent()).contributions[0]!.operations.inspect;
            const seed = { plugin: { id: nativeTarget.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
            const binding = requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations);
            const resolve = (input: Parameters<typeof resolveAdmittedTargetedOperationInput>[0]['input']) =>
                resolveAdmittedTargetedOperationInput({ seed, binding, input, expectedSelectedConnectedAccountRef: null,
                    selectedActionInputClaimed: { current: false }, signal,
                    assertCurrent() { requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations); },
                });
            const input = { id: 'retained-native', credential: { account: null } };
            expect(nativeInput.parse(await resolve(input))).toEqual(input);
            const invalidInputs: Parameters<typeof resolve>[0][] = [
                { id: 'retained-native' },
                { id: 'retained-native', credential: {} },
                { id: 'retained-native', credential: { account: { service: { pluginId: 'external.accounts', localId: 'github' }, accountId: 'another-account' } } },
            ];
            for (const invalid of invalidInputs) await expect(resolve(invalid)).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid', actionHandlerInvocation: 'notStarted' });
        } finally { observation.dispose(); }
    });

    it('separates a self-contributed Account source from its Machine target selection custody', async () => {
        const self = definePlugin({ id: target.manifest.id, version: '1.0.0',
            contributionPoints: { sources: protocol.point() },
            actions: { inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'self-actions', exportName: 'activate' } },
                inputSchema, resultSchema, run: async () => ({ accepted: true as const }) } },
            contributesTo: { [target.manifest.id]: { sources: { self: protocol.contribute({
                operations: { inspect: protocol.operations.inspect.bind('inspect') },
            }) } } },
        });
        const parsed = ingestPluginManifestV2(self.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const account = { ...rows()[0]!, manifest: parsed.manifest };
        const machine = { ...account, occurrenceId: 'current-machine-target',
            sourceCustody: DevelopmentPluginSourceCustodyV1Schema.parse({ kind: 'development', registeredRootId: 'self-machine-root' }) };
        const merge = (machineRow: typeof machine) => mergeTargetedContributionManifestDeclarations({
            targetPluginId: self.manifest.id, accountDeclarations: [account], machineDeclarations: [machineRow],
        });
        const mounted = await admittedOperation(merge(machine));
        expect(mounted.targetSourceCustody).toEqual(machine.sourceCustody);
        expect(mounted.operation.identity.contributor.sourceCustody).toEqual(account.sourceCustody);
        const seed = { plugin: { id: self.manifest.id }, occurrenceId: account.occurrenceId };
        expect(requireAdmittedTargetedOperationExecutionBinding(mounted.operation, seed, merge(machine)).contributorOccurrenceId)
            .toBe(account.occurrenceId);
        expect(() => requireAdmittedTargetedOperationExecutionBinding(mounted.operation, seed, merge({ ...machine,
            sourceCustody: { ...machine.sourceCustody, registeredRootId: 'replacement-machine-root' },
        }))).toThrowError(expect.objectContaining({ code: 'plugin_action_generation_retired' }));
    });

    it('carries current Machine target custody from an Account declaration through selection and one-shot input reconstruction', async () => {
        const [accountTarget, accountSource] = rows();
        if (!accountTarget || !accountSource) throw new Error('Expected external target and source declarations');
        const machineTarget: TargetedContributionManifestDeclaration = {
            ...accountTarget, occurrenceId: 'machine-target-current',
            sourceCustody: DevelopmentPluginSourceCustodyV1Schema.parse({ kind: 'development', registeredRootId: 'machine-target-root' }),
        };
        const machineSource: TargetedContributionManifestDeclaration = {
            ...accountSource, occurrenceId: 'machine-source-current',
            sourceCustody: DevelopmentPluginSourceCustodyV1Schema.parse({ kind: 'development', registeredRootId: 'machine-source-root' }),
            manifest: { ...accountSource.manifest, contributes: { ...accountSource.manifest.contributes,
                actions: accountSource.manifest.contributes.actions.map(action => ({ ...action, execution: { target: 'daemon' as const } })),
            } },
        };
        const mounted = await admittedOperation(mergeTargetedContributionManifestDeclarations({
            targetPluginId: target.manifest.id, accountDeclarations: [accountTarget], machineDeclarations: [machineTarget, machineSource],
        }));
        const selection = { target: { pluginId: target.manifest.id, sourceCustody: mounted.targetSourceCustody },
            point: { pointId: 'sources', protocol: target.contributionPoints.sources.protocol },
            contributor: { pluginId: source.manifest.id, contributionId: 'personal-source', sourceCustody: mounted.contributorSourceCustody },
        };
        const declarations = [machineTarget, machineSource];
        const signal = new AbortController().signal;
        const service = createManifestTargetedContributionsService({ readCurrentDeclarations: () => declarations,
            subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: target.manifest.id, signal, isCurrent: () => true });
        const selected = await selectCurrentTargetedContribution({ service, point: target.contributionPoints.sources, selection, operationRole: 'inspect' });
        expect(selected.kind).toBe('selected');
        if (selected.kind !== 'selected') throw new Error('Expected the mounted selection to reach its current Machine owner');
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: machineTarget.occurrenceId };
        const binding = requireAdmittedTargetedOperationExecutionBinding(selected.contribution.operations.inspect, seed, declarations);
        const input = { id: 'chosen' };
        const carrier = PluginUiSelectedActionInputCarrierV1Schema.parse({ operation: binding.operation,
            result: { kind: 'submitted', action: binding.action, input, selection, connectedAccount: { kind: 'none' },
                presentation: { connectedAccountLabel: null, machineDisplayName: null } },
        });
        const claimed = { current: false };
        let mountedCurrent = true;
        const reconstruct = (candidateInput = input) => resolveAdmittedTargetedOperationInput({
            seed: { plugin: seed.plugin, sourceCustody: machineTarget.sourceCustody,
                selectedActionInputCarrier: carrier, isMountedCallerCurrent: async () => mountedCurrent },
            binding, input: candidateInput, expectedSelectedConnectedAccountRef: null, selectedActionInputClaimed: claimed, signal,
            assertCurrent() { requireAdmittedTargetedOperationExecutionBinding(selected.contribution.operations.inspect, seed, declarations); },
        });
        await expect(reconstruct({ id: 'not-selected' })).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
        expect(claimed.current).toBe(false);
        mountedCurrent = false;
        await expect(reconstruct()).rejects.toMatchObject({ code: 'plugin_mounted_caller_unavailable' });
        expect(claimed.current).toBe(false);
        mountedCurrent = true;
        const concurrent = await Promise.allSettled([reconstruct(), reconstruct()]);
        expect(concurrent.filter(result => result.status === 'fulfilled').map(result => result.value)).toEqual([input]);
        expect(concurrent.filter(result => result.status === 'rejected').map(result => result.reason)).toEqual([
            expect.objectContaining({ code: 'plugin_selected_action_input_invalid' }),
        ]);
        await expect(reconstruct()).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
    });

    it('does not disclose an old selected Account to a new source custody with the same operation occurrence', async () => {
        const providerInput = defineProtocolObject({ id: defineProtocolString(), account: QualifiedConnectedAccountRefSchema }, { policy: 'closed' });
        const credentialProtocol = defineContributionProtocol({ id: 'credential-source', version: 1, operations: {
            inspect: { required: true, input: { kind: 'contributorDefined' }, resultSchema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const credentialTarget = definePlugin({ id: 'external.credential-target', version: '1.0.0',
            contributionPoints: { sources: credentialProtocol.point() },
        });
        const credentialSource = definePlugin({ id: 'external.credential-source', version: '1.0.0', actions: {
            inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: providerInput, resultSchema,
                inputHints: { fields: [{ path: 'account', title: 'Account', widget: 'select', connectedAccountOptions: true }] },
                execution: { target: 'account', account: { artifactId: 'credential-source', exportName: 'activateAccount' } },
                run: async () => ({ accepted: true as const }),
            },
        }, contributesTo: { [credentialTarget.manifest.id]: { sources: {
            source: credentialProtocol.contribute({ operations: { inspect: credentialProtocol.operations.inspect.bind('inspect') } }),
        } } } });
        let declarations: readonly TargetedContributionManifestDeclaration[] = [credentialTarget, credentialSource].map(plugin => {
            const parsed = ingestPluginManifestV2(plugin.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            return { manifest: parsed.manifest, occurrenceId: `${plugin.manifest.id}:current`,
                sourceCustody: AccountReleasePluginSourceCustodyV1Schema.parse({ kind: 'account_release',
                    pluginId: plugin.manifest.id, version: plugin.manifest.version, archiveDigestSha256: `sha256:${'a'.repeat(64)}` }),
            };
        });
        const signal = new AbortController().signal;
        const observation = createManifestTargetedContributionsService({ readCurrentDeclarations: () => declarations,
            subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: credentialTarget.manifest.id, signal, isCurrent: () => true })
            .observeForSelf(credentialTarget.contributionPoints.sources, { onInvalidated() {} });
        const account = QualifiedConnectedAccountRefSchema.parse({ service: { pluginId: 'external.accounts', localId: 'mailbox' }, accountId: 'account-a' });
        const seed = { plugin: { id: credentialTarget.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
        const input = { id: 'selected-row' };
        try {
            const original = (await observation.readCurrent()).contributions[0]!.operations.inspect;
            const originalBinding = requireAdmittedTargetedOperationExecutionBinding(original, seed, declarations);
            const carrierFor = (binding: typeof originalBinding) => PluginUiSelectedActionInputCarrierV1Schema.parse({
                operation: binding.operation, result: { kind: 'submitted', action: binding.action, input,
                    selection: { target: { pluginId: seed.plugin.id, sourceCustody: declarations[0]!.sourceCustody },
                        point: binding.operation.point, contributor: { pluginId: binding.operation.contributor.pluginId,
                            contributionId: binding.operation.contributor.contributionId, sourceCustody: binding.operation.contributor.sourceCustody } },
                    connectedAccount: { kind: 'selected', fieldPath: 'account', ref: account },
                    presentation: { connectedAccountLabel: 'Selected account', machineDisplayName: null },
                },
            });
            const retained = carrierFor(originalBinding);
            declarations = declarations.map((row, index) => index === 1 ? { ...row, sourceCustody:
                AccountReleasePluginSourceCustodyV1Schema.parse({ kind: 'account_release', pluginId: credentialSource.manifest.id,
                    version: credentialSource.manifest.version, archiveDigestSha256: `sha256:${'b'.repeat(64)}` }),
            } : row);
            const current = (await observation.readCurrent()).contributions[0]!.operations.inspect;
            const binding = requireAdmittedTargetedOperationExecutionBinding(current, seed, declarations);
            const reconstruct = (carrier: typeof retained) => resolveAdmittedTargetedOperationInput({
                seed: { plugin: seed.plugin, sourceCustody: declarations[0]!.sourceCustody,
                    selectedActionInputCarrier: carrier,
                    // The mounted target remains current at the external UI boundary.
                    isMountedCallerCurrent: async () => true,
                },
                assertCurrent() { requireAdmittedTargetedOperationExecutionBinding(current, seed, declarations); },
                binding, input, expectedSelectedConnectedAccountRef: account, selectedActionInputClaimed: { current: false }, signal,
            });
            expect(providerInput.parse(await reconstruct(carrierFor(binding))).account).toEqual(account);
            await expect(reconstruct(retained)).rejects.toMatchObject({
                code: 'plugin_selected_action_input_invalid', actionHandlerInvocation: 'notStarted',
            });
            expect(input).toEqual({ id: 'selected-row' });
        } finally { observation.dispose(); }
    });

    it('omits a contributor-owned constructor role unknown to the current target', async () => {
        const declarations = rows().map((row, index) => index === 1 ? { ...row, manifest: { ...row.manifest,
            contributes: { ...row.manifest.contributes, targetedPluginContributions: row.manifest.contributes.targetedPluginContributions
                .map(entry => ({ ...entry, operations: { ...entry.operations, constructor: 'inspect' } })),
            },
        } } : row);
        const contributions = await readContributions(declarations);
        expect(contributions).toHaveLength(1);
        expect(Object.keys(contributions[0]!.operations)).toEqual(['inspect']);
    });

    it('rejects a contribution missing a target-required constructor role', async () => {
        const operation = { required: true, input: { kind: 'protocolDefined' as const, schema: inputSchema },
            resultSchema, action: { surfaces: ['plugin'] as const, dangerLevel: 'safe' as const } };
        const required = definePlugin({ id: target.manifest.id, version: target.manifest.version,
            contributionPoints: { sources: defineContributionProtocol({ id: 'external-account-source', version: 1,
                operations: { inspect: operation, constructor: operation },
            }).point() },
        });
        const parsed = ingestPluginManifestV2(required.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const declarations = rows().map((row, index) => index === 0 ? { ...row, manifest: parsed.manifest } : row);
        await expect(readContributions(declarations)).resolves.toEqual([]);
    });

    it('resolves a retained selection only from its requested exact current operation source', async () => {
        const { targetRow, account, machine } = mixedRoleRows();
        let current = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [targetRow, account], machineDeclarations: [machine],
        });
        const service = createManifestTargetedContributionsService({ readCurrentDeclarations: () => current,
            subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: target.manifest.id, signal: new AbortController().signal, isCurrent: () => true });
        const selection = { target: { pluginId: target.manifest.id, sourceCustody: targetRow.sourceCustody },
            point: { pointId: 'sources', protocol: target.contributionPoints.sources.protocol },
            contributor: { pluginId: account.manifest.id, contributionId: 'personal-source', sourceCustody: machine.sourceCustody },
        };
        const selected = await selectCurrentTargetedContribution({ service, point: target.contributionPoints.sources, selection, operationRole: 'scan' });
        expect(selected.kind).toBe('selected');
        if (selected.kind !== 'selected') throw new Error('Expected the current operation source selection');
        expect(requireAdmittedTargetedOperationExecutionBinding(selected.contribution.operations.scan, {
            plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId,
        }, current).contributorOccurrenceId).toBe(machine.occurrenceId);
        await expect(selectCurrentTargetedContribution({ service, point: target.contributionPoints.sources, selection, operationRole: 'inspect' }))
            .resolves.toEqual({ kind: 'unavailable', reason: 'contributor_unavailable' });
        await expect(selectCurrentTargetedContribution({ service, point: target.contributionPoints.sources, selection }))
            .resolves.toEqual({ kind: 'unavailable', reason: 'contributor_unavailable' });
        current = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [targetRow, account], machineDeclarations: [{ ...machine, sourceCustody:
                DevelopmentPluginSourceCustodyV1Schema.parse({ kind: 'development', registeredRootId: 'replacement-machine-root' }),
            }],
        });
        await expect(selectCurrentTargetedContribution({ service, point: target.contributionPoints.sources, selection, operationRole: 'scan' }))
            .resolves.toEqual({ kind: 'unavailable', reason: 'contributor_unavailable' });
    });

    it('keeps an independently bound Account constructor source current beside a Machine role', async () => {
        const { targetRow, account, machine } = mixedRoleRows();
        const selected = { ...account, manifest: { ...account.manifest, contributes: { ...account.manifest.contributes,
            targetedPluginContributions: [...account.manifest.contributes.targetedPluginContributions, {
                ...account.manifest.contributes.targetedPluginContributions[0]!, id: 'constructor',
                operations: { inspect: 'inspect', call: 'inspect' },
            }],
        } } };
        const current = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [targetRow, selected], machineDeclarations: [machine],
        });
        const contributions = await readContributions(current);
        const independent = contributions.find(entry => entry.contributor.contributionId === 'constructor');
        expect(independent).toBeDefined();
        expect(requireAdmittedTargetedOperationExecutionBinding(independent!.operations.call, {
            plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId,
        }, current).contributorOccurrenceId).toBe(account.occurrenceId);
    });

    it('retains privately issued bundled source custody when a public nested package identity is mutated', async () => {
        const declarations = rows().map((row, index) => index === 1 ? { ...row, sourceCustody: {
            kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/actions-a' },
        } } : row);
        const operation = (await readContributions(declarations))[0]!.operations.inspect;
        const custody = operation.identity.contributor.sourceCustody;
        if (custody.kind !== 'bundled_first_party') throw new Error('Expected the real bundled Account source shape');
        Reflect.set(custody.packagedRuntime, 'packageName', '@acme/actions-b');
        const changed = declarations.map((row, index) => index === 1 ? { ...row, sourceCustody: {
            kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/actions-b' },
        } } : row);
        expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, {
            plugin: { id: target.manifest.id }, occurrenceId: declarations[0]!.occurrenceId,
        }, changed)).toThrowError(expect.objectContaining({ code: 'plugin_action_generation_retired' }));
    });

    it('does not expose mutable host custody state through public descriptor snapshots', async () => {
        const declarations = rows().map(row => ({ ...row, sourceCustody: {
            kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'source_declaration' as const, packageName: row.manifest.id },
        } }));
        const { targetSourceCustody, contributorSourceCustody } = await admittedOperation(declarations);
        const original = declarations.map(row => normalizePluginSourceCustodyV1(row.sourceCustody));
        for (const custody of [targetSourceCustody, contributorSourceCustody]) {
            if (custody.kind !== 'bundled_first_party') throw new Error('Expected the bundled host custody shape');
            Reflect.set(custody.packagedRuntime, 'packageName', '@acme/replacement');
        }
        expect(declarations.map(row => row.sourceCustody)).toEqual(original);
    });

    it('releases an in-flight host declaration read when its observation read is cancelled', async () => {
        const cancellation = new AbortController();
        let startRead!: () => void;
        const started = new Promise<void>(resolve => { startRead = resolve; });
        let settleRead!: (value: readonly TargetedContributionManifestDeclaration[]) => void;
        let transportReleased = false;
        const service = createManifestTargetedContributionsService({
            readCurrentDeclarations(signal?: AbortSignal) {
                const read = new Promise<readonly TargetedContributionManifestDeclaration[]>(resolve => { settleRead = resolve; });
                signal?.addEventListener('abort', () => { transportReleased = true; settleRead(rows()); }, { once: true });
                startRead();
                return read;
            },
            subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: target.manifest.id, signal: new AbortController().signal, isCurrent: () => true });
        const observation = service.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
        const pending = observation.readCurrent({ signal: cancellation.signal });
        try {
            await started;
            cancellation.abort();
            await expect(pending).rejects.toMatchObject({ code: 'plugin_targeted_contributions_aborted' });
            expect(transportReleased).toBe(true);
        } finally { settleRead(rows()); observation.dispose(); }
    });

    it('selects renderer chains from each contribution occurrence rather than another release of the same plugin', () => {
        const detailProtocol = defineContributionProtocol({ id: 'source-detail', version: 1,
            operations: { inspect: { required: true, input: { kind: 'protocolDefined', schema: inputSchema },
                resultSchema, action: { surfaces: ['plugin'], dangerLevel: 'safe' } } },
            surfaces: { detail: { required: true, inputSchema, presentation: 'content' } },
        });
        const detailTarget = definePlugin({ id: 'external.detail-target', version: '1.0.0', contributionPoints: { sources: detailProtocol.point() } });
        const parsed = ingestPluginManifestV2(detailTarget.manifest);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const pluginId = source.manifest.id;
        const action = rows()[1]!.manifest.contributes.actions[0]!;
        const occurrences = ['account-source', 'machine-source'];
        const targetedPluginContributions = occurrences.map(occurrenceId => ({ pluginId, occurrenceId,
            definition: PluginTargetedContributionV1Schema.parse({
                id: occurrenceId, target: { pluginId: detailTarget.manifest.id, pointId: 'sources' },
                protocol: { id: 'source-detail', version: 1 }, operations: { inspect: action.id }, surfaces: { detail: { renderer: 'detail' } },
            }),
        }));
        const readmission = vi.spyOn(PluginUiRendererChainBindingV1Schema, 'safeParse');
        try {
            const resolved = resolveAdmittedTargetedContributions({
                pluginContributionPoints: parsed.manifest.contributes.pluginContributionPoints.map(definition => ({
                    pluginId: detailTarget.manifest.id, occurrenceId: 'account-target', definition,
                })),
                targetedPluginContributions,
                actions: occurrences.map(occurrenceId => ({ pluginId, occurrenceId, definition: projectTargetedContributionActionDefinition(action) })),
                uiRenderersV2: occurrences.map(occurrenceId => ({ pluginId, occurrenceId,
                    identity: createPluginContributionIdentity({ pluginId, localId: 'detail' }),
                    definition: { id: 'detail', sourceOccurrence: occurrenceId },
                })),
                occurrenceIdsByPluginId: {},
            });
            const snapshot = resolved.read({ targetPluginId: detailTarget.manifest.id, pointId: 'sources', protocol: { id: 'source-detail', version: 1 } });
            expect(snapshot?.contributions.map(entry => [entry.contributor.occurrenceId, entry.surfaces[0]?.rendererChain[0]?.definition.sourceOccurrence]))
                .toEqual(occurrences.map(occurrenceId => [occurrenceId, occurrenceId]));
            expect(readmission).not.toHaveBeenCalled();
        } finally {
            readmission.mockRestore();
        }
    });

    it('keeps Machine roles of a mixed source when no Account release of that source is selected', async () => {
        const { targetRow, machine } = mixedRoleRows();
        const merged = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [targetRow], machineDeclarations: [machine],
        });
        const contributions = await readContributions(merged);
        expect(contributions).toHaveLength(1);
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId };
        expect(requireAdmittedTargetedOperationExecutionBinding(contributions[0]!.operations.scan, seed, merged).contributorOccurrenceId)
            .toBe(machine.occurrenceId);
        expect(() => requireAdmittedTargetedOperationExecutionBinding(contributions[0]!.operations.inspect, seed, merged))
            .toThrowError(expect.objectContaining({ code: 'plugin_targeted_contributions_unavailable' }));
    });

    it('binds Account and Machine roles of the same contribution to their own exact declarations', async () => {
        const { targetRow, account, machine } = mixedRoleRows();
        const merged = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [targetRow, account], machineDeclarations: [machine],
        });
        const contributions = await readContributions(merged);
        expect(contributions).toHaveLength(1);
        const contribution = contributions[0]!;
        expect(contribution.operations.inspect.identity.contributor).toMatchObject({ occurrenceId: account.occurrenceId, sourceCustody: account.sourceCustody });
        expect(contribution.operations.scan!.identity.contributor).toMatchObject({ occurrenceId: machine.occurrenceId, sourceCustody: machine.sourceCustody });
        const binding = requireAdmittedTargetedOperationExecutionBinding(contribution.operations.scan, {
            plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId,
        }, merged);
        expect(binding.action.localId).toBe('machine-inspect-current');
        const unavailable = merged.map((row) => row.operationSourcesByContributionId
            ? { ...row, operationSourcesByContributionId: Object.fromEntries(Object.entries(row.operationSourcesByContributionId)
                .map(([id, roles]) => [id, { ...roles, scan: { ...roles.scan!, unavailable: true as const } }])) }
            : row);
        expect(() => requireAdmittedTargetedOperationExecutionBinding(contribution.operations.scan, {
            plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId,
        }, unavailable)).toThrowError(expect.objectContaining({ code: 'plugin_targeted_contributions_unavailable' }));
        expect(() => requireAdmittedTargetedOperationExecutionBinding(contribution.operations.scan, {
            plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId,
        }, merged.filter((row) => row.occurrenceId !== machine.occurrenceId))).toThrowError(
            expect.objectContaining({ code: 'plugin_action_generation_retired' }),
        );
    });

    it('keeps the Account role usable when the actual Machine no longer declares the other role', async () => {
        const { targetRow, account, machine } = mixedRoleRows();
        const missing = { ...machine, manifest: { ...machine.manifest, contributes: { ...machine.manifest.contributes,
            targetedPluginContributions: machine.manifest.contributes.targetedPluginContributions.map((entry) => ({
                ...entry, operations: { inspect: 'inspect' },
            })),
        } } };
        const merged = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [targetRow, account], machineDeclarations: [missing],
        });
        const contributions = await readContributions(merged);
        expect(contributions).toHaveLength(1);
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId };
        expect(requireAdmittedTargetedOperationExecutionBinding(contributions[0]!.operations.inspect, seed, merged).contributorOccurrenceId)
            .toBe(account.occurrenceId);
        expect(() => requireAdmittedTargetedOperationExecutionBinding(contributions[0]!.operations.scan, seed, merged))
            .toThrowError(expect.objectContaining({ code: 'plugin_targeted_contributions_unavailable' }));
    });

    it('uses exact Machine source identity only for bound Machine roles, ignoring unrelated Actions', () => {
        const declarations = rows();
        const accountSource = declarations[1]!;
        const machineOnly: TargetedContributionManifestDeclaration = {
            ...accountSource,
            sourceCustody: { ...accountSource.sourceCustody, pluginId: 'external.machine-source' },
            manifest: { ...accountSource.manifest, id: 'external.machine-source', contributes: {
                ...accountSource.manifest.contributes,
                actions: [
                    { ...accountSource.manifest.contributes.actions[0]!, execution: { target: 'daemon' } },
                    { ...accountSource.manifest.contributes.actions[0]!, id: 'unrelated-settings' },
                ],
            } },
        };
        const actualMachine = { ...machineOnly, occurrenceId: 'actual-machine-occurrence' };
        const merged = mergeTargetedContributionManifestDeclarations({
            targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, machineOnly], machineDeclarations: [actualMachine, { ...declarations[0]!, occurrenceId: 'machine-target' }],
        });
        expect(merged.find((row) => row.manifest.id === target.manifest.id)).toBe(declarations[0]);
        expect(merged.find((row) => row.manifest.id === machineOnly.manifest.id)?.occurrenceId).toBe('actual-machine-occurrence');
        expect(merged.find((row) => row.manifest.id === source.manifest.id)?.occurrenceId).toBe(accountSource.occurrenceId);
        expect(mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, machineOnly], machineDeclarations: [],
        }).find((row) => row.manifest.id === machineOnly.manifest.id)).toBe(machineOnly);
        expect(mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: declarations, machineDeclarations: [actualMachine],
        }).find((row) => row.manifest.id === machineOnly.manifest.id)).toEqual(actualMachine);
    });

    it('preserves independent Account and Machine sources declared by one plugin without a Machine', async () => {
        const declarations = rows();
        const accountSource = declarations[1]!;
        const mixed: TargetedContributionManifestDeclaration = {
            ...accountSource,
            sourceCustody: { ...accountSource.sourceCustody, pluginId: 'external.mixed-source' },
            manifest: { ...accountSource.manifest, id: 'external.mixed-source', contributes: {
                ...accountSource.manifest.contributes,
                actions: [...accountSource.manifest.contributes.actions,
                    { ...accountSource.manifest.contributes.actions[0]!, id: 'machine-inspect', execution: { target: 'daemon' } }],
                targetedPluginContributions: [...accountSource.manifest.contributes.targetedPluginContributions,
                    { ...accountSource.manifest.contributes.targetedPluginContributions[0]!, id: 'machine-source', operations: { inspect: 'machine-inspect' } }],
            } },
        };
        const merged = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, mixed], machineDeclarations: [],
        });
        expect(merged.find((row) => row.manifest.id === source.manifest.id)).toBe(accountSource);
        expect(merged.find((row) => row.manifest.id === mixed.manifest.id)?.manifest.contributes.targetedPluginContributions
            .map((entry) => entry.id)).toEqual(mixed.manifest.contributes.targetedPluginContributions.map((entry) => entry.id));
        const machine = { ...mixed, occurrenceId: 'machine-mixed', sourceCustody: DevelopmentPluginSourceCustodyV1Schema.parse({
            kind: 'development', registeredRootId: 'machine-mixed-root',
        }) };
        const current = mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations: [...declarations, mixed], machineDeclarations: [machine],
        });
        const admitted = (await readContributions(current)).filter((entry) => entry.contributor.pluginId === mixed.manifest.id);
        expect(admitted).toHaveLength(2);
        expect(admitted.find((entry) => entry.contributor.contributionId === 'personal-source')?.operations.inspect.identity.contributor.occurrenceId)
            .toBe(mixed.occurrenceId);
        expect(admitted.find((entry) => entry.contributor.contributionId === 'machine-source')?.operations.inspect.identity.contributor.occurrenceId)
            .toBe(machine.occurrenceId);
    });

    it('preserves an Account source release when a different release is also installed on the Machine', async () => {
        const declarations = rows();
        const machineSource = { ...declarations[1]!,
            manifest: { ...declarations[1]!.manifest, version: '2.0.0' },
            occurrenceId: 'different-machine-release', sourceCustody: {
            ...declarations[1]!.sourceCustody, version: '2.0.0', archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
        } };
        const merged = mergeTargetedContributionManifestDeclarations({
            targetPluginId: target.manifest.id, accountDeclarations: declarations, machineDeclarations: [machineSource],
        });
        const service = createManifestTargetedContributionsService({
            readCurrentDeclarations: () => merged, subscribeToCatalogChanges: () => () => {},
        }).bind({ pluginId: target.manifest.id, signal: new AbortController().signal, isCurrent: () => true });
        const observation = service.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
        try {
            const snapshot = await observation.readCurrent();
            const operation = snapshot.contributions[0]!.operations.inspect;
            expect(operation.identity.contributor.occurrenceId).toBe(declarations[1]!.occurrenceId);
            expect(operation.identity.contributor.sourceCustody).toEqual(declarations[1]!.sourceCustody);
        } finally { observation.dispose(); }
    });

    it('rejects an original handle after its source release has changed without an occurrence change', async () => {
        const { declarations, operation } = await admittedOperation();
        const changed = declarations.map((row) => row.manifest.id === source.manifest.id
            ? { ...row, sourceCustody: { ...row.sourceCustody, archiveDigestSha256: `sha256:${'b'.repeat(64)}` } }
            : row);

        expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, {
            plugin: { id: target.manifest.id },
            occurrenceId: declarations[0]!.occurrenceId,
        }, changed)).toThrowError(expect.objectContaining({ code: 'plugin_action_generation_retired' }));
    });

    it('rejects an original handle after its point, protocol, role or Action is withdrawn', async () => {
        const { declarations, operation } = await admittedOperation();
        const [targetRow, sourceRow] = declarations;
        if (!targetRow || !sourceRow) throw new Error('Expected target and source declarations');
        const targetContributes = targetRow.manifest.contributes;
        const sourceContributes = sourceRow.manifest.contributes;
        for (const changed of [
            [targetRow, { ...sourceRow, manifest: { ...sourceRow.manifest, contributes: { ...sourceContributes, targetedPluginContributions: [] } } }],
            [targetRow, { ...sourceRow, manifest: { ...sourceRow.manifest, contributes: { ...sourceContributes, actions: [] } } }],
            [targetRow, { ...sourceRow, manifest: { ...sourceRow.manifest, contributes: { ...sourceContributes,
                targetedPluginContributions: sourceContributes.targetedPluginContributions.map((entry) => ({
                    ...entry, operations: { inspect: 'replacement-action' },
                })),
            } } }],
            [{ ...targetRow, manifest: { ...targetRow.manifest, contributes: { ...targetContributes, pluginContributionPoints: [] } } }, sourceRow],
            [{ ...targetRow, manifest: { ...targetRow.manifest, contributes: { ...targetContributes,
                pluginContributionPoints: targetContributes.pluginContributionPoints.map((point) => ({ ...point, protocols: [] })),
            } } }, sourceRow],
            [{ ...targetRow, manifest: { ...targetRow.manifest, contributes: { ...targetContributes,
                pluginContributionPoints: targetContributes.pluginContributionPoints.map((point) => ({ ...point,
                    protocols: point.protocols.map((declared) => ({ ...declared, operations: {} })),
                })),
            } } }, sourceRow],
        ]) {
            expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, {
                plugin: { id: target.manifest.id }, occurrenceId: targetRow.occurrenceId,
            }, changed)).toThrowError(expect.objectContaining({ code: 'plugin_admitted_targeted_operation_handle_invalid' }));
        }
    });

    it('keeps the original handle and target-owned parser pair for a current separately authored source', async () => {
        const { declarations, operation } = await admittedOperation();
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
        const binding = requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations);
        expect(readPrivateHostOperationBinding(operation)).toBe(binding);
        expect(readPrivateHostOperationBinding({ ...operation })).toBeNull();

        expect(binding.action).toEqual({ pluginId: source.manifest.id, localId: 'inspect' });
        expect(validateTargetedOperationInput(binding.targetProtocol, { id: 'task-a' })).toEqual({ ok: true, value: { id: 'task-a' } });
        expect(validateTargetedOperationInput(binding.targetProtocol, { id: 'task-a', credential: 'extra' })).toMatchObject({
            ok: false,
            result: { errorCode: 'plugin_targeted_operation_input_invalid', actionHandlerInvocation: 'notStarted' },
        });
        expect(validateTargetedOperationResult(binding.targetProtocol, { accepted: true })).toEqual({ ok: true, value: { accepted: true } });
        expect(validateTargetedOperationResult(binding.targetProtocol, { accepted: false })).toEqual({
            ok: false,
            result: { ok: false, errorCode: 'plugin_targeted_operation_result_invalid', error: expect.any(String) },
        });
        expect(() => requireAdmittedTargetedOperationExecutionBinding({ ...operation }, seed, declarations)).toThrowError(
            expect.objectContaining({ code: 'plugin_admitted_targeted_operation_handle_invalid' }),
        );
    });

    it('checks an admitted operation across awaits without reading Action schemas again, while observing role withdrawal', async () => {
        let schemaReads = 0;
        const declarations = rows().map((row) => ({ ...row, manifest: { ...row.manifest, contributes: {
            ...row.manifest.contributes,
            actions: row.manifest.contributes.actions.map((action) => ({ ...action,
                get inputSchema() { schemaReads += 1; return action.inputSchema; },
                get resultSchema() { schemaReads += 1; return action.resultSchema; },
            })),
        } } }));
        const { operation } = await admittedOperation(declarations);
        expect(schemaReads).toBeGreaterThan(0);
        schemaReads = 0;
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
        // Preparation, preflight and target admission resume the same opaque handle.
        for (let phase = 0; phase < 3; phase += 1) {
            await Promise.resolve();
            expect(requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations).action.localId).toBe('inspect');
        }
        expect(schemaReads).toBe(0);

        const withdrawn = declarations.map((row) => row.manifest.id === source.manifest.id
            ? { ...row, manifest: { ...row.manifest, contributes: { ...row.manifest.contributes, targetedPluginContributions: [] } } }
            : row);
        expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, seed, withdrawn)).toThrowError(
            expect.objectContaining({ code: 'plugin_admitted_targeted_operation_handle_invalid' }),
        );
        expect(schemaReads).toBe(0);
    });

    it('retires a handle when the target release or contributor occurrence has changed', async () => {
        const { declarations, operation } = await admittedOperation();
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: declarations[0]!.occurrenceId };
        for (const changed of [
            declarations.map((row) => row.manifest.id === target.manifest.id
                ? { ...row, sourceCustody: { ...row.sourceCustody, archiveDigestSha256: `sha256:${'c'.repeat(64)}` } }
                : row),
            declarations.map((row) => row.manifest.id === source.manifest.id ? { ...row, occurrenceId: 'replacement-source-occurrence' } : row),
            declarations.filter((row) => row.manifest.id !== source.manifest.id),
        ]) {
            expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, seed, changed)).toThrowError(
                expect.objectContaining({ code: 'plugin_action_generation_retired' }),
            );
        }
    });
});
