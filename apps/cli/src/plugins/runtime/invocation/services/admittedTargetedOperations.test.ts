import { describe, expect, it, vi } from 'vitest';
import { definePlugin, readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { createManifestTargetedContributionsService, mergeTargetedContributionManifestDeclarations, requireAdmittedTargetedOperationExecutionBinding, type TargetedContributionManifestDeclaration } from '@happier-dev/cli-common/plugins/registration';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import {
    defineProtocolJsonValue,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import {
    createAdmittedTargetedOperationExecutionHandle,
    createPluginInvocationActionsService,
    type InvokeContributedAction,
} from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { logger } from '@/ui/logger';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';

function permissiveTargetProtocol(role: string) {
    return Object.freeze({
        role,
        input: Object.freeze({ kind: 'contributorDefined' as const }),
        resultSchema: defineProtocolJsonValue(),
    });
}

describe('admitted targeted-operation execution', () => {
    it('keeps Account operation custody stable when Machine declarations arrive, while retiring replaced contributors', async () => {
        const schema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
        const protocol = defineContributionProtocol({ id: 'arrival', version: 1, operations: {
            inspect: { required: true, input: { kind: 'protocolDefined', schema }, resultSchema: schema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const target = definePlugin({ id: 'acme.arrival-target', version: '1.0.0', contributionPoints: { sources: protocol.point() } });
        const provider = definePlugin({ id: 'acme.arrival-source', version: '1.0.0', actions: {
            inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: schema, resultSchema: schema,
                execution: { target: 'account', account: { artifactId: 'runtime', exportName: 'activate' } },
                run: async input => input },
        }, contributesTo: { [target.manifest.id]: { sources: {
            primary: protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
        } } } });
        const accountDeclarations = [target, provider].map(plugin => ({ manifest: normalizePluginManifestV2(plugin.manifest),
            occurrenceId: `${plugin.manifest.id}:account`, sourceCustody: createManagedPluginSourceCustody(`${plugin.manifest.id}:account`) }));
        let machineDeclarations: readonly TargetedContributionManifestDeclaration[] = [];
        const declarations = () => mergeTargetedContributionManifestDeclarations({ targetPluginId: target.manifest.id,
            accountDeclarations, machineDeclarations });
        const observation = createManifestTargetedContributionsService({ readCurrentDeclarations: declarations,
            subscribeToCatalogChanges: () => () => {} }).bind({ pluginId: target.manifest.id,
            signal: new AbortController().signal, isCurrent: () => true }).observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
        const seed = { plugin: { id: target.manifest.id }, occurrenceId: accountDeclarations[0]!.occurrenceId };
        try {
            const before = await observation.readCurrent();
            const operation = before.contributions[0]!.operations.inspect;
            machineDeclarations = accountDeclarations.map(row => ({ ...row, occurrenceId: `${row.manifest.id}:machine`,
                sourceCustody: createManagedPluginSourceCustody(`${row.manifest.id}:machine`) }));
            const after = await observation.readCurrent();
            // Portable selection still names the Machine target, while Account execution keeps its own authority.
            expect(after.sourceCustody).toEqual(machineDeclarations[0]!.sourceCustody);
            expect(requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations()).action)
                .toEqual({ pluginId: provider.manifest.id, localId: 'inspect' });
            expect(requireAdmittedTargetedOperationExecutionBinding(after.contributions[0]!.operations.inspect, seed, declarations()).action)
                .toEqual({ pluginId: provider.manifest.id, localId: 'inspect' });
            const originalTarget = accountDeclarations[0]!;
            accountDeclarations[0] = { ...originalTarget, sourceCustody: createManagedPluginSourceCustody('replacement-target') };
            expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations()))
                .toThrow(expect.objectContaining({ code: 'plugin_action_generation_retired' }));
            accountDeclarations[0] = originalTarget;
            accountDeclarations[1] = { ...accountDeclarations[1]!, occurrenceId: 'replacement' };
            expect(() => requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations()))
                .toThrow(expect.objectContaining({ code: 'plugin_action_generation_retired' }));
        } finally { observation.dispose(); }
    });

    it('retains read observation only for the original admitted handle and retires it with demand', async () => {
        const controller = new AbortController();
        let active = 0;
        let invalidated = 0;
        let retired = 0;
        let publish = () => {};
        let retire = () => {};
        const handle = createAdmittedTargetedOperationExecutionHandle({
            action: { pluginId: 'acme.source', localId: 'inspect' }, targetOccurrenceId: 'target-a',
            identity: { target: { pluginId: 'acme.target' }, point: { pointId: 'sources', protocol: { id: 'acme.source/inspect', version: 1 } },
                contributor: { pluginId: 'acme.source', contributionId: 'primary', occurrenceId: 'source-a', sourceCustody: createManagedPluginSourceCustody('source-a') }, role: 'inspect' },
            targetProtocol: permissiveTargetProtocol('inspect'),
        });
        const service = createPluginInvocationActionsService({ seed: {
            plugin: { id: 'acme.target', version: '1.0.0' }, contribution: { id: 'read', qualifiedId: 'acme.target/actions/read' },
            occurrenceId: 'target-a', sourceCustody: createManagedPluginSourceCustody('target-a'),
            surface: 'plugin', signal: controller.signal, isOccurrenceCurrent: () => true,
            retireReadObservation() { retired++; },
        }, actionExecutor: { execute: vi.fn() },
        // Cross-host dispatch boundary: admission/opaque-handle validation above stays real.
        invokeContributedAction: async request => {
            if (!request.requiredReadOnly || !request.readObservation) throw new Error('Unconstrained observation');
            await request.beforeHandlerInvocation?.();
            active++;
            publish = request.readObservation.invalidate;
            retire = () => request.readObservation?.retire?.();
            let disposed = false;
            request.readObservation.accept({ dispose() { if (!disposed) { disposed = true; active--; } } });
            return { status: 'executed', value: null };
        } });
        const subscription = await service.observeAdmittedTargetedOperation(handle, { key: 'selected' }, () => { invalidated++; });
        expect(active).toBe(1);
        publish();
        await Promise.resolve();
        await Promise.resolve();
        expect(invalidated).toBe(1);
        expect(retired).toBe(0);
        retire();
        expect(retired).toBe(1);
        expect(invalidated).toBe(1);
        expect(active).toBe(0);
        await expect(service.observeAdmittedTargetedOperation({ ...handle }, { key: 'selected' }, () => {}))
            .rejects.toMatchObject({ code: 'plugin_admitted_targeted_operation_handle_invalid' });
        controller.abort();
        expect(active).toBe(0);
        await subscription.dispose();
        expect(active).toBe(0);
    });
    it.each([
        { change: 'target-retired', beforeAdmission: false, withOrigin: false },
        { change: 'role-removed', beforeAdmission: false, withOrigin: false },
        { change: 'target-retired', beforeAdmission: true, withOrigin: false },
        { change: 'target-retired', beforeAdmission: true, withOrigin: true },
    ] as const)('retains the original operation failure identity ($change, before admission: $beforeAdmission, with origin: $withOrigin)', async ({ change, beforeAdmission, withOrigin }) => {
        const inputSchema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
        const resultSchema = defineProtocolObject({ accepted: defineProtocolLiteral(true) }, { policy: 'closed' });
        const protocol = defineContributionProtocol({ id: 'dispatch-fence', version: 1, operations: {
            inspect: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
                action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
        } });
        const target = definePlugin({ id: 'acme.fence-target', version: '1.0.0', contributionPoints: { sources: protocol.point() } });
        let effects = 0;
        const source = definePlugin({ id: 'acme.fence-source', version: '1.0.0', entrypoints: { daemon: './daemon.js' }, actions: {
            inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema, resultSchema,
                run: async () => { effects++; return { accepted: true as const }; } },
        }, contributesTo: { [target.manifest.id]: { sources: {
            source: protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
        } } } });
        let declarations: readonly TargetedContributionManifestDeclaration[] = [target, source].map(plugin => ({
            manifest: normalizePluginManifestV2(plugin.manifest), occurrenceId: `${plugin.manifest.id}:current`,
            sourceCustody: createManagedPluginSourceCustody(plugin.manifest.id),
        }));
        const signal = new AbortController().signal;
        const observation = createManifestTargetedContributionsService({ readCurrentDeclarations: () => declarations,
            subscribeToCatalogChanges: () => () => {} }).bind({ pluginId: target.manifest.id, signal, isCurrent: () => true })
            .observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
        const providerHost = await createPluginTestkit({ manifest: source.manifest, module: source });
        let releaseDispatch = () => {};
        const dispatchReady = new Promise<void>(resolve => { releaseDispatch = resolve; });
        let reportWaiting = () => {};
        const waiting = new Promise<void>(resolve => { reportWaiting = resolve; });
        const service = createPluginInvocationActionsService({ seed: {
            plugin: { id: target.manifest.id, version: target.manifest.version },
            contribution: { id: 'aggregate', qualifiedId: `${target.manifest.id}/actions/aggregate` },
            occurrenceId: `${target.manifest.id}:current`, sourceCustody: createManagedPluginSourceCustody(target.manifest.id),
            correlationId: 'admitted-operation-trace', requestId: 'admitted-operation-request',
            surface: 'plugin', signal, isOccurrenceCurrent: () => true,
            readCurrentTargetedDeclarations: async () => declarations,
        }, actionExecutor: { execute: vi.fn() },
        // This adapter is the cross-host dispatch boundary. The public SDK host
        // below performs the real registration, parser and provider handler.
        invokeContributedAction: async request => {
            reportWaiting(); await dispatchReady;
            if ('beforeHandlerInvocation' in request && typeof request.beforeHandlerInvocation === 'function') {
                await request.beforeHandlerInvocation();
            }
            if (request.input === undefined) throw new Error('Expected admitted input');
            return { status: 'executed', value: await providerHost.invokeAction('inspect', request.input, { surface: 'plugin' }) };
        } });
        try {
            const snapshot = await observation.readCurrent();
            const operation = snapshot.contributions[0]?.operations.inspect;
            if (!operation) throw new Error('Expected the public source role');
            const retire = () => { declarations = declarations.map(row => row.manifest.id === (change === 'target-retired' ? target.manifest.id : source.manifest.id)
                ? change === 'target-retired' ? { ...row, occurrenceId: 'replacement-target' }
                    : { ...row, manifest: { ...row.manifest, contributes: { ...row.manifest.contributes, targetedPluginContributions: [] } } }
                : row); };
            if (beforeAdmission) retire();
            const invoking = withOrigin
                ? service.executeAdmittedTargetedOperationWithExecutionOrigin(operation, { key: 'value' })
                : service.executeAdmittedTargetedOperation(operation, { key: 'value' });
            if (!beforeAdmission) {
                await Promise.race([waiting, invoking.then(() => { throw new Error('Operation settled before the dispatch wait'); })]);
                retire();
            }
            releaseDispatch();
            const error: unknown = await invoking.catch(error => error);
            expect(error).toMatchObject({ code: change === 'target-retired'
                ? 'plugin_action_generation_retired' : 'plugin_admitted_targeted_operation_handle_invalid', actionHandlerInvocation: 'notStarted' });
            expect(readPluginErrorRequestIdV1(error)).toBe('admitted-operation-request');
            expect(effects).toBe(0);
        } finally { releaseDispatch(); observation.dispose(); await providerHost.dispose(); }
    });

    it.each(['ordinary', 'withOrigin'] as const)('restores a retained selected Account through the real provider parser for %s calls', async (mode) => {
        const account = {
            service: { pluginId: 'acme.accounts', localId: 'mailbox' },
            accountId: 'account-a',
        } as const;
        let providerEffects = 0;
        const providerInputSchema = defineProtocolObject({
            repository: defineProtocolString(),
            auth: defineProtocolObject({ account: QualifiedConnectedAccountRefSchema }, { policy: 'closed' }),
        }, { policy: 'closed' });
        const provider = definePlugin({
            id: 'acme.provider', version: '1.0.0', displayName: 'Provider',
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
            actions: {
                setup: {
                    title: 'Set up', surfaces: ['plugin'],
                    inputSchema: providerInputSchema,
                    resultSchema: defineProtocolObject({ accountId: defineProtocolString() }, { policy: 'closed' }),
                    run: async (input) => {
                        providerEffects += 1;
                        return { accountId: providerInputSchema.parse(input).auth.account.accountId };
                    },
                },
            },
        });
        const providerHost = await createPluginTestkit({ manifest: provider.manifest, module: provider });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.target');
        const executionOrigin = {
            serverIdentityId: 'srv-target',
            materializationRef: {
                pluginId: 'acme.provider', machineId: 'machine-target', materializationId: 'provider-a',
            },
        } as const;
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.target', version: '1.0.0' },
                contribution: { id: 'retest', qualifiedId: 'acme.target/actions/retest' },
                occurrenceId: 'target-a', surface: 'plugin',
                sourceCustody: createManagedPluginSourceCustody('target-a'),
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            // The public SDK host executes the actual registration and strict
            // schema; only the cross-host transport is supplied by this fixture.
            invokeContributedAction: async (request) => {
                if (request.input === undefined) throw new Error('Admitted setup input is required');
                return {
                    status: 'executed', executionOrigin,
                    value: await providerHost.invokeAction('setup', request.input, { surface: 'plugin' }),
                };
            },
        });
        const identity = {
            target: { pluginId: 'acme.target' },
            point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider', contributionId: 'primary', occurrenceId: 'provider-a',
                sourceCustody: createManagedPluginSourceCustody('provider-a'),
            },
            role: 'setup',
        } as const;
        const handle = (selectedActionInput: Parameters<typeof createAdmittedTargetedOperationExecutionHandle>[0]['selectedActionInput']) => createAdmittedTargetedOperationExecutionHandle({
            action: { pluginId: 'acme.provider', localId: 'setup' }, targetOccurrenceId: 'target-a',
            identity, selectedActionInput, targetProtocol: permissiveTargetProtocol('setup'),
        });
        const admitted = handle({ kind: 'connectedAccount', fieldPath: 'auth.account' });
        const invoke = async (
            input: Parameters<typeof service.executeAdmittedTargetedOperation>[1],
            operation = admitted,
            expectedRef: typeof account | null = account,
        ) => {
            const options = { expectedSelectedConnectedAccountRef: expectedRef };
            return mode === 'ordinary'
                ? await service.executeAdmittedTargetedOperation(operation, input, options)
                : (await service.executeAdmittedTargetedOperationWithExecutionOrigin(operation, input, options)).result;
        };
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
        try {
            const retainedInput = { repository: 'acme/project' };
            const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
            await expect(runTracedExternalActionStage('action.invoke', `rpc_${requestId}`, 'contributed.target_invoke', () =>
                invoke(retainedInput))).resolves.toEqual({ accountId: 'account-a' });
            expect(sink.mock.calls).toContainEqual(['[external-action-stage]', expect.objectContaining({
                stage: 'contributed.targeted_operation.end', rootRequestId: requestId, elapsedMs: expect.any(Number),
            })]);
            expect(JSON.stringify(sink.mock.calls)).not.toContain('acme/project');
            await expect(invoke({ ...retainedInput, auth: { account } })).resolves.toEqual({ accountId: 'account-a' });
            await expect(invoke(retainedInput)).resolves.toEqual({ accountId: 'account-a' });
            expect(retainedInput).toEqual({ repository: 'acme/project' });
            const effectsBeforeRefusals = providerEffects;
            for (const conflicting of [
                { ...retainedInput, auth: { account: { ...account, accountId: 'account-b' } } },
                { ...retainedInput, auth: null },
            ]) {
                await expect(invoke(conflicting)).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid', actionHandlerInvocation: 'notStarted' });
            }
            await expect(invoke(retainedInput, handle({ kind: 'unavailable' }))).rejects.toMatchObject({ code: 'plugin_selected_action_input_unavailable' });
            await expect(invoke(retainedInput, handle({ kind: 'connectedAccount', fieldPath: 'auth.__proto__.account' }))).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
            await expect(invoke(retainedInput, handle({ kind: 'none' }))).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
            await expect(invoke(retainedInput, admitted, null)).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
            expect(providerEffects).toBe(effectsBeforeRefusals);
        } finally {
            sink.mockRestore();
            vi.unstubAllEnvs();
            await providerHost.dispose();
        }
    });

    it('forwards the opaque target protocol binding and raw input to the canonical dispatcher for normal and execution-origin calls', async () => {
        const targetInputSchema = defineProtocolObject({
            kind: defineProtocolLiteral('expected'),
        }, { policy: 'additive-open/drop' });
        const targetResultSchema = defineProtocolObject({
            kind: defineProtocolLiteral('expected'),
        }, { policy: 'additive-open/drop' });
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { kind: 'expected' },
            executionOrigin: {
                serverIdentityId: 'srv-target',
                materializationRef: {
                    pluginId: 'acme.contributor',
                    machineId: 'machine-target',
                    materializationId: 'immutable-contributor-a',
                },
            },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.target');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.target', version: '1.0.0' },
                contribution: { id: 'request', qualifiedId: 'acme.target/actions/request' },
                occurrenceId: 'target-occurrence-a',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-target-a', installSource: 'archive' },
                surface: 'plugin',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });
        const admitted = createAdmittedTargetedOperationExecutionHandle({
            action: { pluginId: 'acme.contributor', localId: 'publish' },
            targetOccurrenceId: 'target-occurrence-a',
            identity: {
                target: { pluginId: 'acme.target' },
                point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
                contributor: {
                    pluginId: 'acme.contributor',
                    contributionId: 'primary',
                    occurrenceId: 'contributor-occurrence-a',
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-contributor-a', installSource: 'archive' },
                },
                role: 'publish',
            },
            targetProtocol: {
                role: 'publish',
                input: { kind: 'protocolDefined', schema: targetInputSchema },
                resultSchema: targetResultSchema,
            },
        });

        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            { kind: 'expected', targetOnly: true },
        )).resolves.toEqual({ kind: 'expected' });
        expect(invokeContributedAction).toHaveBeenLastCalledWith(expect.objectContaining({
            input: { kind: 'expected', targetOnly: true },
            admittedTargetedOperation: expect.objectContaining({
                action: { pluginId: 'acme.contributor', localId: 'publish' },
                target: {
                    pluginId: 'acme.target',
                    occurrenceId: 'target-occurrence-a',
                },
                contributorOccurrenceId: 'contributor-occurrence-a',
                targetProtocol: expect.objectContaining({
                    input: { kind: 'protocolDefined', schema: targetInputSchema },
                    resultSchema: targetResultSchema,
                }),
            }),
        }));

        await expect(service.executeAdmittedTargetedOperationWithExecutionOrigin(
            admitted,
            { kind: 'expected', targetOnly: true },
        )).resolves.toMatchObject({
            result: { kind: 'expected' },
            executionOrigin: expect.objectContaining({
                materializationRef: expect.objectContaining({
                    pluginId: 'acme.contributor',
                }),
            }),
        });
        expect(invokeContributedAction).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['setup', 'connection/prepare-v1'],
        ['setupRemediation', 'connection/setup-remediate-v1'],
    ] as const)('reconstructs only the exact selected %s settlement through its Channels management Action', async (role, parentActionId) => {
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const operation = {
            point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'github',
                occurrenceId: 'provider-occurrence-a',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-occurrenceId-a', installSource: 'archive' },
            },
            role,
            action: { pluginId: 'acme.provider', localId: role === 'setup' ? 'connection/setup' : 'connection/remediate' },
        } as const;
        const selectedActionInputCarrier = {
            operation,
            result: {
                kind: 'submitted' as const,
                action: operation.action,
                input: { repository: 'happier-dev/happier' },
                selection: {
                    target: {
                        pluginId: 'happier.channels',
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-occurrenceId-a', installSource: 'archive' },
                    },
                    point: operation.point,
                    contributor: {
                        pluginId: operation.contributor.pluginId,
                        contributionId: operation.contributor.contributionId,
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-occurrenceId-a', installSource: 'archive' },
                    },
                },
                connectedAccount: {
                    kind: 'selected' as const,
                    fieldPath: 'credentialRef',
                    ref: account,
                },
                presentation: {
                    connectedAccountLabel: 'Work account',
                    machineDisplayName: 'Development Mac',
                },
            },
        } as const;
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('happier.channels');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '1.0.0' },
                contribution: { id: parentActionId, qualifiedId: `happier.channels/actions/${parentActionId}` },
                occurrenceId: 'channels-occurrence-a',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-occurrenceId-a', installSource: 'archive' },
                surface: 'plugin',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                selectedActionInputCarrier,
                isMountedCallerCurrent: async () => true,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });
        const admitted = createAdmittedTargetedOperationExecutionHandle({
            action: operation.action,
            targetOccurrenceId: 'channels-occurrence-a',
            identity: {
                target: { pluginId: 'happier.channels' },
                point: operation.point,
                contributor: operation.contributor,
                role: operation.role,
            },
            selectedActionInput: {
                kind: 'connectedAccount',
                fieldPath: 'credentialRef',
            },
            targetProtocol: permissiveTargetProtocol(operation.role),
        });

        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            selectedActionInputCarrier.result.input,
            { expectedSelectedConnectedAccountRef: account },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenLastCalledWith(expect.objectContaining({
            action: operation.action,
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'happier.channels',
                contribution: { id: parentActionId, qualifiedId: `happier.channels/actions/${parentActionId}` },
            }),
            input: {
                repository: 'happier-dev/happier',
                credentialRef: account,
            },
        }));

        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            { repository: 'tampered' },
            { expectedSelectedConnectedAccountRef: account },
        )).rejects.toMatchObject({
            code: 'plugin_selected_action_input_invalid',
            actionHandlerInvocation: 'notStarted',
        });
        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            selectedActionInputCarrier.result.input,
            {
                expectedSelectedConnectedAccountRef: {
                    service: { pluginId: 'acme.github', localId: 'github' },
                    accountId: 'account-b',
                },
            },
        )).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
        // A carrier-bound target invocation cannot fall back to the ordinary
        // admitted-operation path by omitting the outer Account correspondence.
        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            selectedActionInputCarrier.result.input,
        )).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
        const wrongRole = createAdmittedTargetedOperationExecutionHandle({
            action: operation.action,
            targetOccurrenceId: 'channels-occurrence-a',
            identity: {
                target: { pluginId: 'happier.channels' },
                point: operation.point,
                contributor: operation.contributor,
                role: 'verify',
            },
            selectedActionInput: {
                kind: 'connectedAccount',
                fieldPath: 'credentialRef',
            },
            targetProtocol: permissiveTargetProtocol('verify'),
        });
        await expect(service.executeAdmittedTargetedOperation(
            wrongRole,
            selectedActionInputCarrier.result.input,
            { expectedSelectedConnectedAccountRef: account },
        )).rejects.toMatchObject({ code: 'plugin_selected_action_input_invalid' });
        expect(invokeContributedAction).toHaveBeenCalledOnce();
    });

    it('atomically consumes one selected setup settlement while allowing its later non-selected connection test', async () => {
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const setupOperation = {
            point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'github',
                occurrenceId: 'provider-occurrence-a',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-occurrenceId-a', installSource: 'archive' },
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/setup' },
        } as const;
        const connectionTestOperation = {
            ...setupOperation,
            role: 'connectionTest',
            action: { pluginId: 'acme.provider', localId: 'connection/test' },
        } as const;
        const selectedActionInputCarrier = {
            operation: setupOperation,
            result: {
                kind: 'submitted' as const,
                action: setupOperation.action,
                input: { repository: 'happier-dev/happier' },
                selection: {
                    target: {
                        pluginId: 'happier.channels',
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-occurrenceId-a', installSource: 'archive' },
                    },
                    point: setupOperation.point,
                    contributor: {
                        pluginId: setupOperation.contributor.pluginId,
                        contributionId: setupOperation.contributor.contributionId,
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-occurrenceId-a', installSource: 'archive' },
                    },
                },
                connectedAccount: {
                    kind: 'selected' as const,
                    fieldPath: 'credentialRef',
                    ref: account,
                },
                presentation: {
                    connectedAccountLabel: 'Work account',
                    machineDisplayName: 'Development Mac',
                },
            },
        } as const;
        let releaseMountedCallerCurrent: ((value: boolean) => void) | undefined;
        const mountedCallerCurrent = new Promise<boolean>((resolve) => {
            releaseMountedCallerCurrent = resolve;
        });
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('happier.channels');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'happier.channels', version: '1.0.0' },
                contribution: { id: 'connection-create', qualifiedId: 'happier.channels/actions/connection-create' },
                occurrenceId: 'channels-occurrence-a',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'channels-occurrenceId-a', installSource: 'archive' },
                surface: 'plugin',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                selectedActionInputCarrier,
                isMountedCallerCurrent: async () => await mountedCallerCurrent,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });
        const setup = createAdmittedTargetedOperationExecutionHandle({
            action: setupOperation.action,
            targetOccurrenceId: 'channels-occurrence-a',
            identity: {
                target: { pluginId: 'happier.channels' },
                point: setupOperation.point,
                contributor: setupOperation.contributor,
                role: setupOperation.role,
            },
            selectedActionInput: { kind: 'connectedAccount', fieldPath: 'credentialRef' },
            targetProtocol: permissiveTargetProtocol(setupOperation.role),
        });
        const connectionTest = createAdmittedTargetedOperationExecutionHandle({
            action: connectionTestOperation.action,
            targetOccurrenceId: 'channels-occurrence-a',
            identity: {
                target: { pluginId: 'happier.channels' },
                point: connectionTestOperation.point,
                contributor: connectionTestOperation.contributor,
                role: connectionTestOperation.role,
            },
            targetProtocol: permissiveTargetProtocol(connectionTestOperation.role),
        });

        const firstSetup = service.executeAdmittedTargetedOperation(
            setup,
            selectedActionInputCarrier.result.input,
            { expectedSelectedConnectedAccountRef: account },
        );
        const secondSetup = service.executeAdmittedTargetedOperation(
            setup,
            selectedActionInputCarrier.result.input,
            { expectedSelectedConnectedAccountRef: account },
        );
        await Promise.resolve();
        expect(invokeContributedAction).not.toHaveBeenCalled();
        releaseMountedCallerCurrent?.(true);
        const setupResults = await Promise.allSettled([firstSetup, secondSetup]);
        expect(setupResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(setupResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const rejectedSetup = setupResults.find((result) => result.status === 'rejected');
        expect(rejectedSetup).toMatchObject({ reason: { code: 'plugin_selected_action_input_invalid' } });
        expect(invokeContributedAction).toHaveBeenCalledOnce();
        expect(invokeContributedAction).toHaveBeenLastCalledWith(expect.objectContaining({
            action: setupOperation.action,
            input: {
                repository: 'happier-dev/happier',
                credentialRef: account,
            },
        }));

        await expect(service.executeAdmittedTargetedOperation(
            connectionTest,
            { connectionId: 'connection-1' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledTimes(2);
        expect(invokeContributedAction).toHaveBeenLastCalledWith(expect.objectContaining({
            action: connectionTestOperation.action,
            input: { connectionId: 'connection-1' },
        }));
    });

    it('forwards G only from its original handle and lets the canonical owner reject it after H replaces it', async () => {
        let currentContributorOccurrenceId = 'contributor-occurrence-g';
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async (request) => {
            if (
                request.admittedTargetedOperation?.contributorOccurrenceId
                !== currentContributorOccurrenceId
            ) {
                return {
                    status: 'failed' as const,
                    code: 'plugin_action_generation_retired',
                    message: 'The admitted contributor occurrence is no longer current',
                };
            }
            return {
                status: 'executed' as const,
                value: { accepted: true },
                executionOrigin: {
                    serverIdentityId: 'srv-target',
                    materializationRef: {
                        pluginId: 'acme.contributor',
                        machineId: 'machine-target',
                        materializationId: currentContributorOccurrenceId,
                    },
                },
            };
        });
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                occurrenceId: 'caller-occurrence-g',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-caller', installSource: 'archive' },
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });
        const identity = Object.freeze({
            target: Object.freeze({ pluginId: 'acme.caller' }),
            point: Object.freeze({
                pointId: 'providers',
                protocol: Object.freeze({ id: 'acme.providers/provider', version: 1 }),
            }),
            contributor: Object.freeze({
                pluginId: 'acme.contributor',
                contributionId: 'primary',
                occurrenceId: 'contributor-occurrence-g',
                sourceCustody: createManagedPluginSourceCustody('immutable-contributor-g'),
            }),
            role: 'publish',
        });
        const admitted = createAdmittedTargetedOperationExecutionHandle({
            action: { pluginId: 'acme.contributor', localId: 'publish' },
            targetOccurrenceId: 'caller-occurrence-g',
            identity,
            targetProtocol: permissiveTargetProtocol(identity.role),
        });

        expect(admitted).toEqual({ identity, typeProjection: undefined });
        expect(Object.isFrozen(admitted)).toBe(true);
        expect(Object.isFrozen(admitted.identity)).toBe(true);

        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        await expect(service.executeAdmittedTargetedOperationWithExecutionOrigin(
            admitted,
            { title: 'Ready' },
        )).resolves.toMatchObject({
            result: { accepted: true },
            executionOrigin: expect.objectContaining({
                materializationRef: expect.objectContaining({
                    materializationId: 'contributor-occurrence-g',
                }),
            }),
        });
        expect(invokeContributedAction).toHaveBeenCalledTimes(2);
        expect(invokeContributedAction).toHaveBeenLastCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.contributor', localId: 'publish' },
            admittedTargetedOperation: expect.objectContaining({
                contributorOccurrenceId: 'contributor-occurrence-g',
            }),
        }));
        expect(invokeContributedAction.mock.calls[0]?.[0]).not.toHaveProperty(
            'expectedContributorOccurrenceId',
        );
        expect(invokeContributedAction.mock.calls[0]?.[0]).not.toHaveProperty(
            'expectedContributorMaterializationId',
        );

        // H is now current. Neither copied public description can recover G's
        // host-private binding or invoke either occurrence.
        currentContributorOccurrenceId = 'contributor-occurrence-h';
        invokeContributedAction.mockClear();
        const copiedIdentityHandle = Object.freeze({ identity: admitted.identity });
        const reconstructed = Object.freeze({
            identity: Object.freeze({
                target: Object.freeze({ ...admitted.identity.target }),
                point: Object.freeze({
                    pointId: admitted.identity.point.pointId,
                    protocol: Object.freeze({ ...admitted.identity.point.protocol }),
                }),
                contributor: Object.freeze({ ...admitted.identity.contributor }),
                role: admitted.identity.role,
            }),
        });
        await expect(service.executeAdmittedTargetedOperation(
            copiedIdentityHandle as never,
            { title: 'Ready' },
        )).rejects.toMatchObject({
            code: 'plugin_admitted_targeted_operation_handle_invalid',
            actionHandlerInvocation: 'notStarted',
        });
        await expect(service.executeAdmittedTargetedOperationWithExecutionOrigin(
            reconstructed as never,
            { title: 'Ready' },
        )).rejects.toMatchObject({
            code: 'plugin_admitted_targeted_operation_handle_invalid',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();

        await expect(service.executeAdmittedTargetedOperation(
            admitted,
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
        expect(invokeContributedAction).toHaveBeenCalledOnce();
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            admittedTargetedOperation: expect.objectContaining({
                contributorOccurrenceId: 'contributor-occurrence-g',
            }),
        }));
    });

    it('refuses an original handle when its target occurrence has been replaced before dispatch', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.target');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.target', version: '1.0.0' },
                contribution: { id: 'request', qualifiedId: 'acme.target/actions/request' },
                occurrenceId: 'target-occurrence-h',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-target-h', installSource: 'archive' },
                surface: 'plugin',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });
        const admittedByTargetG = createAdmittedTargetedOperationExecutionHandle({
            action: { pluginId: 'acme.contributor', localId: 'publish' },
            identity: {
                target: { pluginId: 'acme.target' },
                point: { pointId: 'providers', protocol: { id: 'acme.providers/provider', version: 1 } },
                contributor: {
                    pluginId: 'acme.contributor',
                    contributionId: 'primary',
                    occurrenceId: 'contributor-occurrence-g',
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'immutable-contributor-g', installSource: 'archive' },
                },
                role: 'publish',
            },
            targetOccurrenceId: 'target-occurrence-g',
            targetProtocol: permissiveTargetProtocol('publish'),
        });

        await expect(service.executeAdmittedTargetedOperation(
            admittedByTargetG,
            { title: 'Ready' },
        )).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            actionHandlerInvocation: 'notStarted',
        });
        await expect(service.executeAdmittedTargetedOperationWithExecutionOrigin(
            admittedByTargetG,
            { title: 'Ready' },
        )).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            actionHandlerInvocation: 'notStarted',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });
});
