import { describe, expect, it, vi } from 'vitest';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type {
    DispatchPluginSurfaceActionInput,
    PluginSurfaceActionDispatchOutcome,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import type { MachinePluginActionFormConnectedAccountOptionsResult } from '@/sync/ops/machineContributionRegistryProjection';
import type {
    PluginUiSelectActionInputRequestV1,
    PluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';
import { reconstructPluginUiSelectedActionInput } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
} from './pluginContributedActionController';
import { DEFAULT_INVOCATION_TIMEOUT_MS } from '@/components/appShell/plugins/pluginUiInvocationHost';

const MACHINE_ID = 'machine-a';
const SERVER_ID = 'server-a';
const SESSION_ID = 'session-a';
const GENERATION = 17;
const TARGET_PLUGIN_ID = 'acme.target';
const TARGET_POINT_ID = 'connection';
const TARGET_IMMUTABLE_GENERATION_ID = 'target-generation-a';
const TARGET_POINT = {
    pointId: TARGET_POINT_ID,
    protocol: { id: 'provider', version: 1 },
} as const;
const STABLE_ACCOUNT_LIFETIME = Object.freeze({
    scope: Object.freeze({ serverId: SERVER_ID, accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose() {} }),
});

function action(input: Partial<PluginProjectionAction> & Readonly<{
    id: string;
}>): PluginProjectionAction {
    return {
        id: input.id,
        title: input.title ?? input.id,
        description: input.description ?? null,
        icon: input.icon ?? null,
        scopes: input.scopes ?? ['session'],
        surfaces: input.surfaces ?? ['ui'],
        placementBindings: input.placementBindings ?? ['primary'],
        inputSchema: input.inputSchema ?? null,
        inputHints: input.inputHints ?? null,
        slash: input.slash ?? null,
        priority: input.priority ?? null,
        dangerLevel: input.dangerLevel ?? 'safe',
        confirmation: input.confirmation ?? null,
        available: input.available ?? true,
    };
}

function plugin(input: Readonly<{
    pluginId?: string;
    enabled?: boolean | null;
    generation?: number | null;
    immutableGenerationId?: string | null;
    actions: readonly PluginProjectionAction[];
}>): PluginProjectionEntry {
    const pluginId = input.pluginId ?? 'acme.channels';
    return {
        pluginId,
        immutableGenerationId: input.immutableGenerationId ?? 'contributor-generation-a',
        title: pluginId,
        description: null,
        version: '1.0.0',
        enabled: input.enabled ?? true,
        generation: input.generation ?? GENERATION,
        generationLabel: String(input.generation ?? GENERATION),
        status: null,
        provenance: null,
        diagnostics: [],
        actions: input.actions,
        resources: [],
        editableSettingsGroups: [],
    };
}

function targetedOperation(input: Readonly<{
    pluginId?: string;
    localId?: string;
    role?: string;
    immutableGenerationId?: string;
}> = {}): PluginUiTargetedContributionOperationV1 {
    return {
        point: TARGET_POINT,
        contributor: {
            pluginId: input.pluginId ?? 'acme.channels',
            contributionId: 'provider',
            immutableGenerationId: input.immutableGenerationId ?? 'contributor-generation-a',
        },
        role: input.role ?? 'setup',
        action: {
            pluginId: input.pluginId ?? 'acme.channels',
            localId: input.localId ?? 'connection/prepare-v1',
        },
    };
}

function targetedContributions(
    operation: PluginUiTargetedContributionOperationV1,
    targetPluginId = TARGET_PLUGIN_ID,
): PluginUiTargetedContributionsV1 {
    return {
        target: {
            pluginId: targetPluginId,
            immutableGenerationId: TARGET_IMMUTABLE_GENERATION_ID,
        },
        points: [{
            pointId: TARGET_POINT.pointId,
            protocols: [{
                protocol: TARGET_POINT.protocol,
                contributions: [{
                    contributor: operation.contributor,
                    protocol: TARGET_POINT.protocol,
                    operations: [operation],
                    surfaces: [],
                }],
            }],
        }],
    };
}

function selectionRequest(
    operation: PluginUiTargetedContributionOperationV1,
    draft?: PluginUiSelectActionInputRequestV1['draft'],
): PluginUiSelectActionInputRequestV1 {
    return {
        operation,
        ...(draft === undefined ? {} : { draft }),
    };
}

function snapshot(
    actions: readonly PluginProjectionAction[],
    input: Readonly<{
        pluginId?: string;
        targeted?: PluginUiTargetedContributionsV1 | null;
    }> = {},
): PluginContributedActionCurrentSnapshot {
    const pluginId = input.pluginId ?? 'acme.channels';
    const operation = targetedOperation({ pluginId });
    return {
        pluginProjectionById: {
            [pluginId]: plugin({ pluginId, actions }),
        },
        targetedContributions: input.targeted ?? targetedContributions(operation),
        host: {
            machineId: MACHINE_ID,
            serverId: SERVER_ID,
            expectedGeneration: GENERATION,
            targetPluginId: TARGET_PLUGIN_ID,
            sessionId: SESSION_ID,
            accountLifetime: STABLE_ACCOUNT_LIFETIME,
            isCurrent: () => true,
        },
    };
}

function createAccountLifetimeHarness() {
    let current = true;
    const callbacks = new Set<() => void>();
    return {
        lifetime: {
            scope: { serverId: SERVER_ID, accountId: 'account-a' },
            isCurrent: () => current,
            onRetire: (callback: () => void) => {
                callbacks.add(callback);
                return { dispose: () => callbacks.delete(callback) };
            },
        },
        retire() {
            current = false;
            for (const callback of [...callbacks]) callback();
        },
    };
}

describe('plugin contributed Action controller', () => {
    it('preserves a schema-valid host-filled draft for an exact no-form Action', async () => {
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'automation/history-gap-reset',
                scopes: ['settings'],
                surfaces: ['plugin'],
                placementBindings: [],
                inputSchema: {
                    type: 'object',
                    properties: {
                        automationId: { type: 'string', minLength: 1 },
                        templateVersion: { type: 'integer', minimum: 0 },
                        sourceSelectorId: { type: 'string', minLength: 1 },
                    },
                    required: ['automationId', 'templateVersion', 'sourceSelectorId'],
                    additionalProperties: false,
                },
                inputHints: null,
            })]),
        });

        await expect(controller.selectExactBoundActionInput({
            action: { pluginId: 'acme.channels', localId: 'automation/history-gap-reset' },
            expectedImmutableGenerationId: 'contributor-generation-a',
            draft: {
                automationId: 'automation-a',
                templateVersion: 3,
                sourceSelectorId: 'source-a',
            },
        })).resolves.toEqual({
            kind: 'direct',
            result: {
                kind: 'submitted',
                action: { pluginId: 'acme.channels', localId: 'automation/history-gap-reset' },
                input: {
                    automationId: 'automation-a',
                    templateVersion: 3,
                    sourceSelectorId: 'source-a',
                },
                connectedAccount: { kind: 'none' },
            },
        });
    });

    it('selects one placementless plugin Action without dispatch and separates its Account ref', async () => {
        const account = {
            service: { pluginId: 'com.acme.accounts', localId: 'github' },
            accountId: 'account-a',
        };
        const dispatch = vi.fn();
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'connection/prepare-v1',
                scopes: ['settings'],
                surfaces: ['plugin'],
                placementBindings: [],
                inputSchema: {
                    type: 'object',
                    properties: {
                        repository: { type: 'string', minLength: 1 },
                        credentialRef: {
                            type: 'object',
                            properties: {
                                service: {
                                    type: 'object',
                                    properties: {
                                        pluginId: { type: 'string' },
                                        localId: { type: 'string' },
                                    },
                                    required: ['pluginId', 'localId'],
                                    additionalProperties: false,
                                },
                                accountId: { type: 'string' },
                            },
                            required: ['service', 'accountId'],
                            additionalProperties: false,
                        },
                    },
                    required: ['repository', 'credentialRef'],
                    additionalProperties: false,
                },
                inputHints: {
                    fields: [
                        { path: 'repository', title: 'Repository', widget: 'text', required: true },
                        {
                            path: 'credentialRef',
                            title: 'Account',
                            widget: 'select',
                            connectedAccountOptions: true,
                            required: true,
                        },
                    ],
                },
            })]),
            dispatch,
            resolveConnectedAccountOptions: vi.fn().mockResolvedValue({
                supported: true,
                result: { ok: true, options: [{ value: account, label: 'Work' }] },
            }),
        });

        const operation = targetedOperation();
        const selected = await controller.selectActionInput(selectionRequest(
            operation,
            { repository: 'happier-dev/happier' },
        ));
        if (selected.kind !== 'form') throw new Error('expected selection form');
        expect(selected.form.getInput()).toEqual({ repository: 'happier-dev/happier' });
        selected.form.replaceInput({ repository: 'happier-dev/happier', credentialRef: account });
        await expect(selected.form.submit()).resolves.toMatchObject({
            kind: 'settled',
            outcome: { ok: true },
        });
        await expect(selected.result).resolves.toEqual({
            kind: 'submitted',
            action: { pluginId: 'acme.channels', localId: 'connection/prepare-v1' },
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: TARGET_PLUGIN_ID,
                    immutableGenerationId: TARGET_IMMUTABLE_GENERATION_ID,
                },
                point: TARGET_POINT,
                contributor: operation.contributor,
            },
            connectedAccount: {
                kind: 'selected',
                fieldPath: 'credentialRef',
                ref: account,
            },
        });
        const settlement = await selected.result;
        if (settlement.kind !== 'submitted') throw new Error('expected submitted selection');
        expect(reconstructPluginUiSelectedActionInput(settlement)).toEqual({
            repository: 'happier-dev/happier',
            credentialRef: account,
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('reconstructs only the host-selected Connected Account field and rejects tampered or colliding selections', () => {
        const account = {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const submitted = {
            kind: 'submitted' as const,
            action: { pluginId: 'acme.channels', localId: 'connection/prepare-v1' },
            input: { repository: 'happier-dev/happier' },
            connectedAccount: {
                kind: 'selected' as const,
            fieldPath: 'credentialRef',
                ref: account,
            },
        };
        expect(reconstructPluginUiSelectedActionInput(submitted)).toEqual({
            repository: 'happier-dev/happier',
            credentialRef: account,
        });
        expect(reconstructPluginUiSelectedActionInput({
            ...submitted,
            input: { credentialRef: account },
        })).toBeNull();
        expect(reconstructPluginUiSelectedActionInput({
            ...submitted,
            connectedAccount: {
                ...submitted.connectedAccount,
                fieldPath: 'credentialRef..nested',
            },
        })).toBeNull();
    });

    it('uses exact mounted target membership instead of globally scanning matching local Action ids', async () => {
        const operation = targetedOperation({
            pluginId: 'acme.selected',
            localId: 'setup',
            immutableGenerationId: 'selected-generation-a',
        });
        const selected = action({
            id: 'setup',
            scopes: ['settings'],
            surfaces: ['plugin'],
            placementBindings: [],
            inputSchema: null,
            inputHints: null,
        });
        const projection = {
            'acme.selected': plugin({
                pluginId: 'acme.selected',
                immutableGenerationId: 'selected-generation-a',
                actions: [selected],
            }),
            'acme.other': plugin({ pluginId: 'acme.other', actions: [selected] }),
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => ({
                ...snapshot([], { targeted: targetedContributions(operation) }),
                pluginProjectionById: projection,
            }),
        });

        await expect(controller.selectActionInput(selectionRequest(operation))).resolves.toEqual({
            kind: 'direct',
            result: {
                kind: 'submitted',
                action: { pluginId: 'acme.selected', localId: 'setup' },
                input: {},
                selection: {
                    target: {
                        pluginId: TARGET_PLUGIN_ID,
                        immutableGenerationId: TARGET_IMMUTABLE_GENERATION_ID,
                    },
                    point: TARGET_POINT,
                    contributor: operation.contributor,
                },
                connectedAccount: { kind: 'none' },
            },
        });
    });

    it('returns distinct non-executable selections for same-local-id Actions admitted from different contributors', async () => {
        const alpha = targetedOperation({
            pluginId: 'acme.alpha',
            localId: 'setup',
            immutableGenerationId: 'alpha-generation-a',
        });
        const beta = targetedOperation({
            pluginId: 'acme.beta',
            localId: 'setup',
            immutableGenerationId: 'beta-generation-a',
        });
        const setup = action({
            id: 'setup',
            scopes: ['settings'],
            surfaces: ['plugin'],
            placementBindings: [],
            inputSchema: null,
            inputHints: null,
        });
        const current: PluginContributedActionCurrentSnapshot = {
            pluginProjectionById: {
                'acme.alpha': plugin({
                    pluginId: 'acme.alpha',
                    immutableGenerationId: 'alpha-generation-a',
                    actions: [setup],
                }),
                'acme.beta': plugin({
                    pluginId: 'acme.beta',
                    immutableGenerationId: 'beta-generation-a',
                    actions: [setup],
                }),
            },
            targetedContributions: {
                target: {
                    pluginId: TARGET_PLUGIN_ID,
                    immutableGenerationId: TARGET_IMMUTABLE_GENERATION_ID,
                },
                points: [{
                    pointId: TARGET_POINT.pointId,
                    protocols: [{
                        protocol: TARGET_POINT.protocol,
                        contributions: [
                            {
                                contributor: alpha.contributor,
                                protocol: TARGET_POINT.protocol,
                                operations: [alpha],
                                surfaces: [],
                            },
                            {
                                contributor: beta.contributor,
                                protocol: TARGET_POINT.protocol,
                                operations: [beta],
                                surfaces: [],
                            },
                        ],
                    }],
                }],
            },
            host: snapshot([]).host,
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
        });

        const alphaSelection = await controller.selectActionInput(selectionRequest(alpha));
        const betaSelection = await controller.selectActionInput(selectionRequest(beta));
        expect(alphaSelection).toMatchObject({
            kind: 'direct',
            result: {
                kind: 'submitted',
                action: alpha.action,
                selection: {
                    target: current.targetedContributions?.target,
                    point: alpha.point,
                    contributor: alpha.contributor,
                },
            },
        });
        expect(betaSelection).toMatchObject({
            kind: 'direct',
            result: {
                kind: 'submitted',
                action: beta.action,
                selection: {
                    target: current.targetedContributions?.target,
                    point: beta.point,
                    contributor: beta.contributor,
                },
            },
        });
        expect(alphaSelection).not.toEqual(betaSelection);
    });

    it('withholds a portable selection when the admitted target or contributor becomes stale before submission', async () => {
        const configure = action({
            id: 'configure-source',
            scopes: ['settings'],
            surfaces: ['plugin'],
            placementBindings: [],
            inputSchema: {
                type: 'object',
                properties: { repository: { type: 'string', minLength: 1 } },
                required: ['repository'],
                additionalProperties: false,
            },
            inputHints: {
                fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
            },
        });
        const operation = targetedOperation({ localId: 'configure-source' });
        let current = snapshot([configure], { targeted: targetedContributions(operation) });
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
        });

        const selected = await controller.selectActionInput(selectionRequest(operation));
        if (selected.kind !== 'form') throw new Error('expected selection form');
        current = {
            ...current,
            targetedContributions: {
                ...targetedContributions(operation),
                target: {
                    pluginId: TARGET_PLUGIN_ID,
                    immutableGenerationId: 'target-generation-b',
                },
            },
        };
        selected.form.replaceInput({ repository: 'happier-dev/happier' });
        await expect(selected.form.submit()).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        await expect(selected.result).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });

        current = {
            ...snapshot([configure], { targeted: targetedContributions(operation) }),
            pluginProjectionById: {
                'acme.channels': plugin({
                    immutableGenerationId: 'contributor-generation-b',
                    actions: [configure],
                }),
            },
        };
        await expect(controller.selectActionInput(selectionRequest(operation))).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
    });

    it('settles an exact stale setup Action as unavailable without invoking or rejoining a same-local-id replacement', async () => {
        const configureSource = action({
            id: 'configure-source',
            scopes: ['settings'],
            surfaces: ['plugin'],
            placementBindings: [],
            inputSchema: {
                type: 'object',
                properties: { repository: { type: 'string', minLength: 1 } },
                required: ['repository'],
                additionalProperties: false,
            },
            inputHints: {
                fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
            },
        });
        let current = {
            ...snapshot([], { targeted: null }),
            pluginProjectionById: {
                'acme.alpha': plugin({
                    pluginId: 'acme.alpha',
                    immutableGenerationId: 'alpha-generation-a',
                    actions: [configureSource],
                }),
                'acme.beta': plugin({
                    pluginId: 'acme.beta',
                    immutableGenerationId: 'beta-generation-a',
                    actions: [configureSource],
                }),
            },
        };
        const dispatch = vi.fn();
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const selected = await controller.selectExactBoundActionInput({
            action: { pluginId: 'acme.alpha', localId: 'configure-source' },
            expectedImmutableGenerationId: 'alpha-generation-a',
        });
        expect(selected).toMatchObject({ kind: 'form' });
        if (!selected || typeof selected !== 'object' || !('kind' in selected) || selected.kind !== 'form') {
            throw new Error('expected an exact-bound form');
        }

        current = {
            ...current,
            pluginProjectionById: {
                ...current.pluginProjectionById,
                'acme.alpha': plugin({
                    pluginId: 'acme.alpha',
                    immutableGenerationId: 'alpha-generation-b',
                    actions: [configureSource],
                }),
            },
        };
        selected.form.replaceInput({ repository: 'happier-dev/happier' });
        await expect(selected.form.submit()).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        await expect(selected.result).resolves.toEqual({
            kind: 'unavailable',
            reason: 'action_not_found',
        });
        expect(dispatch).not.toHaveBeenCalled();
        await expect(controller.selectExactBoundActionInput({
            action: { pluginId: 'acme.alpha', localId: 'configure-source' },
            expectedImmutableGenerationId: 'alpha-generation-a',
        })).resolves.toEqual({
            kind: 'unavailable',
            reason: 'action_not_found',
        });
    });

    it('refuses an exact handle whose point/protocol is not in the mounted snapshot', async () => {
        const operation = targetedOperation({ localId: 'setup' });
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'setup',
                scopes: ['settings'],
                surfaces: ['plugin'],
                placementBindings: [],
                inputSchema: null,
                inputHints: null,
            })]),
        });

        await expect(controller.selectActionInput(selectionRequest({
            ...operation,
            point: { pointId: 'other-point', protocol: { id: 'provider', version: 1 } },
        }))).resolves.toEqual({ kind: 'unavailable', reason: 'action_not_found' });
    });

    it('does not reinterpret a literal host-owned selector as a targeted Action', async () => {
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'setup',
                scopes: ['settings'],
                surfaces: ['plugin'],
                placementBindings: [],
                inputSchema: null,
                inputHints: null,
            })]),
        });

        await expect(controller.selectActionInput({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
        })).resolves.toEqual({ kind: 'unavailable', reason: 'invalid_input' });
    });

    it('fails closed for absent mounted membership, secret-bearing, multi-Account, and invalid-draft selections', async () => {
        const base = action({
            id: 'setup',
            scopes: ['settings'],
            surfaces: ['plugin'],
            placementBindings: [],
            inputSchema: {
                type: 'object',
                properties: { repository: { type: 'string' } },
                additionalProperties: false,
            },
            inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'text' }] },
        });
        const operation = targetedOperation({ localId: 'setup' });
        const make = (actions: readonly PluginProjectionAction[], admitted = operation) => createPluginContributedActionController({
            resolveCurrent: () => ({
                ...snapshot([], { targeted: targetedContributions(admitted) }),
                pluginProjectionById: Object.fromEntries(actions.map((entry, index) => [
                    index === 0 ? operation.action.pluginId : `acme.${index}`,
                    plugin({ pluginId: index === 0 ? operation.action.pluginId : `acme.${index}`, actions: [entry] }),
                ])),
            }),
        });
        await expect(make([base], targetedOperation({
            pluginId: 'acme.absent',
            localId: 'setup',
            immutableGenerationId: 'absent-generation-a',
        })).selectActionInput(selectionRequest(operation))).resolves.toEqual({ kind: 'unavailable', reason: 'action_not_found' });
        await expect(make([{ ...base, inputHints: { fields: [{ path: 'token', title: 'Token', widget: 'secret' }] } }]).selectActionInput(selectionRequest(operation))).resolves.toEqual({ kind: 'unavailable', reason: 'secret_input_unsupported' });
        const accountField = (path: string) => ({
            path,
            title: path,
            widget: 'select' as const,
            connectedAccountOptions: true as const,
        });
        await expect(make([{ ...base, inputHints: { fields: [accountField('one'), accountField('two')] } }]).selectActionInput(selectionRequest(operation))).resolves.toEqual({ kind: 'unavailable', reason: 'connected_account_ambiguous' });
        await expect(make([base]).selectActionInput(selectionRequest(operation, { undeclared: true }))).resolves.toEqual({ kind: 'unavailable', reason: 'invalid_draft' });
    });

    it('does not open a secret-capable form without a captured Account lifetime', async () => {
        const initial = snapshot([action({
            id: 'configure',
            inputHints: {
                fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
            },
        })]);
        const current = {
            ...initial,
            host: { ...initial.host, accountLifetime: null },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');

        await expect(controller.open(entry)).resolves.toEqual({
            kind: 'unavailable',
            reason: 'host_unavailable',
        });
    });

    it('keeps a current secret form open while awaiting user input and retains Account retirement cleanup', async () => {
        vi.useFakeTimers();
        try {
            const account = createAccountLifetimeHarness();
            const current = {
                ...snapshot([action({
                    id: 'configure',
                    inputHints: {
                        fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
                    },
                })]),
                host: {
                    ...snapshot([]).host,
                    accountLifetime: account.lifetime,
                },
            };
            const controller = createPluginContributedActionController({
                resolveCurrent: () => current,
            });
            const [entry] = controller.list({ placement: 'primary', scope: 'session' });
            if (!entry) throw new Error('expected eligible Action');
            const opened = await controller.open(entry);
            if (opened.kind !== 'form') throw new Error('expected form Action');

            opened.form.replaceInput({ token: 'clear-on-account-retirement' });
            account.retire();
            expect(opened.form.getInput()).toEqual({});

            const deadlineAccount = createAccountLifetimeHarness();
            const deadlineCurrent = {
                ...current,
                host: { ...current.host, accountLifetime: deadlineAccount.lifetime },
            };
            const deadlineController = createPluginContributedActionController({
                resolveCurrent: () => deadlineCurrent,
            });
            const [deadlineEntry] = deadlineController.list({ placement: 'primary', scope: 'session' });
            if (!deadlineEntry) throw new Error('expected eligible Action');
            const deadlineOpened = await deadlineController.open(deadlineEntry);
            if (deadlineOpened.kind !== 'form') throw new Error('expected form Action');

            deadlineOpened.form.replaceInput({ token: 'keep-while-filling-form' });
            await vi.advanceTimersByTimeAsync(DEFAULT_INVOCATION_TIMEOUT_MS);
            expect(deadlineOpened.form.isRetired()).toBe(false);
            expect(deadlineOpened.form.getInput()).toEqual({ token: 'keep-while-filling-form' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('enumerates only current UI Actions admitted for the requested semantic placement and scope', () => {
        const current = snapshot([
            action({
                id: 'configure',
                title: 'Configure Channels',
                inputHints: {
                    title: 'Configure Channels',
                    fields: [{ path: 'endpoint', title: 'Endpoint', widget: 'url', required: true }],
                },
            }),
            action({ id: 'refresh', inputHints: { fields: [] } }),
            action({ id: 'settings-only', scopes: ['settings'] }),
            action({ id: 'secondary', placementBindings: ['secondary'] }),
            action({ id: 'unavailable', available: false }),
            action({ id: 'plugin-only', surfaces: ['plugin'] }),
        ]);
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
        });

        expect(controller.list({ placement: 'primary', scope: 'session' })).toEqual([
            expect.objectContaining({
                qualifiedActionId: 'acme.channels/configure',
                identity: { pluginId: 'acme.channels', localId: 'configure' },
                kind: 'form',
            }),
            expect.objectContaining({
                qualifiedActionId: 'acme.channels/refresh',
                kind: 'direct',
            }),
        ]);
    });

    it('projects one current Action into every declared placement binding with its presentation metadata', () => {
        const multiPlacement = Object.assign(action({
            id: 'reconnect',
            placementBindings: [],
        }), {
            placementBindings: ['primary', 'secondary'] as const,
            icon: 'magic-wand',
            priority: -10,
        });
        const laterPrimary = Object.assign(action({
            id: 'later-primary',
            placementBindings: [],
        }), {
            placementBindings: ['primary'] as const,
            icon: 'arrow-right',
            priority: 10,
        });
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([laterPrimary, multiPlacement]),
        });

        expect(controller.list({ placement: 'primary', scope: 'session' })).toEqual([
            expect.objectContaining({
                qualifiedActionId: 'acme.channels/reconnect',
                placement: 'primary',
                icon: 'magic-wand',
                priority: -10,
            }),
            expect.objectContaining({
                qualifiedActionId: 'acme.channels/later-primary',
                placement: 'primary',
                icon: 'arrow-right',
                priority: 10,
            }),
        ]);
        expect(controller.list({ placement: 'secondary', scope: 'session' })).toEqual([
            expect.objectContaining({
                qualifiedActionId: 'acme.channels/reconnect',
                placement: 'secondary',
                icon: 'magic-wand',
                priority: -10,
            }),
        ]);
    });

    it('projects only exact composer-slash bindings through the controller and retires a withdrawn slash presentation', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        const direct = action({
            id: 'review',
            placementBindings: ['composer.primary', 'composer.slash'],
            slash: { tokens: ['/review'] },
            inputHints: { fields: [] },
        });
        const form = action({
            id: 'configure-review',
            placementBindings: ['composer.more', 'composer.slash'],
            slash: { tokens: ['/review'] },
            inputHints: {
                fields: [{ path: 'depth', title: 'Depth', widget: 'integer' }],
            },
        });
        const currentComposerIntent = () => ({
            composer: { kind: 'session' as const, sessionId: SESSION_ID },
            revision: 1,
        });
        const initial = snapshot([direct, form, action({
            id: 'not-a-slash-command',
            placementBindings: ['composer.primary'],
            slash: { tokens: ['/not-a-slash-command'] },
            inputHints: { fields: [] },
        })]);
        let current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                currentComposerIntent,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });

        const commands = controller.listSlashCommands();
        expect(commands.map((entry) => ({
            id: entry.qualifiedActionId,
            kind: entry.kind,
            placement: entry.placement,
            slash: entry.slash,
        }))).toEqual([
            {
                id: 'acme.channels/configure-review',
                kind: 'form',
                placement: 'composer.slash',
                slash: { tokens: ['/review'] },
            },
            {
                id: 'acme.channels/review',
                kind: 'direct',
                placement: 'composer.slash',
                slash: { tokens: ['/review'] },
            },
        ]);

        const directCommand = commands.find((entry) => entry.identity.localId === 'review');
        const formCommand = commands.find((entry) => entry.identity.localId === 'configure-review');
        if (!directCommand || !formCommand) throw new Error('expected both slash Actions');

        await expect(controller.open(directCommand)).resolves.toMatchObject({ kind: 'direct' });
        await expect(controller.open(formCommand)).resolves.toMatchObject({ kind: 'form' });

        const withdrawn = snapshot([action({ ...direct, slash: null }), form]);
        current = {
            ...withdrawn,
            host: {
                ...withdrawn.host,
                currentComposerIntent,
            },
        };
        await expect(controller.open(directCommand)).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
    });

    it('dispatches a host-presented Composer Action with its current intent and no fabricated caller', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        let composerRevision = 17;
        const initial = snapshot([action({
            id: 'refresh',
            placementBindings: ['composer.primary'],
            inputHints: { fields: [] },
        })]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                currentComposerIntent: () => ({
                    composer: { kind: 'session', sessionId: SESSION_ID },
                    revision: composerRevision,
                }),
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [refresh] = controller.list({ placement: 'composer.primary', scope: 'session' });
        if (!refresh) throw new Error('expected eligible Action');

        await expect(controller.open(refresh)).resolves.toEqual({
            kind: 'direct',
            action: refresh,
            outcome: { ok: true, result: { completed: true } },
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.channels', localId: 'refresh' },
            input: {},
            contributedAction: {
                machineId: MACHINE_ID,
                serverId: SERVER_ID,
                expectedGeneration: String(GENERATION),
                sessionId: SESSION_ID,
            },
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: { kind: 'session', sessionId: SESSION_ID },
                    revision: composerRevision,
                },
            },
        }));
        const dispatchInput = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(dispatchInput).not.toHaveProperty('callerPluginId');
        expect(dispatchInput).not.toHaveProperty('callerContributionLocalId');
        expect((dispatchInput.isCurrent as (() => boolean) | undefined)?.()).toBe(true);
    });

    it('fails closed before RPC when a host-presented Composer no longer has a current intent', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        const initial = snapshot([action({
            id: 'refresh',
            placementBindings: ['composer.primary'],
            inputHints: { fields: [] },
        })]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                currentComposerIntent: () => null,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [refresh] = controller.list({ placement: 'composer.primary', scope: 'session' });
        if (!refresh) throw new Error('expected eligible Action');

        await expect(controller.open(refresh)).resolves.toEqual({
            kind: 'stale',
            reason: 'host_retired',
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('fails closed before RPC when a Composer host is mixed with a Message carrier', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        const initial = snapshot([action({
            id: 'refresh',
            placementBindings: ['composer.primary'],
            inputHints: { fields: [] },
        })]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                currentComposerIntent: () => ({
                    composer: { kind: 'session', sessionId: SESSION_ID },
                    revision: 17,
                }),
                messageActionReference: {
                    v: 1,
                    sessionId: SESSION_ID,
                    messageId: 'message-a',
                    observedRevision: 'revision-a',
                },
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [refresh] = controller.list({ placement: 'composer.primary', scope: 'session' });
        if (!refresh) throw new Error('expected eligible Action');

        await expect(controller.open(refresh)).resolves.toEqual({
            kind: 'unavailable',
            reason: 'host_unavailable',
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('re-reads host-presented Composer intent when an opened Action form settles', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { configured: true } });
        let composerRevision = 4;
        const initial = snapshot([action({
            id: 'configure',
            placementBindings: ['composer.more'],
            inputSchema: {
                type: 'object',
                properties: { endpoint: { type: 'string', minLength: 1 } },
                required: ['endpoint'],
                additionalProperties: false,
            },
            inputHints: {
                fields: [{ path: 'endpoint', title: 'Endpoint', widget: 'url', required: true }],
            },
        })]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                currentComposerIntent: () => ({
                    composer: { kind: 'session', sessionId: SESSION_ID },
                    revision: composerRevision,
                }),
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [configure] = controller.list({ placement: 'composer.more', scope: 'session' });
        if (!configure) throw new Error('expected eligible Action');
        const opened = await controller.open(configure);
        if (opened.kind !== 'form') throw new Error('expected form Action');

        opened.form.replaceInput({ endpoint: 'https://composer.example.test' });
        composerRevision = 5;
        await expect(opened.form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true, result: { configured: true } },
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            invocation: {
                kind: 'hostPresentedComposer',
                currentComposerIntent: {
                    composer: { kind: 'session', sessionId: SESSION_ID },
                    revision: 5,
                },
            },
        }));
    });

    it('rechecks an immutable structured Action reference with current Message intent, never a retained caller', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { opened: true } });
        const messageActionReference = {
            v: 1 as const,
            sessionId: SESSION_ID,
            messageId: 'message-a',
            observedRevision: 'revision-a',
        };
        const initial = snapshot([action({
                id: 'open-report',
                placementBindings: ['message.menu'],
                scopes: ['message'],
            })]);
        let current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                messageActionReference,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const reference = { pluginId: 'acme.channels', localId: 'open-report' };

        expect(controller.isReferenceAvailable(reference)).toBe(true);
        await expect(controller.invokeReference(reference, { reportId: 'report-1' })).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true, result: { opened: true } },
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            action: reference,
            input: { reportId: 'report-1' },
            contributedAction: expect.objectContaining({ messageActionReference }),
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageActionReference,
            },
        }));
        const dispatchInput = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(dispatchInput).not.toHaveProperty('callerPluginId');
        expect(dispatchInput).not.toHaveProperty('callerContributionLocalId');

        current = {
            ...current,
            pluginProjectionById: {
                'acme.channels': plugin({ actions: [action({
                    id: 'open-report',
                    placementBindings: ['message.menu'],
                    scopes: ['message'],
                    available: false,
                })] }),
            },
        };
        expect(controller.isReferenceAvailable(reference)).toBe(false);
        await expect(controller.invokeReference(reference, { reportId: 'report-1' })).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('retains a mixed legacy Message reference route instead of adding a host-presented Message arm', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { opened: true } });
        const messageActionReference = {
            v: 1 as const,
            sessionId: SESSION_ID,
            messageId: 'message-a',
            observedRevision: 'revision-a',
        };
        const initial = snapshot([action({
            id: 'open-report',
            placementBindings: ['contextMenu', 'message.menu'],
            scopes: ['message'],
        })]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                messageActionReference,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const reference = { pluginId: 'acme.channels', localId: 'open-report' };

        await expect(controller.invokeReference(reference, { reportId: 'report-1' })).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true, result: { opened: true } },
        });
        const dispatchInput = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(dispatchInput).not.toHaveProperty('invocation');
        expect(dispatchInput).toMatchObject({
            contributedAction: { messageActionReference },
        });
    });

    it('retains the legacy route when a mixed Message Action is opened from its semantic menu descriptor', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { opened: true } });
        const messageActionReference = {
            v: 1 as const,
            sessionId: SESSION_ID,
            messageId: 'message-a',
            observedRevision: 'revision-a',
        };
        const initial = snapshot([action({
            id: 'open-report',
            placementBindings: ['contextMenu', 'message.menu'],
            scopes: ['message'],
        })]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                messageActionReference,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [menuAction] = controller.list({ placement: 'message.menu', scope: 'message' });
        if (!menuAction) throw new Error('expected mixed Message Action');

        await expect(controller.open(menuAction)).resolves.toEqual({
            kind: 'direct',
            action: menuAction,
            outcome: { ok: true, result: { opened: true } },
        });
        const dispatchInput = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(dispatchInput).not.toHaveProperty('invocation');
        expect(dispatchInput).toMatchObject({
            input: {},
            contributedAction: { messageActionReference },
        });
    });

    it('normalizes form input through SDK-ACTION-FORM, clears transient secret input, and rejects a retired Action before dispatch', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        const configure = action({
            id: 'configure',
            inputHints: {
                fields: [
                    { path: 'token', title: 'Token', widget: 'secret', required: true },
                    {
                        path: 'targets',
                        title: 'Targets',
                        widget: 'multiselect',
                        options: [
                            { value: 'one', label: 'One' },
                            { value: 'two', label: 'Two' },
                            { value: 'three', label: 'Three' },
                        ],
                        maxSelections: 2,
                    },
                ],
            },
        });
        let current = snapshot([configure]);
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');

        const opened = await controller.open(entry);
        if (opened.kind !== 'form') throw new Error('expected form Action');
        opened.form.replaceInput({
            token: 'never-persist-this',
            targets: ['one', 'two', 'three'],
        });
        await expect(opened.form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true, result: { completed: true } },
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            input: { token: 'never-persist-this', targets: ['two', 'three'] },
        }));
        expect(opened.form.getInput()).toEqual({});

        const reopened = await controller.open(entry);
        if (reopened.kind !== 'form') throw new Error('expected form Action');
        reopened.form.replaceInput({ token: 'clear-on-retirement' });
        current = snapshot([action({ ...configure, available: false })]);
        reopened.form.replaceInput({ token: 'must-not-reappear-after-retirement' });
        expect(reopened.form.getInput()).toEqual({});
        await expect(reopened.form.submit()).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        expect(reopened.form.getInput()).toEqual({});
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('clears a failed form attempt without trapping the user in a retired form session', async () => {
        const dispatch = vi.fn()
            .mockResolvedValueOnce({ ok: false, code: 'unavailable', reason: 'temporary_failure' })
            .mockResolvedValueOnce({ ok: true, result: { completed: true } });
        const current = snapshot([action({
            id: 'configure',
            inputHints: {
                fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
            },
        })]);
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');
        const opened = await controller.open(entry);
        if (opened.kind !== 'form') throw new Error('expected form Action');

        opened.form.replaceInput({ token: 'first-attempt' });
        await expect(opened.form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: false, code: 'unavailable', reason: 'temporary_failure' },
        });
        expect(opened.form.getInput()).toEqual({});

        opened.form.replaceInput({ token: 'second-attempt' });
        await expect(opened.form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true, result: { completed: true } },
        });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(opened.form.getInput()).toEqual({});
    });

    it.each(['cancel', 'retire'] as const)(
        'aborts the exact canonical handler signal when form retirement occurs via %s',
        async (retirement) => {
            let settleDispatch: (outcome: PluginSurfaceActionDispatchOutcome) => void = () => {
                throw new Error('dispatch resolver was not initialized');
            };
            const pendingDispatch = new Promise<PluginSurfaceActionDispatchOutcome>((resolve) => {
                settleDispatch = resolve;
            });
            const dispatch = vi.fn(async (
                _input: DispatchPluginSurfaceActionInput,
            ): Promise<PluginSurfaceActionDispatchOutcome> => await pendingDispatch);
            const outerLifetime = new AbortController();
            const initial = snapshot([action({
                id: 'configure',
                inputHints: {
                    fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
                },
            })]);
            const current = {
                ...initial,
                host: { ...initial.host, signal: outerLifetime.signal },
            };
            const controller = createPluginContributedActionController({
                resolveCurrent: () => current,
                dispatch,
            });
            const [entry] = controller.list({ placement: 'primary', scope: 'session' });
            if (!entry) throw new Error('expected eligible Action');
            const opened = await controller.open(entry);
            if (opened.kind !== 'form') throw new Error('expected form Action');

            opened.form.replaceInput({ token: 'dismiss-while-submitting' });
            const submitting = opened.form.submit();
            await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

            const dispatchInput = dispatch.mock.calls[0]?.[0];
            const handlerSignal = dispatchInput?.signal;
            expect(handlerSignal).toBeDefined();
            expect(handlerSignal).not.toBe(outerLifetime.signal);
            expect(handlerSignal?.aborted).toBe(false);
            if (retirement === 'cancel') opened.form.cancel();
            else opened.form.retire();
            expect(handlerSignal?.aborted).toBe(true);
            expect(outerLifetime.signal.aborted).toBe(false);

            settleDispatch({ ok: true, result: { completed: true } });
            await expect(submitting).resolves.toEqual({
                kind: 'stale',
                reason: 'action_retired',
            });
        },
    );

    it('keeps the exact form handler signal transitively bound to outer host retirement', async () => {
        let settleDispatch: (outcome: PluginSurfaceActionDispatchOutcome) => void = () => {
            throw new Error('dispatch resolver was not initialized');
        };
        const pendingDispatch = new Promise<PluginSurfaceActionDispatchOutcome>((resolve) => {
            settleDispatch = resolve;
        });
        const dispatch = vi.fn(async (
            _input: DispatchPluginSurfaceActionInput,
        ): Promise<PluginSurfaceActionDispatchOutcome> => await pendingDispatch);
        const outerLifetime = new AbortController();
        const initial = snapshot([action({
            id: 'configure',
            inputHints: {
                fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
            },
        })]);
        const current = {
            ...initial,
            host: { ...initial.host, signal: outerLifetime.signal },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');
        const opened = await controller.open(entry);
        if (opened.kind !== 'form') throw new Error('expected form Action');

        opened.form.replaceInput({ token: 'outer-host-retirement' });
        const submitting = opened.form.submit();
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());

        const handlerSignal = dispatch.mock.calls[0]?.[0]?.signal;
        expect(handlerSignal).toBeDefined();
        expect(handlerSignal).not.toBe(outerLifetime.signal);
        expect(handlerSignal?.aborted).toBe(false);

        outerLifetime.abort();

        expect(handlerSignal?.aborted).toBe(true);
        settleDispatch({ ok: true, result: { completed: true } });
        await expect(submitting).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
    });

    it('aborts the exact canonical handler signal when the host-owned form deadline elapses', async () => {
        vi.useFakeTimers();
        try {
            let settleDispatch: (outcome: PluginSurfaceActionDispatchOutcome) => void = () => {
                throw new Error('dispatch resolver was not initialized');
            };
            const pendingDispatch = new Promise<PluginSurfaceActionDispatchOutcome>((resolve) => {
                settleDispatch = resolve;
            });
            const dispatch = vi.fn(async (
                _input: DispatchPluginSurfaceActionInput,
            ): Promise<PluginSurfaceActionDispatchOutcome> => await pendingDispatch);
            const controller = createPluginContributedActionController({
                resolveCurrent: () => snapshot([action({
                    id: 'configure',
                    inputHints: {
                        fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
                    },
                })]),
                dispatch,
            });
            const [entry] = controller.list({ placement: 'primary', scope: 'session' });
            if (!entry) throw new Error('expected eligible Action');
            const opened = await controller.open(entry);
            if (opened.kind !== 'form') throw new Error('expected form Action');

            opened.form.replaceInput({ token: 'deadline-while-submitting' });
            const submitting = opened.form.submit();
            expect(dispatch).toHaveBeenCalledOnce();
            const handlerSignal = dispatch.mock.calls[0]?.[0]?.signal;
            expect(handlerSignal).toBeDefined();
            expect(handlerSignal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(DEFAULT_INVOCATION_TIMEOUT_MS);

            expect(handlerSignal?.aborted).toBe(true);
            settleDispatch({ ok: true, result: { completed: true } });
            await expect(submitting).resolves.toEqual({
                kind: 'stale',
                reason: 'action_retired',
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses one host-resolved Connected Account option result and submits its exact ref through canonical dispatch', async () => {
        const account = {
            service: { pluginId: 'com.acme.accounts', localId: 'service' },
            accountId: 'account-a',
        };
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        const resolveConnectedAccountOptions = vi.fn().mockResolvedValue({
            supported: true,
            result: {
                ok: true,
                options: [{ value: account, label: 'Work account' }],
            },
        });
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'configure-account',
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                    }],
                },
            })]),
            dispatch,
            resolveConnectedAccountOptions,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');

        const opened = await controller.open(entry);
        if (opened.kind !== 'form') throw new Error('expected form Action');
        const field = opened.form.presentation.inputHints.fields[0];
        const option = field?.options?.[0];
        if (!option || typeof option.value === 'string') throw new Error('expected host-resolved account ref');

        expect(resolveConnectedAccountOptions).toHaveBeenCalledWith(MACHINE_ID, expect.objectContaining({
            serverId: SERVER_ID,
            expectedGeneration: String(GENERATION),
            qualifiedActionId: 'acme.channels/configure-account',
            fieldPath: 'credentialRef',
        }));
        expect(field).not.toHaveProperty('connectedAccountOptions');
        expect(option.value).toEqual(account);

        opened.form.replaceInput({ credentialRef: option.value });
        await expect(opened.form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true, result: { completed: true } },
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            input: { credentialRef: account },
        }));
    });

    it('opens a successful empty Connected Account result with its derived empty marker', async () => {
        const resolveConnectedAccountOptions = vi.fn().mockResolvedValue({
            supported: true,
            result: { ok: true, options: [] },
        });
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'configure-account',
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                    }],
                },
            })]),
            dispatch: vi.fn(),
            resolveConnectedAccountOptions,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');

        const opened = await controller.open(entry);
        if (opened.kind !== 'form') throw new Error('expected an openable empty Action form');

        const field = opened.form.presentation.inputHints.fields[0];
        expect(field).toMatchObject({
            path: 'credentialRef',
            options: [],
            resolvedEmptyConnectedAccountOptions: true,
        });
        expect(field).not.toHaveProperty('connectedAccountOptions');
    });

    it('keeps a successful empty Connected Account result open through the exact-bound form path', async () => {
        const resolveConnectedAccountOptions = vi.fn().mockResolvedValue({
            supported: true,
            result: { ok: true, options: [] },
        });
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'configure-account',
                surfaces: ['plugin'],
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Account',
                        widget: 'select',
                        connectedAccountOptions: true,
                    }],
                },
            })]),
            dispatch: vi.fn(),
            resolveConnectedAccountOptions,
        });

        const opened = await controller.selectExactBoundActionInput({
            action: { pluginId: 'acme.channels', localId: 'configure-account' },
            expectedImmutableGenerationId: 'contributor-generation-a',
        });
        if (opened.kind !== 'form') throw new Error('expected an openable exact-bound Action form');

        const field = opened.form.presentation.inputHints.fields[0];
        expect(field).toMatchObject({
            path: 'credentialRef',
            options: [],
            resolvedEmptyConnectedAccountOptions: true,
        });
        expect(field).not.toHaveProperty('connectedAccountOptions');
    });

    it('rejects deferred Connected Account options when the exact machine host changes', async () => {
        let settleOptions: (value: MachinePluginActionFormConnectedAccountOptionsResult) => void = () => {
            throw new Error('Connected Account options promise was not initialized');
        };
        const pendingOptions = new Promise<MachinePluginActionFormConnectedAccountOptionsResult>((resolve) => {
            settleOptions = resolve;
        });
        const resolveConnectedAccountOptions = vi.fn(async () => await pendingOptions);
        const configure = action({
            id: 'configure-account',
            inputHints: {
                fields: [{
                    path: 'credentialRef',
                    title: 'Account',
                    widget: 'select',
                    connectedAccountOptions: true,
                }],
            },
        });
        let current = snapshot([configure]);
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            resolveConnectedAccountOptions,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');

        const opening = controller.open(entry);
        await vi.waitFor(() => expect(resolveConnectedAccountOptions).toHaveBeenCalledOnce());

        current = {
            ...current,
            host: {
                ...current.host,
                machineId: 'machine-b',
                serverId: 'server-b',
            },
        };
        settleOptions({
            supported: true,
            result: {
                ok: true,
                options: [{
                    value: {
                        service: { pluginId: 'com.acme.accounts', localId: 'service' },
                        accountId: 'account-a',
                    },
                    label: 'Account A',
                }],
            },
        });

        await expect(opening).resolves.toEqual({
            kind: 'stale',
            reason: 'host_retired',
        });
    });

    it('rejects deferred Connected Account options when the current session changes', async () => {
        let settleOptions: (value: MachinePluginActionFormConnectedAccountOptionsResult) => void = () => {
            throw new Error('Connected Account options promise was not initialized');
        };
        const pendingOptions = new Promise<MachinePluginActionFormConnectedAccountOptionsResult>((resolve) => {
            settleOptions = resolve;
        });
        const resolveConnectedAccountOptions = vi.fn(async () => await pendingOptions);
        const configure = action({
            id: 'configure-account',
            inputHints: {
                fields: [{
                    path: 'credentialRef',
                    title: 'Account',
                    widget: 'select',
                    connectedAccountOptions: true,
                }],
            },
        });
        let current = snapshot([configure]);
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            resolveConnectedAccountOptions,
        });
        const [entry] = controller.list({ placement: 'primary', scope: 'session' });
        if (!entry) throw new Error('expected eligible Action');

        const opening = controller.open(entry);
        await vi.waitFor(() => expect(resolveConnectedAccountOptions).toHaveBeenCalledOnce());

        current = {
            ...current,
            host: {
                ...current.host,
                sessionId: 'session-b',
            },
        };
        settleOptions({
            supported: true,
            result: {
                ok: true,
                options: [{
                    value: {
                        service: { pluginId: 'com.acme.accounts', localId: 'service' },
                        accountId: 'account-a',
                    },
                    label: 'Account A',
                }],
            },
        });

        await expect(opening).resolves.toEqual({
            kind: 'stale',
            reason: 'host_retired',
        });
    });

    it('does not let an opened message Action form migrate to a different Message reference', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { completed: true } });
        const initialMessageReference = {
            v: 1 as const,
            sessionId: SESSION_ID,
            messageId: 'message-a',
            observedRevision: 'revision-a',
        };
        let current: PluginContributedActionCurrentSnapshot = {
            ...snapshot([action({
                id: 'configure-message',
                placementBindings: ['rowAction'],
                scopes: ['message'],
                inputHints: {
                    fields: [{ path: 'token', title: 'Token', widget: 'secret', required: true }],
                },
            })]),
            host: {
                ...snapshot([]).host,
                messageActionReference: initialMessageReference,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });
        const [entry] = controller.list({ placement: 'rowAction', scope: 'message' });
        if (!entry) throw new Error('expected eligible Action');
        const opened = await controller.open(entry);
        if (opened.kind !== 'form') throw new Error('expected form Action');

        current = {
            ...current,
            host: {
                ...current.host,
                messageActionReference: {
                    ...initialMessageReference,
                    messageId: 'message-b',
                    observedRevision: 'revision-b',
                },
            },
        };
        opened.form.replaceInput({ token: 'must-not-cross-message-boundary' });

        await expect(opened.form.submit()).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        expect(dispatch).not.toHaveBeenCalled();
        expect(opened.form.getInput()).toEqual({});
    });

    it('does not repurpose semantic Action placements as a session-presentation fallback', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { connected: true } });
        const semanticOnly = { pluginId: 'acme.channels', localId: 'semantic-only' };
        const mixed = { pluginId: 'acme.channels', localId: 'mixed' };
        const initial = snapshot([
            action({
                id: semanticOnly.localId,
                placementBindings: ['composer.primary'],
            }),
            action({
                id: mixed.localId,
                // Preserve declaration ordering within the retained legacy
                // route; the semantic binding remains owned by Composer.
                placementBindings: ['composer.primary', 'primary'],
            }),
        ]);
        const current: PluginContributedActionCurrentSnapshot = {
            ...initial,
            host: {
                ...initial.host,
                // A shared Session snapshot may have a Composer supplier, but
                // a legacy presentation must not consume it as its own arm.
                currentComposerIntent: () => ({
                    composer: { kind: 'session', sessionId: SESSION_ID },
                    revision: 9,
                }),
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });

        expect(controller.isSessionReferenceAvailable(semanticOnly)).toBe(false);
        await expect(controller.openSessionReference(semanticOnly)).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        expect(dispatch).not.toHaveBeenCalled();

        expect(controller.isSessionReferenceAvailable(mixed)).toBe(true);
        await expect(controller.openSessionReference(mixed)).resolves.toEqual({
            kind: 'direct',
            action: expect.objectContaining({
                identity: mixed,
                placement: 'primary',
            }),
            outcome: { ok: true, result: { connected: true } },
        });
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty('invocation');
    });

    it('opens a current session action reference with the canonical absent-input sentinel and rejects a non-session replacement', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { connected: true } });
        const reference = { pluginId: 'acme.channels', localId: 'connect-account' };
        let current: PluginContributedActionCurrentSnapshot = {
            ...snapshot([action({ id: 'connect-account', scopes: ['session'] })]),
            host: {
                ...snapshot([]).host,
            },
        };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => current,
            dispatch,
        });

        expect(controller.isSessionReferenceAvailable(reference)).toBe(true);
        await expect(controller.openSessionReference(reference)).resolves.toEqual({
            kind: 'direct',
            action: expect.objectContaining({ identity: reference }),
            outcome: { ok: true, result: { connected: true } },
        });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            action: reference,
            input: null,
        }));
        const dispatchInput = dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(dispatchInput).not.toHaveProperty('callerPluginId');
        expect(dispatchInput).not.toHaveProperty('callerContributionLocalId');

        current = snapshot([action({ id: 'connect-account', scopes: ['message'] })]);
        expect(controller.isSessionReferenceAvailable(reference)).toBe(false);
        await expect(controller.openSessionReference(reference)).resolves.toEqual({
            kind: 'stale',
            reason: 'action_retired',
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('opens a current session reference form only when input is omitted, dispatching explicit input unchanged', async () => {
        const dispatch = vi.fn().mockResolvedValue({ ok: true, result: { configured: true } });
        const reference = { pluginId: 'acme.channels', localId: 'configure-account' };
        const controller = createPluginContributedActionController({
            resolveCurrent: () => snapshot([action({
                id: 'configure-account',
                inputHints: {
                    fields: [{
                        path: 'endpoint',
                        title: 'Endpoint',
                        widget: 'url',
                        required: true,
                    }],
                },
            })]),
            dispatch,
        });

        const opened = await controller.openSessionReference(reference);
        expect(opened.kind).toBe('form');
        expect(dispatch).not.toHaveBeenCalled();

        await expect(controller.openSessionReference(reference, null)).resolves.toEqual({
            kind: 'direct',
            action: expect.objectContaining({ identity: reference }),
            outcome: { ok: true, result: { configured: true } },
        });
        expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
            action: reference,
            input: null,
        }));

        await expect(controller.openSessionReference(reference, {
            endpoint: 'https://channels.example.test',
        })).resolves.toEqual({
            kind: 'direct',
            action: expect.objectContaining({ identity: reference }),
            outcome: { ok: true, result: { configured: true } },
        });
        expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
            action: reference,
            input: { endpoint: 'https://channels.example.test' },
        }));
    });

});
