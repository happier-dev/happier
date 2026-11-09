import { describe, expect, it, vi } from 'vitest';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import { preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import { normalizeInputHintsText } from '@happier-dev/protocol/inputs/inputFields';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { EMAIL_SETUP_INPUT_SCHEMA } from '../../../../../../packages/plugins/channel-email/src/config';
import { EMAIL_CHANNEL_ACTION_IDS } from '../../../../../../packages/plugins/channel-email/src/constants';
import emittedEmailManifest from '../../../../../../apps/cli/assets/bundled-plugin-manifests/channel-email.json';
import type { PluginLocalizedStringV2} from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type {
    PluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginUiSelectActionInputResultV1Schema } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginActionInputSelectionHostApiHandler,
} from './pluginActionInputSelectionHostApi';

// Only the daemon RPC boundary is substituted; schema reading and form admission remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { QualifiedConnectedAccountRefJsonSchema } = await import('@happier-dev/protocol/connect/qualified-connected-account-persistence');
    return {
        machineRpcWithServerScope: async (request: Readonly<{
            method: string;
            payload: Readonly<{ qualifiedActionId: string; expectedOccurrenceId: string }>;
        }>) => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            && request.payload.qualifiedActionId === 'acme.setup/email/setup-v1'
            ? { ok: true, inputSchema: EMAIL_SETUP_INPUT_SCHEMA.jsonSchema }
            : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE
                && request.payload.qualifiedActionId === 'acme.setup/email/setup-v1'
                ? { ok: true, options: [{ label: 'Mailbox', value: {
                    service: { pluginId: 'acme.setup', localId: 'mailbox' }, accountId: 'mailbox-1',
                } }] }
            : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            && request.payload.qualifiedActionId === 'acme.setup/connection/prepare-v1'
            && request.payload.expectedOccurrenceId === 'setup-generation-a'
            ? { ok: true, inputSchema: {
                type: 'object',
                properties: { repository: { type: 'string' }, credentialRef: QualifiedConnectedAccountRefJsonSchema },
                required: ['repository'],
                additionalProperties: false,
            } }
            : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE
                && request.payload.qualifiedActionId === 'acme.setup/connection/prepare-v1'
                && request.payload.expectedOccurrenceId === 'setup-generation-a'
                ? { ok: true, options: [{ label: 'Mailbox', value: {
                    service: { pluginId: 'acme.setup', localId: 'mailbox' }, accountId: 'mailbox-1',
                } }] }
            : { ok: false, code: 'plugin_action_schemas_unavailable' },
    };
});

const accountLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose() {} }),
});

const operation: PluginUiTargetedContributionOperationV1 = {
    point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
    contributor: {
        pluginId: 'acme.setup',
        contributionId: 'provider',
        occurrenceId: 'setup-generation-a',
        sourceCustody: { kind: 'development', registeredRootId: 'setup-root' },
    },
    role: 'setup',
    action: { pluginId: 'acme.setup', localId: 'connection/prepare-v1' },
};

const serverStartDraft = {
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    directory: { kind: 'path', path: '/workspace' },
    agentTarget: {
        kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    },
} satisfies SessionServerStartSpawnDraftV1;

function targetedContributions(): PluginUiTargetedContributionsV1 {
    return {
        target: {
            pluginId: 'acme.caller',
            occurrenceId: 'caller-generation-a',
            sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
        },
        points: [{
            pointId: 'connection',
            protocols: [{
                protocol: { id: 'provider', version: 1 },
                contributions: [{
                    contributor: operation.contributor,
                    protocol: { id: 'provider', version: 1 },
                    operations: [operation],
                    surfaces: [],
                }],
            }],
        }],
    };
}

function projection(): Readonly<Record<string, PluginProjectionEntry>> {
    return {
        'acme.setup': {
            pluginId: 'acme.setup',
            immutableGenerationId: 'setup-generation-a',
            title: 'Setup',
            description: null,
            version: '1.0.0',
            enabled: true,
            generation: 7,
            generationLabel: '7',
            status: null,
            provenance: null,
            diagnostics: [],
            actions: [{
                id: 'connection/prepare-v1',
                occurrenceId: 'setup-generation-a',
                title: 'Prepare connection',
                description: null,
                icon: null,
                scopes: ['settings'],
                surfaces: ['plugin'],
                placementBindings: [],
                inputHints: {
                    fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }],
                },
                slash: null,
                priority: null,
                dangerLevel: 'safe',
                confirmation: null,
                available: true,
            }],
            resources: [],
            editableSettingsGroups: [],
        },
    };
}

/**
 * The exact raw V2 declaration for the admitted operation's Action, declaring a
 * client execution realm whose executable registration has not committed here.
 */
function clientProjectedAction(): PluginProjectedActionV2 {
    return {
        id: operation.action.localId,
        pluginId: operation.action.pluginId,
        occurrenceId: operation.contributor.occurrenceId,
        title: 'Prepare connection',
        scopes: ['settings'],
        surfaces: ['plugin'],
        execution: {
            target: 'client',
            client: {
                artifactId: 'client-main',
                exportName: 'activate',
            },
            platforms: ['web', 'ios', 'android'],
        },
        placementBindings: [],
        priority: 0,
        dangerLevel: 'safe',
        available: true,
    };
}

function request() {
    return {
        version: 1 as const,
        requestId: 'request-1',
        surface: {
            pluginId: 'acme.caller',
            contributionId: 'settings',
            surfaceId: 'surface-1',
            placement: 'appSurface' as const,
            platform: 'web' as const,
            channel: 'internal' as const,
            resourceScope: [],
            diagnostics: [],
        },
        method: 'selectActionInput' as const,
        payload: {
            operation,
            draft: { repository: 'happier-dev/happier' },
        },
    };
}

describe('plugin Action input selection Host API producer', () => {
    it.each(['development', 'managed'] as const)('initializes the published Email setup and reopens an explicit false draft for a %s contributor', async (custodyKind) => {
        const selectedOperation: PluginUiTargetedContributionOperationV1 = {
            ...operation,
            action: { pluginId: 'acme.setup', localId: 'email/setup-v1' },
            contributor: {
                ...operation.contributor,
                sourceCustody: custodyKind === 'development'
                    ? { kind: 'development', registeredRootId: 'setup-root' }
                    : { kind: 'managed', immutableGenerationId: 'setup-generation-a', installSource: 'archive' },
            },
        };
        const initialTargeted = targetedContributions();
        const targeted: PluginUiTargetedContributionsV1 = {
            ...initialTargeted,
            points: [{ ...initialTargeted.points[0]!, protocols: [{
                ...initialTargeted.points[0]!.protocols[0]!,
                contributions: [{
                    ...initialTargeted.points[0]!.protocols[0]!.contributions[0]!,
                    contributor: selectedOperation.contributor, operations: [selectedOperation],
                }],
            }] }],
        };
        const projected = projection();
        const plugin = projected['acme.setup']!;
        // The daemon discovers this published declaration, not the authored
        // setupHints module. Keep that producer seam in the real form path.
        const admittedManifest = ingestPluginManifestV2(emittedEmailManifest);
        if (!admittedManifest.ok) throw new Error(JSON.stringify(admittedManifest.diagnostics));
        const setupAction = admittedManifest.manifest.contributes.actions?.find(action => action.id === EMAIL_CHANNEL_ACTION_IDS.setup);
        if (!setupAction?.inputHints) throw new Error('Expected the published setup Action.');
        const hints = normalizeInputHintsText<PluginLocalizedStringV2>(setupAction.inputHints, value => typeof value === 'string' ? value : value.fallback);
        const account = { service: { pluginId: 'acme.setup', localId: 'mailbox' }, accountId: 'mailbox-1' };
        const draft = {
            mailbox: 'wilson@test.local',
            trustStrategy: { kind: 'authenticationResults', authservId: 'mx.seed1.test.local' },
            allowedDomains: ['test.local'], quotedHistory: 'stripKnown', stripSignatures: false, bodyFormat: 'markdown',
        };
        const present = vi.fn(({ form }: Parameters<NonNullable<Parameters<typeof createPluginActionInputSelectionHostApiHandler>[0]['present']>>[0]) => {
            expect(form.getInput()).toEqual(present.mock.calls.length === 1 ? { stripSignatures: true } : draft);
            form.replaceInput({ ...draft, credentialRef: account });
            void form.submit();
        });
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: { ...projected, 'acme.setup': { ...plugin, actions: [{
                ...plugin.actions[0]!, id: selectedOperation.action.localId, inputHints: hints,
            }] } },
            targetedContributions: targeted,
            host: { machineId: 'machine-a', serverId: 'server-a', targetPluginId: 'acme.caller', accountLifetime },
            isCurrent: () => true,
            present,
        });
        const firstSelection = await handler({ ...request(), payload: { operation: selectedOperation } });
        expect(firstSelection).toMatchObject({ kind: 'submitted', input: draft });
        const selected = PluginUiSelectActionInputResultV1Schema.parse(firstSelection);
        if (selected.kind !== 'submitted') throw new Error('Expected the initial setup selection.');
        await expect(handler({ ...request(), payload: { operation: selectedOperation, draft: selected.input } })).resolves.toMatchObject({
            kind: 'submitted', input: draft,
            connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account },
        });
        expect(present).toHaveBeenCalledTimes(2);
        await expect(handler({ ...request(), payload: { operation: selectedOperation,
            draft: { ...draft, trustStrategy: { kind: 'unsupported', authservId: 'mx.seed1.test.local' } } } })).resolves.toEqual({
            code: 'invalid_payload', diagnostics: ['invalid_draft'],
        });
        // A complete draft that already names one of the person's offered accounts settles as the form would,
        // without presenting it (owner ruling, AGENT-ACTIONS-UI-1107 account carriage).
        await expect(handler({ ...request(), payload: { operation: selectedOperation, draft: { ...draft, credentialRef: account } } }))
            .resolves.toMatchObject({ kind: 'submitted', input: draft,
                connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account } });
        expect(present).toHaveBeenCalledTimes(2);
    });

    it('presents a targeted provider setup form through real schema and Connected Account RPC adapters', async () => {
        const projected = projection();
        const plugin = projected['acme.setup']!;
        const pluginProjectionById = { ...projected, 'acme.setup': { ...plugin, actions: plugin.actions.map(action => ({
            ...action, inputHints: { fields: [...action.inputHints!.fields, {
                path: 'credentialRef', title: 'Account', widget: 'select' as const, connectedAccountOptions: true as const, required: true,
            }] },
        })) } };
        const account = { service: { pluginId: 'acme.setup', localId: 'mailbox' }, accountId: 'mailbox-1' };
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById, targetedContributions: targetedContributions(),
            host: { machineId: 'machine-a', serverId: 'server-a', targetPluginId: 'acme.caller', accountLifetime },
            isCurrent: () => true,
            present: ({ form }) => {
                form.replaceInput({ repository: 'happier-dev/happier', credentialRef: account });
                void form.submit();
            },
        });
        await expect(handler(request())).resolves.toMatchObject({
            kind: 'submitted', action: operation.action, input: { repository: 'happier-dev/happier' },
            connectedAccount: { kind: 'selected', fieldPath: 'credentialRef', ref: account },
            presentation: { connectedAccountLabel: 'Mailbox' },
        });
    });

    it('presents the incumbent form and returns normalized input without invocation', async () => {
        const present = vi.fn(({ form }) => {
            void form.submit();
        });
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                serverId: 'server-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present,
        });

        await expect(handler(request())).resolves.toEqual({
            kind: 'submitted',
            action: { pluginId: 'acme.setup', localId: 'connection/prepare-v1' },
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: targetedContributions().target.pluginId,
                    sourceCustody: targetedContributions().target.sourceCustody,
                },
                point: operation.point,
                contributor: {
                    pluginId: operation.contributor.pluginId,
                    contributionId: operation.contributor.contributionId,
                    sourceCustody: operation.contributor.sourceCustody,
                },
            },
            connectedAccount: { kind: 'none' },
            presentation: { connectedAccountLabel: null, machineDisplayName: null },
        });
        expect(present).toHaveBeenCalledOnce();
    });

    it('resolves localized Action form presentation from the mounted projection', async () => {
        await preloadTranslations('es');
        setPreferredLanguageFromSettings('es');
        try {
            const projected = projection();
            const setup = projected['acme.setup']!;
            const sourceAction = setup.actions[0]!;
            const localizedProjection = Object.freeze({
                ...projected,
                'acme.setup': Object.freeze({
                    ...setup,
                    actions: [Object.freeze({
                        ...sourceAction,
                        localizedPresentation: Object.freeze({
                            title: { key: 'actions.prepare.title', fallback: 'Prepare connection' },
                            description: { key: 'actions.prepare.description', fallback: 'Prepare the connection.' },
                            inputHints: {
                                title: { key: 'actions.prepare.form.title', fallback: 'Prepare connection' },
                                fields: [{
                                    path: 'repository',
                                    title: { key: 'actions.prepare.form.repository', fallback: 'Repository' },
                                    widget: 'text' as const,
                                    required: true,
                                }],
                            },
                        }),
                    })],
                }),
            });
            const pluginUiProjection: PluginUiProjectionModel = Object.freeze({
                ...EMPTY_PLUGIN_UI_PROJECTION,
                translationsByPluginId: Object.freeze({
                    'acme.setup': Object.freeze({
                        id: 'translations:acme.setup',
                        pluginId: 'acme.setup',
                        contributionKind: 'translations' as const,
                        locales: ['en', 'es'],
                        bundles: Object.freeze({
                            en: Object.freeze({}),
                            es: Object.freeze({
                                'actions.prepare.title': 'Preparar conexión',
                                'actions.prepare.description': 'Prepara la conexión.',
                                'actions.prepare.form.title': 'Preparar conexión',
                                'actions.prepare.form.repository': 'Repositorio',
                            }),
                        }),
                    }),
                }),
            });
            const handlerInput = {
                pluginProjectionById: localizedProjection,
                // The mounted host already owns this exact normalized projection;
                // this test proves selection does not discard its Action presentation.
                pluginUiProjection,
                targetedContributions: targetedContributions(),
                host: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    targetPluginId: 'acme.caller',
                    accountLifetime,
                },
                isCurrent: () => true,
                present: ({ form }: { form: { presentation: unknown; submit: () => Promise<unknown> } }) => {
                    expect(form.presentation).toEqual({
                        title: 'Preparar conexión',
                        description: 'Prepara la conexión.',
                        inputHints: {
                            title: 'Preparar conexión',
                            fields: [{
                                path: 'repository',
                                title: 'Repositorio',
                                widget: 'text',
                                required: true,
                            }],
                        },
                    });
                    void form.submit();
                },
            };
            const handler = createPluginActionInputSelectionHostApiHandler(handlerInput);

            await expect(handler(request())).resolves.toMatchObject({ kind: 'submitted' });
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('settles explicit dismissal as cancellation', async () => {
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present: ({ form }) => form.cancel(),
        });
        await expect(handler(request())).resolves.toEqual({ kind: 'cancelled' });
    });

    it('retires the form and returns a typed failure when the caller aborts', async () => {
        const abort = new AbortController();
        let capturedForm: { getInput(): Readonly<Record<string, unknown>> } | undefined;
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present: ({ form }) => {
                capturedForm = form;
                abort.abort();
            },
        });
        await expect(handler(request(), { signal: abort.signal })).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['select_action_input_aborted'],
        });
        expect(capturedForm?.getInput()).toEqual({});
    });

    it('settles typed-stale when the exact bound target retires before submission', async () => {
        let current = true;
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => current,
            present: ({ form }) => {
                current = false;
                void form.submit();
            },
        });

        const outcome = await handler(request());
        expect(outcome).toEqual({ code: 'stale_surface', diagnostics: ['host_retired'] });
    });

    it('rejects a submitted value outside the canonical host-input bound', async () => {
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            host: {
                machineId: 'machine-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present: ({ form }) => {
                form.replaceInput({ repository: 'a'.repeat(8_192) });
                void form.submit();
            },
        });

        await expect(handler({
            ...request(),
            payload: {
                operation,
            },
        })).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['select_action_input_result_invalid'],
        });
    });

    it('routes the one literal Session host request to the no-invoke Session composer', async () => {
        const composeSessionServerStartDraft = vi.fn(async () => ({
            kind: 'submitted' as const,
            draft: serverStartDraft,
        }));
        const handler = createPluginActionInputSelectionHostApiHandler({
            // There is deliberately no targeted projection/snapshot here: this
            // request must not enter the contributed-Action selector.
            host: {
                machineId: 'machine-a',
                serverId: 'server-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            composeSessionServerStartDraft,
        });

        await expect(handler({
            ...request(),
            payload: {
                hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
                draft: { directory: '/workspace', agentId: 'claude' },
            },
        })).resolves.toEqual({ kind: 'serverStartDraft', draft: serverStartDraft });
        expect(composeSessionServerStartDraft).toHaveBeenCalledOnce();
    });

    it('refuses a literal Session draft whose server disagrees with the captured Account scope', async () => {
        const composeSessionServerStartDraft = vi.fn(async () => ({
            kind: 'submitted' as const,
            draft: serverStartDraft,
        }));
        const handler = createPluginActionInputSelectionHostApiHandler({
            host: {
                machineId: 'machine-a',
                serverId: 'server-b',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            composeSessionServerStartDraft,
        });

        await expect(handler({
            ...request(),
            payload: {
                hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            },
        })).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['host_unavailable'],
        });
        expect(composeSessionServerStartDraft).not.toHaveBeenCalled();
    });
    it('withholds a targeted client Action form until its executable registration commits', async () => {
        const present = vi.fn(({ form }: { form: { submit: () => Promise<unknown> } }) => {
            void form.submit();
        });
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            resolveContributedAction: (identity) => (
                identity.pluginId === operation.action.pluginId
                    && identity.localId === operation.action.localId
                    ? clientProjectedAction()
                    : null
            ),
            host: {
                machineId: 'machine-a',
                serverId: 'server-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present,
        });

        await expect(handler(request())).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['action_retired'],
        });
        expect(present).not.toHaveBeenCalled();
    });

    it('still presents a targeted daemon Action form through the same raw resolver', async () => {
        const present = vi.fn(({ form }: { form: { submit: () => Promise<unknown> } }) => {
            void form.submit();
        });
        const handler = createPluginActionInputSelectionHostApiHandler({
            pluginProjectionById: projection(),
            targetedContributions: targetedContributions(),
            resolveContributedAction: (identity) => (
                identity.pluginId === operation.action.pluginId
                    && identity.localId === operation.action.localId
                    ? { ...clientProjectedAction(), execution: { target: 'daemon' as const } }
                    : null
            ),
            host: {
                machineId: 'machine-a',
                serverId: 'server-a',
                targetPluginId: 'acme.caller',
                accountLifetime,
            },
            isCurrent: () => true,
            present,
        });

        await expect(handler(request())).resolves.toMatchObject({ kind: 'submitted' });
        expect(present).toHaveBeenCalledOnce();
    });
});
