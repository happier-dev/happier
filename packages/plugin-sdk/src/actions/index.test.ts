import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { getActionSpec as canonicalGetActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES as apiExternalActionResponseMaxSerializedBytes,
    isExternalActionResultWithinResponseEnvelopeLimitV1 as apiIsExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/protocol/actions';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES as canonicalExternalActionResponseMaxSerializedBytes,
    isExternalActionResultWithinResponseEnvelopeLimitV1 as canonicalIsExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/protocol/actions/externalActionLimits';
import {
    actionInputOptionValueKey as canonicalActionInputOptionValueKey,
    isSameActionInputOptionValue as canonicalIsSameActionInputOptionValue,
    normalizeActionInputByFieldHints as canonicalNormalizeActionInputByFieldHints,
    readActionInputOptionValue as canonicalReadActionInputOptionValue,
    resolveEffectiveActionInputFields as canonicalResolveEffectiveActionInputFields,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type {
    ActionInputFieldHint as CanonicalActionInputFieldHint,
    ActionInputHints as CanonicalActionInputHints,
    ActionInputOption as CanonicalActionInputOption,
    ActionInputPredicate as CanonicalActionInputPredicate,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type {
  ActionSpec as CanonicalActionSpec,
  PluginActionInputById as CanonicalPluginActionInputById,
  PluginActionResultById as CanonicalPluginActionResultById,
  PluginInvocableActionId as CanonicalPluginInvocableActionId,
  SessionTranscriptGetExternalShareableInputV1 as CanonicalSessionTranscriptGetExternalShareableInputV1,
  SessionTranscriptGetExternalShareableResultV1 as CanonicalSessionTranscriptGetExternalShareableResultV1,
} from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult as CanonicalActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    PluginMachineExecutionOriginV1Schema as canonicalPluginMachineExecutionOriginV1Schema,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type {
    PluginMachineExecutionOriginV1 as CanonicalPluginMachineExecutionOriginV1,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import {
    ExecutionRunGetResponseSchema,
    ExecutionRunListResponseSchema,
    ExecutionRunSendResponseSchema,
    ExecutionRunStartResponseSchema,
    ExecutionRunStopResponseSchema,
    ExecutionRunWaitResultSchema,
    SessionCreationKeyV1Schema,
} from '@happier-dev/protocol';
import type {
    ExecutionRunGetResponse,
    ExecutionRunListResponse,
    ExecutionRunSendResponse,
    ExecutionRunStartResponse,
    ExecutionRunStopResponse,
    ExecutionRunWaitResult,
    SessionSpawnNewInputV2,
    SessionSpawnNewResultV1,
} from '@happier-dev/protocol';

import { getActionSpec } from './service.js';
import { PluginMachineExecutionOriginV1Schema } from './index.js';
import {
    actionInputOptionValueKey,
    isSameActionInputOptionValue,
    normalizeActionInputByFieldHints,
    readActionInputOptionValue,
    resolveEffectiveActionInputFields,
} from './inputHints.js';
import type {
    ActionId,
    ActionInputFieldHint,
    ActionInputHints,
    ActionInputOption,
    ActionInputPredicate,
    ActionExecuteResult,
    ActionHandler,
    ActionSpec,
    ActionsService,
    PluginActionInputById,
    PluginActionResultById,
    PluginInvocableActionId,
    PluginMachineExecutionOriginV1 as ActionsPluginMachineExecutionOriginV1,
    SessionTranscriptGetExternalShareableInputV1,
    SessionTranscriptGetExternalShareableResultV1,
} from './service.js';
import type {
    ActionId as PublicActionId,
    SessionTranscriptGetExternalShareableInputV1 as PublicSessionTranscriptGetExternalShareableInputV1,
    SessionTranscriptGetExternalShareableResultV1 as PublicSessionTranscriptGetExternalShareableResultV1,
} from './index.public.js';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
} from './index.public.js';
import type {
    ContributedActionExecutionWithOriginOptions as PublicContributedActionExecutionWithOriginOptions,
    ContributedActionExecutionWithOriginResult as PublicContributedActionExecutionWithOriginResult,
} from './index.js';
import type { ActionHandler as ActivationActionHandler } from '../activation.js';
import type { PluginContributionRef } from '../identity.js';
import type {
    PluginMachineExecutionOriginV1 as PublicPluginMachineExecutionOriginV1,
} from './index.js';

async function bundleGetActionSpecProjection(): Promise<readonly string[]> {
    const source = fileURLToPath(new URL('./service.ts', import.meta.url));
    const protocolActionSpecsSource = fileURLToPath(
        new URL('../../../protocol/src/actions/actionSpecs.ts', import.meta.url),
    );
    const protocolActionInputHintsRuntimeSource = fileURLToPath(
        new URL('../../../protocol/src/actions/actionInputHintsRuntime.ts', import.meta.url),
    );
    const moduleGraph = new Map<string, readonly string[]>();
    await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [{
            name: 'actions-portable-value-projection',
            enforce: 'pre',
            resolveId(id) {
                if (id === '@happier-dev/protocol/actions/actionSpecs') {
                    return protocolActionSpecsSource;
                }
                if (id === '@happier-dev/protocol/actions/actionInputHintsRuntime') {
                    return protocolActionInputHintsRuntimeSource;
                }
                return id === 'virtual:actions-portable-value-projection' ? `\0${id}` : null;
            },
            load(id) {
                if (id !== '\0virtual:actions-portable-value-projection') return null;
                return `export { getActionSpec } from ${JSON.stringify(source)};`;
            },
            generateBundle() {
                for (const id of this.getModuleIds()) {
                    moduleGraph.set(id, this.getModuleInfo(id)?.importedIds ?? []);
                }
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                input: 'virtual:actions-portable-value-projection',
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    inlineDynamicImports: true,
                },
            },
        },
    });
    const queue: readonly Readonly<{ id: string; path: readonly string[] }>[] = [{
        id: '\0virtual:actions-portable-value-projection',
        path: ['virtual:actions-portable-value-projection'],
    }];
    const pending = [...queue];
    const visited = new Set<string>();
    const forbiddenReach: string[] = [];
    while (pending.length > 0) {
        const current = pending.shift();
        if (!current || visited.has(current.id)) continue;
        visited.add(current.id);
        for (const importedId of moduleGraph.get(current.id) ?? []) {
            const path = [...current.path, importedId];
            if (importedId.startsWith('node:') || importedId.includes('__vite-browser-external')) {
                forbiddenReach.push(path.join(' -> '));
                continue;
            }
            pending.push({ id: importedId, path });
        }
    }
    return forbiddenReach;
}

function actionServiceProtocolTypeSpecifiers(): readonly string[] {
    const source = readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');
    return [...source.matchAll(/import\s+type\s+[^;]+?from ['"](@happier-dev\/protocol(?:\/[^'"]+)?)['"]/gu)]
        .map((match) => match[1])
        .sort();
}

function definePluginActionDeclarationSource(): string {
    return readFileSync(fileURLToPath(new URL('../definePlugin.ts', import.meta.url)), 'utf8');
}

describe('ActionsService source contract', () => {
    it('projects external Action limits from the canonical Protocol API leaf', () => {
        expect(apiExternalActionResponseMaxSerializedBytes)
            .toBe(canonicalExternalActionResponseMaxSerializedBytes);
        expect(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES)
            .toBe(canonicalExternalActionResponseMaxSerializedBytes);
        expect(apiIsExternalActionResultWithinResponseEnvelopeLimitV1)
            .toBe(canonicalIsExternalActionResultWithinResponseEnvelopeLimitV1);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1)
            .toBe(canonicalIsExternalActionResultWithinResponseEnvelopeLimitV1);
    });

    it('keeps Action declaration field projections rooted in the public ActionContribution type', () => {
        const declarationSource = definePluginActionDeclarationSource();
        const publicActionsSource = readFileSync(fileURLToPath(new URL('./index.public.ts', import.meta.url)), 'utf8');

        expect(publicActionsSource).toContain("export type { ActionContribution } from './service.js';");
        expect(declarationSource).toContain(
            "import type { ActionContribution as PublicActionContribution } from './actions/service.js';",
        );
        expect(declarationSource).toContain("inputHints?: NonNullable<PublicActionContribution['inputHints']>;");
        expect(declarationSource).toContain("availability?: NonNullable<PublicActionContribution['availability']>;");
        expect(declarationSource).not.toContain('PluginActionManifestContribution');
    });

    it('projects the exact strict execution-origin validator through /actions', () => {
        expect(PluginMachineExecutionOriginV1Schema)
            .toBe(canonicalPluginMachineExecutionOriginV1Schema);
        expect(PluginMachineExecutionOriginV1Schema.safeParse({
            serverIdentityId: 'srv_action_origin_fixture',
            materializationRef: {
                pluginId: 'acme.target',
                machineId: 'machine-target',
                materializationId: 'materialization-target-current',
            },
        }).success).toBe(true);
        expect(PluginMachineExecutionOriginV1Schema.safeParse({
            serverIdentityId: 'srv_action_origin_fixture',
            materializationRef: {
                pluginId: 'acme.target',
                machineId: 'machine-target',
                materializationId: 'materialization-target-current',
            },
            unexpected: true,
        }).success).toBe(false);
        expectTypeOf<ActionsPluginMachineExecutionOriginV1>()
            .toEqualTypeOf<CanonicalPluginMachineExecutionOriginV1>();
    });

    it('projects exact canonical Action identities without a second registry', () => {
        expect(getActionSpec).toBe(canonicalGetActionSpec);
        expectTypeOf<ActionId>().toEqualTypeOf<CanonicalActionSpec['id']>();
        expectTypeOf<PublicActionId>().toEqualTypeOf<ActionId>();
        expectTypeOf<Parameters<typeof getActionSpec>[0]>()
            .toEqualTypeOf<Parameters<typeof canonicalGetActionSpec>[0]>();
        expectTypeOf<ReturnType<typeof getActionSpec>>().toEqualTypeOf<ActionSpec>();
        expectTypeOf<ActionSpec['id']>().toEqualTypeOf<CanonicalActionSpec['id']>();
        expectTypeOf<ActionSpec['inputHints']>()
            .toEqualTypeOf<CanonicalActionSpec['inputHints']>();
        expectTypeOf<ActionSpec['inputSchema']>().toEqualTypeOf<unknown>();
        // Public author inputs deliberately accept ordinary readonly JSON;
        // Protocol parser output remains the normalized mutable projection.
        expectTypeOf<CanonicalPluginActionInputById>()
            .toMatchTypeOf<PluginActionInputById>();
        expectTypeOf<CanonicalPluginActionResultById>()
            .toMatchTypeOf<PluginActionResultById>();
        expectTypeOf<PluginInvocableActionId>()
            .toEqualTypeOf<CanonicalPluginInvocableActionId>();
        expectTypeOf<ActionExecuteResult>().toEqualTypeOf<CanonicalActionExecuteResult>();
        expectTypeOf<ActionHandler>().toEqualTypeOf<ActivationActionHandler>();
    });

    it('projects canonical Action form vocabulary and resolvers through the SDK facade', () => {
        type NestedActionInputPredicate = {
            op: 'not';
            predicate: {
                op: 'eq';
                path: string;
                value: null;
            };
        };

        expect(resolveEffectiveActionInputFields).toBe(canonicalResolveEffectiveActionInputFields);
        expect(normalizeActionInputByFieldHints).toBe(canonicalNormalizeActionInputByFieldHints);
        expect(actionInputOptionValueKey).toBe(canonicalActionInputOptionValueKey);
        expect(isSameActionInputOptionValue).toBe(canonicalIsSameActionInputOptionValue);
        expect(readActionInputOptionValue).toBe(canonicalReadActionInputOptionValue);
        expectTypeOf<ActionInputHints>().toEqualTypeOf<CanonicalActionInputHints>();
        expectTypeOf<ActionInputFieldHint>().toEqualTypeOf<CanonicalActionInputFieldHint>();
        expectTypeOf<ActionInputOption>().toEqualTypeOf<CanonicalActionInputOption>();
        expectTypeOf<ActionInputPredicate>().toEqualTypeOf<CanonicalActionInputPredicate>();
        expectTypeOf<NestedActionInputPredicate>().toMatchTypeOf<ActionInputPredicate>();
        expectTypeOf<NestedActionInputPredicate>().toMatchTypeOf<CanonicalActionInputPredicate>();
        expectTypeOf<{ op: 'bogus' }>().not.toMatchTypeOf<ActionInputPredicate>();
        expectTypeOf<{ op: 'bogus' }>().not.toMatchTypeOf<CanonicalActionInputPredicate>();
        expectTypeOf<Parameters<typeof resolveEffectiveActionInputFields>[0]>()
            .toEqualTypeOf<Pick<ActionSpec, 'inputHints'>>();
        expectTypeOf<Parameters<typeof normalizeActionInputByFieldHints>[0]>()
            .toEqualTypeOf<Pick<ActionSpec, 'inputHints'>>();
    });

    it('projects the canonical execution-run result DTOs without a second SDK result shape', () => {
        expect(getActionSpec('execution.run.start').outputSchema).toBe(ExecutionRunStartResponseSchema);
        expect(getActionSpec('execution.run.list').outputSchema).toBe(ExecutionRunListResponseSchema);
        expect(getActionSpec('execution.run.get').outputSchema).toBe(ExecutionRunGetResponseSchema);
        expect(getActionSpec('execution.run.send').outputSchema).toBe(ExecutionRunSendResponseSchema);
        expect(getActionSpec('execution.run.stop').outputSchema).toBe(ExecutionRunStopResponseSchema);
        expect(getActionSpec('execution.run.wait').outputSchema).toBe(ExecutionRunWaitResultSchema);

        expectTypeOf<PluginActionResultById['execution.run.start']>()
            .toEqualTypeOf<ExecutionRunStartResponse>();
        expectTypeOf<PluginActionResultById['execution.run.list']>()
            .toEqualTypeOf<ExecutionRunListResponse>();
        expectTypeOf<PluginActionResultById['execution.run.get']>()
            .toEqualTypeOf<ExecutionRunGetResponse>();
        expectTypeOf<PluginActionResultById['execution.run.send']>()
            .toEqualTypeOf<ExecutionRunSendResponse>();
        expectTypeOf<PluginActionResultById['execution.run.stop']>()
            .toEqualTypeOf<ExecutionRunStopResponse>();
        expectTypeOf<PluginActionResultById['execution.run.wait']>()
            .toEqualTypeOf<ExecutionRunWaitResult>();
        expectTypeOf<ExecutionRunStartResponse['wait']>()
            .toEqualTypeOf<ExecutionRunWaitResult | undefined>();
        expectTypeOf<PluginActionInputById['session.transcript.get']>()
            .toEqualTypeOf<CanonicalSessionTranscriptGetExternalShareableInputV1>();
        expectTypeOf<PluginActionResultById['session.transcript.get']>()
            .toEqualTypeOf<CanonicalSessionTranscriptGetExternalShareableResultV1>();
        expectTypeOf<Extract<PluginInvocableActionId, 'session.permission_mode.set'>>()
            .toEqualTypeOf<'session.permission_mode.set'>();
        expectTypeOf<Extract<PluginInvocableActionId, 'session.history.get' | 'session.events.get' | 'session.messages.recent.get'>>()
            .toEqualTypeOf<'session.history.get' | 'session.events.get' | 'session.messages.recent.get'>();
        expectTypeOf<SessionTranscriptGetExternalShareableInputV1>()
            .toEqualTypeOf<CanonicalSessionTranscriptGetExternalShareableInputV1>();
        expectTypeOf<PublicSessionTranscriptGetExternalShareableInputV1>()
            .toEqualTypeOf<CanonicalSessionTranscriptGetExternalShareableInputV1>();
        expectTypeOf<SessionTranscriptGetExternalShareableResultV1>()
            .toEqualTypeOf<CanonicalSessionTranscriptGetExternalShareableResultV1>();
        expectTypeOf<PublicSessionTranscriptGetExternalShareableResultV1>()
            .toEqualTypeOf<CanonicalSessionTranscriptGetExternalShareableResultV1>();
    });

    it('keeps getActionSpec free of Node runtime reach', async () => {
        expect(await bundleGetActionSpecProjection()).toEqual([]);
    }, 60_000);

    it('keeps public Action service types in the SDK-local projection', () => {
        expect(actionServiceProtocolTypeSpecifiers()).toEqual([]);
        expect(readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8'))
            .toContain("./actionTypeMap.generated.js");
    });

    it('narrows host actions by literal id and keeps contributed actions reference-only', () => {
        expectTypeOf<ActionsService['execute']>().toBeFunction();

        const compileContract = (service: ActionsService) => {
            void service.execute('memory.get_window', {
                machineId: 'machine-1',
                sessionId: 'session-1',
                seqFrom: 1,
                seqTo: 2,
            });
            const sessionSpawnInput = {
                creationKey: SessionCreationKeyV1Schema.parse('plugin-operation-7'),
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                directory: '/workspace/project',
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
            } satisfies SessionSpawnNewInputV2;
            const sessionSpawnResult = service.execute('session.spawn_new', sessionSpawnInput);
            expectTypeOf<Awaited<typeof sessionSpawnResult>>()
                .toEqualTypeOf<SessionSpawnNewResultV1>();
            void service.execute(
                { pluginId: 'acme.target', localId: 'publish' },
                { title: 'Ready' },
            );
            const executionOriginResult = service.executeWithExecutionOrigin(
                { pluginId: 'acme.target', localId: 'publish' },
                { title: 'Ready' },
                {
                    expectedExecutionOrigin: {
                        serverIdentityId: 'srv_action_origin_fixture',
                        materializationRef: {
                            pluginId: 'acme.target',
                            machineId: 'machine-target',
                            materializationId: 'materialization-target-current',
                        },
                    },
                },
            );
            expectTypeOf<Parameters<ActionsService['executeWithExecutionOrigin']>[0]>()
                .toEqualTypeOf<PluginContributionRef>();
            expectTypeOf<Parameters<ActionsService['executeWithExecutionOrigin']>[2]>()
                .toEqualTypeOf<PublicContributedActionExecutionWithOriginOptions | undefined>();
            expectTypeOf<Awaited<typeof executionOriginResult>>()
                .toEqualTypeOf<PublicContributedActionExecutionWithOriginResult>();
            expectTypeOf<Awaited<typeof executionOriginResult>['executionOrigin']>()
                .toEqualTypeOf<PublicPluginMachineExecutionOriginV1>();
            void service.execute('daemon.promptAssets.discover', {
                assetTypeId: 'acme.skill',
                scope: 'project',
                directory: '/workspace',
            });
            void service.execute('daemon.promptAssets.delete', {
                assetTypeId: 'acme.skill',
                scope: 'user',
                externalRef: { skillName: 'reviewer' },
            });
            void service.execute('daemon.promptRegistry.scanSource', {
                sourceId: 'acme:catalog',
                configuredSources: [],
            });
            void service.execute('daemon.promptRegistry.install', {
                sourceId: 'acme:catalog',
                itemId: 'reviewer',
                configuredSources: [],
                installTarget: {
                    assetTypeId: 'acme.skill',
                    scope: 'project',
                    directory: '/workspace',
                    targetName: 'reviewer',
                },
            });
            const navigateResult = service.execute('browser.navigate', {
                kind: 'navigate',
                commandId: 'command-1',
                browserSessionId: 'browser-session-1',
                viewId: 'view-1',
                url: 'https://example.com',
            });
            expectTypeOf<Awaited<typeof navigateResult>>().toMatchTypeOf<
                | { v: 1; commandId: string; status: 'dispatched'; events: readonly unknown[] }
                | { v: 1; commandId: string; status: 'failed'; error: { code: string; message: string } }
            >();
            void service.execute('plugins.sessionHooks.status.get', {
                intent: 'passive_inventory',
            });
            void service.execute('plugins.sessionHooks.install', {
                agent: { localId: 'codex' },
                expectedPreviewId: `hook-install-preview:v1:${'1'.repeat(64)}`,
            });
            for (const actionId of [
                'plugins.sessionHooks.disable',
                'plugins.sessionHooks.enable',
                'plugins.sessionHooks.uninstall',
            ] as const) {
                void service.execute(actionId, {
                    agent: { localId: 'codex' },
                    installationId: 'installation-1',
                });
            }
            void service.execute('session.user_action.answer', {
                requestId: 'question-1',
                answers: [{ question: 'Continue?', values: ['Yes'] }],
            });

/* @sdk-negative-type-case:src-actions-index-test-ts-90:d3JvbmcgaW5wdXQgZm9yIHRoaXMgbGl0ZXJhbCBob3N0IGFjdGlvbiBpZC4:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ21lbW9yeS5nZXRfd2luZG93JywgeyBtYWNoaW5lSWQ6ICdtYWNoaW5lLTEnIH0pOw */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-91:Y29udHJpYnV0ZWQgYWN0aW9ucyByZXF1aXJlIGEgcXVhbGlmaWVkIHJlZmVyZW5jZSwgbmV2ZXIgYSBiYXJlIHN0cmluZy4:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ2FjbWUudGFyZ2V0L3B1Ymxpc2gnLCB7IHRpdGxlOiAnUmVhZHknIH0pOw */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-92:cmF3IEV4dGVybmFsIFNlc3Npb25zIHRha2VvdmVyIGlzIG5vdCBhIGRpc2NvdmVyYWJsZSBwbHVnaW4gYWN0aW9uLg:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ3Nlc3Npb25zLmV4dGVybmFsLnRha2VvdmVyLnN0YXJ0JywgeyBzZXNzaW9uSWQ6ICdzZXNzaW9uLTEnIH0pOw */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-93:cHJvbXB0IGRpc2NvdmVyIGtlZXBzIGl0cyBleGFjdCBjYW5vbmljYWwgYXNzZXQgcmVxdWVzdCBzaGFwZS4:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ2RhZW1vbi5wcm9tcHRBc3NldHMuZGlzY292ZXInLCB7IHNjb3BlOiAndXNlcicgfSk7 */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-94:cHJvbXB0IHJlZ2lzdHJ5IGluc3RhbGwga2VlcHMgaXRzIGV4YWN0IGNhbm9uaWNhbCBpbnN0YWxsIHRhcmdldC4:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ2RhZW1vbi5wcm9tcHRSZWdpc3RyeS5pbnN0YWxsJywgewogICAgICAgICAgICAgICAgc291cmNlSWQ6ICdhY21lOmNhdGFsb2cnLAogICAgICAgICAgICAgICAgaXRlbUlkOiAncmV2aWV3ZXInLAogICAgICAgICAgICAgICAgY29uZmlndXJlZFNvdXJjZXM6IFtdLAogICAgICAgICAgICB9KTs */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-95:YnJvd3Nlci5uYXZpZ2F0ZSByZXRhaW5zIHRoZSBjYW5vbmljYWwgcmVxdWlyZWQgVVJMIGZpZWxkLg:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ2Jyb3dzZXIubmF2aWdhdGUnLCB7CiAgICAgICAgICAgICAgICBraW5kOiAnbmF2aWdhdGUnLAogICAgICAgICAgICAgICAgY29tbWFuZElkOiAnY29tbWFuZC0xJywKICAgICAgICAgICAgICAgIGJyb3dzZXJTZXNzaW9uSWQ6ICdicm93c2VyLXNlc3Npb24tMScsCiAgICAgICAgICAgICAgICB2aWV3SWQ6ICd2aWV3LTEnLAogICAgICAgICAgICB9KTs */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-96:c3RhdGljYWxseS11bmJhY2tlZCBydW50aW1lIGFjdGlvbnMgYXJlIG5vdCBwbHVnaW4taW52b2NhYmxlLg:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ2RldmljZXMuc2ltdWxhdG9yLmlucHV0Lm9yaWVudGF0aW9uJywge30pOw */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-97:c2Vzc2lvbi5zcGF3bl9waWNrZXIgaXMgYW4gaW4tYXBwIFVJIGludGVyYWN0aW9uLCBub3QgYSBkYWVtb24gcGx1Z2luIG91dGNvbWUu:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ3Nlc3Npb24uc3Bhd25fcGlja2VyJywge30pOw */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-98:bWFjaGluZSByb3V0aW5nIGlzIGhvc3QgYXV0aG9yaXR5IG9uIHRoZSBQbHVnaW4gc3VyZmFjZS4:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ3BsdWdpbnMuc2Vzc2lvbkhvb2tzLmluc3RhbGwnLCB7CiAgICAgICAgICAgICAgICBtYWNoaW5lSWQ6ICdwbHVnaW4tc2VsZWN0ZWQtbWFjaGluZScsCiAgICAgICAgICAgICAgICBhZ2VudDogeyBsb2NhbElkOiAnY29kZXgnIH0sCiAgICAgICAgICAgICAgICBleHBlY3RlZFByZXZpZXdJZDogYGhvb2staW5zdGFsbC1wcmV2aWV3OnYxOiR7JzEnLnJlcGVhdCg2NCl9YCwKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-99:cGx1Z2luIGlkZW50aXR5IGlzIHN0YW1wZWQgYnkgdGhlIGhvc3QgZnJvbSB0aGUgaW52b2tpbmcgZ2VuZXJhdGlvbi4:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ3BsdWdpbnMuc2Vzc2lvbkhvb2tzLmVuYWJsZScsIHsKICAgICAgICAgICAgICAgIGFnZW50OiB7IHBsdWdpbklkOiAnc3Bvb2ZlZC5wbHVnaW4nLCBsb2NhbElkOiAnY29kZXgnIH0sCiAgICAgICAgICAgICAgICBpbnN0YWxsYXRpb25JZDogJ2luc3RhbGxhdGlvbi0xJywKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-actions-index-test-ts-101:cHJvdmlkZXItcHJpdmF0ZSBwZXJtaXNzaW9uIG11dGF0aW9ucyBhcmUgbm90IHB1YmxpYyBhY3Rpb24gaW5wdXQu:dm9pZCBzZXJ2aWNlLmV4ZWN1dGUoJ3Nlc3Npb24udXNlcl9hY3Rpb24uYW5zd2VyJywgewogICAgICAgICAgICAgICAgcmVxdWVzdElkOiAncXVlc3Rpb24tMScsCiAgICAgICAgICAgICAgICBkZWNpc2lvbjogJ2FwcHJvdmUnLAogICAgICAgICAgICAgICAgdXBkYXRlZFBlcm1pc3Npb25zOiB7fSwKICAgICAgICAgICAgfSk7 */
void 0; /* @sdk-negative-type-case-end */
        };

        expectTypeOf(compileContract).toBeFunction();
    });
});
