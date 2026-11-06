import { describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    isPluginError,
    type JsonValue,
    PluginError,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import * as actionContractProducer from '../../../../../../packages/plugin-sdk/examples/action-contract-producer/src/index';
import type { MessageActionAvailableSnapshotV1, PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import type {
    HostCurrentSessionInteractionsService,
} from '@/agent/runtime/state/currentSessionUiTypes';
import {
    createNativeAgentCurrentSessionUiServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import type { HostCurrentSessionPresentationService } from '@/agent/runtime/state/currentSessionUiTypes';

import { createTargetActionInvocationRegistry } from './targetActionRegistry';
import { logger } from '@/ui/logger';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { createTargetActionCurrentIntentAdapter, targetActionApprovalMatchesCurrentIntent } from '@/session/actions/approvals/targetActionCurrentIntent';
import { StoredTargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { TargetActionCurrentIntentRequest } from './actionExecutor';
import { TriageStartEntrySessionInputV1Schema, TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 } from '../../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';
import { createTriageSelectedPrStartApprovalInput } from '../../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';
import { resolveApprovalRequestApproveAdmission } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { createTargetActionHostBindingResolver } from '../hostAccess/resolve';
import {
    createUnavailablePluginServicesFactory,
} from './services/factory';
import type { PluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { createProductionPluginInvocationServiceOwners } from './services/production';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import {
    createPluginInvocationLogger,
    createPluginInvocationSecretRedactor,
    type PluginInvocationLogRecord,
} from './services/logger';

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function action(overrides: Record<string, unknown> = {}) {
    return {
        pluginId: 'acme.alpha',
        pluginVersion: '1.2.3',
        occurrenceId: '7' as PluginRuntimeOccurrenceId,
        // Target Actions resolve only with host-stamped source custody.
        sourceCustody: createManagedPluginSourceCustody('acme-alpha-generation-1'),
        localId: 'run',
        definition: {
            id: 'run',
            dangerLevel: 'safe',
            scopes: ['global'],
            surfaces: ['cli'],
            inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false,
            },
            resultSchema: {
                type: 'object',
                properties: { echoed: { type: 'string' } },
                required: ['echoed'],
                additionalProperties: false,
            },
            ...overrides,
        },
    } as const;
}

function createRegistry(
    params: Omit<Parameters<typeof createTargetActionInvocationRegistry>[0], 'createServices' | 'resolveHostBinding' | 'resolveAuthorizationFacts'>
        & Partial<Pick<Parameters<typeof createTargetActionInvocationRegistry>[0], 'createServices' | 'resolveHostBinding' | 'resolveAuthorizationFacts'>>,
) {
    return createTargetActionInvocationRegistry({
        resolveAuthorizationFacts: (resolvedAction) => ({
            generation: {
                targetGeneration: resolvedAction.occurrenceId,
                desiredGeneration: resolvedAction.occurrenceId,
                appliedGeneration: resolvedAction.occurrenceId,
            },
            resourceSelections: [],
            scopedGrants: [],
            operatingSystemAuthorization: [],
        }),
        createServices: createUnavailablePluginServicesFactory(),
        resolveHostBinding: createTargetActionHostBindingResolver(),
        readCurrentPluginOccurrenceId: (pluginId) => (
            (params.readActions?.() ?? params.actions)
                .find((candidate) => candidate.pluginId === pluginId)?.occurrenceId
            ?? null
        ),
        ...params,
    });
}

describe('target action invocation registry', () => {
    it('refuses an Environment-scoped contributed Action before its handler without admitted owner facts', async () => {
        const handler = vi.fn(async () => ({ echoed: 'never' }));
        const registry = createRegistry({ actions: [{ ...action({ approvalScope: 'environment' }), handler }] });
        try {
            expect(await registry.invoke({ pluginId: 'acme.alpha', localId: 'run',
                surface: 'cli', input: { value: 'reviewed' } })).toMatchObject({
                status: 'failed', code: 'deployment_unavailable', actionHandlerInvocation: 'notStarted',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally { registry.dispose(); }
    });

    it('reads template Environment policy once per contributed Action admission', async () => {
        const template = createDeploymentEnvironmentHeaderV1();
        const environment = createDeploymentEnvironmentHeaderV1({ id: 'preview-child', purpose: 'preview',
            previewTemplateEnvironmentId: template.id, previewRepositoryId: 'source-app', previewPullRequestId: 'pr-42', previewTargetLinkId: 'template-link' });
        const actionId = formatQualifiedPluginActionId({ pluginId: 'acme.alpha', localId: 'run' });
        const scope = { kind: 'environment', environmentId: template.id } as const;
        let settings = normalizeActionsSettingsV1({ v: 1, scopedApprovalPreferences: [{ actionId, scope,
            approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['cli'] }] });
        const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${environment.id}`);
            return { status: 200, data: { ok: true, environment, targetLinks: [] } };
        });
        const deployment = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test',
            admitAccount: async () => null, resolveRequestHeaders: async () => ({}),
            async dispatchReceipt() { throw new Error('Approval admission never dispatches a receipt'); },
        });
        const handler = vi.fn(async () => ({ echoed: 'reviewed' }));
        const registry = createRegistry({ actions: [{ ...action({ approvalScope: 'environment', dangerLevel: 'writesRemote',
            confirmation: { title: 'Publish preview status?' },
            inputSchema: { type: 'object', properties: { serverId: { type: 'string' }, environmentId: { type: 'string' } },
                required: ['serverId', 'environmentId'], additionalProperties: false } }), handler },
            { ...action(), localId: 'plain', definition: { ...action().definition, id: 'plain' },
                handler: async () => ({ echoed: 'ordinary' }) }] });
        const invocation = {
            pluginId: 'acme.alpha', localId: 'run', surface: 'cli',
            input: { serverId: environment.serverId, environmentId: environment.id },
            approvalContext: { serverId: environment.serverId },
            resolveEnvironmentApprovalScope: deployment.resolveEnvironmentApprovalScope,
            isApprovalRequiredByActionSettings: (manifestDefault: boolean, _input: unknown,
                admission?: import('@happier-dev/protocol/actions/actionApprovalPolicy').ActionEnvironmentApprovalScopeAdmissionV1) =>
                isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'cli' }, undefined, manifestDefault,
                    undefined, undefined, undefined, undefined, admission?.scope ?? undefined),
        } as const;
        try {
            expect(await registry.invoke({ ...invocation, localId: 'plain', input: { value: 'unrelated' } }))
                .toMatchObject({ status: 'executed', value: { echoed: 'ordinary' } });
            expect(http).not.toHaveBeenCalled();
            const waived = await registry.invoke(invocation);
            expect(waived, JSON.stringify(waived)).toMatchObject({ status: 'executed', value: { echoed: 'reviewed' } });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(http).toHaveBeenCalledTimes(1);
            const prepared = await registry.prepare(invocation);
            expect(prepared.kind).toBe('ready');
            expect(http).toHaveBeenCalledTimes(2);
            // O-DEPLOY 2026-11-05: admitted finite work finishes; the next
            // admission consumes a changed preference, without per-step reads.
            settings = normalizeActionsSettingsV1({ v: 1, scopedApprovalPreferences: [{ actionId, scope,
                approvalRequiredSurfaces: ['cli'], approvalWaivedSurfaces: [] }] });
            if (prepared.kind === 'ready') expect(await prepared.run()).toMatchObject({
                status: 'executed', value: { echoed: 'reviewed' },
            });
            expect(http).toHaveBeenCalledTimes(2);
            const requestCurrentIntent = vi.fn(async () => ({ status: 'rejected' as const, code: 'plugin_action_current_intent_rejected' }));
            expect(await registry.invoke({ ...invocation, requestCurrentIntent })).toMatchObject({
                status: 'unavailable', code: 'plugin_action_current_intent_rejected', actionHandlerInvocation: 'notStarted',
            });
            expect(requestCurrentIntent).toHaveBeenCalledOnce();
            expect(http).toHaveBeenCalledTimes(3);
            expect(handler).toHaveBeenCalledTimes(2);
        } finally { http.mockRestore(); registry.dispose(); }
    });

    it('splits preparation, account binding and authored execution under the ingress request without content', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
        const requestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
        const registry = createRegistry({
            actions: [{ ...action(), handler: async () => ({ echoed: 'private-result-marker' }) }],
        });
        try {
            expect(await runTracedExternalActionStage('action.invoke', `rpc_${requestId}`, 'contributed.target_invoke', () =>
                registry.invoke({ pluginId: 'acme.alpha', localId: 'run', surface: 'cli', input: { value: 'private-input-marker' } })))
                .toMatchObject({ status: 'executed', value: { echoed: 'private-result-marker' } });
            const records = sink.mock.calls.filter(([message]) => message === '[external-action-stage]');
            for (const phase of ['contributed.services.prepare', 'contributed.connected_account.bind', 'contributed.handler']) {
                expect(records).toContainEqual(['[external-action-stage]', expect.objectContaining({
                    rootRequestId: requestId, stage: `${phase}.end`, elapsedMs: expect.any(Number),
                })]);
            }
            expect(JSON.stringify(records)).not.toContain('private-');
        } finally { registry.dispose(); sink.mockRestore(); vi.unstubAllEnvs(); }
    });

    it('uses the authored reversible own-UI default without weakening automation or explicit Ask', async () => {
        const { createCollectionDetailPlugin } = await import('../../../../../../packages/plugin-sdk/fixtures/qa-plugin-authoring/qa-collection-detail/index');
        const module = createCollectionDetailPlugin();
        const plugin = await createPluginTestkit({ manifest: module.manifest, module });
        const declaration = normalizePluginManifestV2(module.manifest).contributes.actions.find(candidate => candidate.id === 'set-complete');
        if (!declaration) throw new Error('Collection completion declaration missing');
        const handler = plugin.registration('actions', declaration.id);
        if (!handler) throw new Error('Collection completion handler missing');
        const contexts: PluginInvocationContext[] = [];
        const caller = {
            kind: 'plugin', pluginId: module.manifest.id,
            contribution: { id: 'reviews', qualifiedId: `${module.manifest.id}/ui.views/reviews` },
            occurrenceId: '7', sourceCustody: createManagedPluginSourceCustody('qa-collection-generation'),
            originSurface: 'ui',
        } as const;
        const registry = createRegistry({ actions: [{
            ...action(), pluginId: module.manifest.id, localId: declaration.id,
            sourceCustody: caller.sourceCustody,
            definition: { ...declaration, inputSchema: declaration.inputSchema ?? undefined },
            handler: (input, context) => { contexts.push(context); return handler(input, context); },
        }] });
        const read = async () => {
            const resource = plugin.registration('resources', 'rows');
            if (!resource) throw new Error('Rows Resource missing');
            return JSON.parse(String(await resource.read(createTestResourceInvocationContext({ context: { kind: 'global' }, signal: new AbortController().signal }))));
        };
        const invoke = (surface: 'ui' | 'agent' | 'mcp', completed: boolean, ask?: boolean,
            invocationAuthority: 'present_user' | 'account_automation' = surface === 'ui' ? 'present_user' : 'account_automation') => registry.invoke({
            pluginId: module.manifest.id, localId: declaration.id, surface,
            invocationAuthority,
            ...(surface === 'ui' ? { caller } : {}),
            input: { rowId: 'release-guide', completed },
            isApprovalRequiredByActionSettings: manifestDefault => ask ?? manifestDefault,
        });
        try {
            expect(await invoke('ui', true)).toMatchObject({ status: 'executed', value: { row: { completed: true } } });
            expect((await read()).rows[0].completed).toBe(true);
            expect(await invoke('ui', false, undefined, 'account_automation'))
                .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
            expect((await read()).rows[0].completed).toBe(true);
            for (const surface of ['agent', 'mcp', 'ui'] as const) {
                expect(await invoke(surface, false, surface === 'ui' ? true : undefined))
                    .toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
                expect((await read()).rows[0].completed).toBe(true);
            }
            expect(await invoke('ui', false)).toMatchObject({ status: 'executed', value: { row: { completed: false } } });
            expect((await read()).rows[0].completed).toBe(false);
            expect(contexts).toHaveLength(2);
            for (const context of contexts) {
                expect(context).toMatchObject({ surface: 'ui', caller,
                    contribution: { qualifiedId: `${module.manifest.id}/actions/set-complete` } });
            }
        } finally { registry.dispose(); await plugin.dispose(); }
    });

    it('classifies normalized external Action input while preserving required approvals and replay admission', async () => {
        const registry = createRegistry({ actions: [{
            ...action({
                inputSchema: {}, resultSchema: {}, dangerLevel: 'writesLocal',
                confirmation: { title: 'Change bindings?' },
                confirmationWhen: { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'list' } },
            }),
            inputParser: input => ({ success: true, data: { kind: isJsonRecord(input) ? input.normalizedKind : null } }),
            handler: async input => input,
        }] });
        const base = { pluginId: 'acme.alpha', localId: 'run', surface: 'cli' as const };
        try {
            const listed = await registry.invoke({ ...base, input: { kind: 'attach', normalizedKind: 'list' },
                isApprovalRequiredByActionSettings: manifestDefault => manifestDefault,
            });
            expect(listed, JSON.stringify(listed)).toMatchObject({ status: 'executed', value: { kind: 'list' } });
            expect(await registry.invoke({ ...base, input: { kind: 'list', normalizedKind: 'attach' },
                isApprovalRequiredByActionSettings: manifestDefault => manifestDefault,
            })).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
            expect(await registry.invoke({ ...base, input: { normalizedKind: 'list' },
                isApprovalRequiredByActionSettings: () => true,
            })).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
            expect(await registry.invoke({ ...base, input: { kind: 'list' }, requireCurrentIntent: true,
                isApprovalRequiredByActionSettings: () => false,
            })).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
        } finally { registry.dispose(); }
    });

    it.each((['agent', 'mcp', 'cli'] as const).flatMap(surface =>
        (['handler', 'result'] as const).map(phase => ({ surface, phase })),
    ))('keeps raw confidential operands classified after normalization for $phase on $surface', async ({ surface, phase }) => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
        const raw = { bundle: phase === 'result' ? 738291642 : { pin: 738291642, enabled: true, optional: null }, public: 31 };
        let parsedOperand: JsonValue = null;
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['bundle'], surfaces: ['agent', 'mcp', 'cli'],
                dangerLevel: 'writesRemote', confirmation: { title: 'Publish' } }),
            inputParser: candidate => {
                parsedOperand = isJsonRecord(candidate) ? candidate.bundle ?? null : null;
                return { success: true as const, data: { public: 31 } };
            },
            ...(phase === 'result' ? { resultParser: () => ({ success: false as const,
                issues: [{ path: ['bundle'], code: 'invalid_value', message: `Rejected raw ${JSON.stringify(parsedOperand)}` }] }) } : {}),
            handler: async (input, context) => {
                expect(input).toEqual({ public: 31 });
                if (phase === 'result') return input;
                const details = { bundle: parsedOperand, public: 31 };
                context.services.logger.info('Validation failed', details);
                throw new PluginError({ code: 'validation_failed', message: 'Validation failed', details });
            },
        }] });
        try {
            const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: raw, surface,
                // The approval decision is external; the real gate still binds
                // normalized input and rebinds the diagnostic correlation.
                requestCurrentIntent: async request => {
                    expect(request.action.input).toEqual({ public: 31 });
                    return { status: 'approved', fingerprint: request.fingerprint, artifactId: `raw-normalized-${surface}-${phase}` };
                } });
            expect(result).toMatchObject(phase === 'handler'
                ? { status: 'failed', data: { details: { bundle: '[REDACTED]', public: 31 } } }
                : { status: 'invalid', code: 'plugin_action_result_schema_invalid' });
            expect(JSON.stringify(result)).not.toContain('738291642');
            if (phase === 'handler') expect(records.find(record => record.fields)?.fields).toEqual({ bundle: '[REDACTED]', public: 31 });
        } finally { registry.dispose(); }
    });

    it.each(['agent', 'mcp', 'cli'] as const)('withholds string-secret numeric issue-path suffixes on %s', async surface => {
        const secret = '738291642';
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const publicIssue = { path: ['items', 31], code: 'invalid_value', message: 'Public item 31',
            expected: `starts_with "${secret}"`, acceptedValues: [secret, 'public-choice'] };
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent', 'mcp', 'cli'] }),
            inputParser: () => ({ success: false as const,
                issues: [{ path: ['value', Number(secret)], code: 'invalid_value', message: 'Invalid confidential value' }, publicIssue] }),
            handler: async () => { throw new Error('Must not run'); },
        }] });
        try {
            const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: secret }, surface });
            expect(result).toMatchObject({ status: 'invalid', code: 'plugin_action_input_schema_invalid' });
            if (result.status !== 'invalid') throw new Error('Expected invalid input');
            expect(result.issues?.[0]?.path).toEqual(['value']);
            expect(result.issues?.[1]).toEqual({ ...publicIssue,
                expected: 'starts_with [REDACTED]', acceptedValues: ['[REDACTED]', 'public-choice'] });
            expect(JSON.stringify(result)).not.toContain(secret);
        } finally { registry.dispose(); }
    });

    it.each([true, false, null, 1, 738291642])('preserves unrelated public diagnostic scalars when confidential input is %s', async value => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
        const publicFields = { enabled: true, disabled: false, optional: null, count: 1, total: 31, largeCount: 738291642,
            nested: [true, null, 1], note: 'true false null 1; public diagnostic at item 31 with count 738291642',
            encoded: 'dHJ1ZQ== ZmFsc2U= bnVsbA== MQ== 74727565 31' };
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent'] }),
            handler: async (_input, context) => {
                context.services.logger.info('Public diagnostic', publicFields);
                throw new PluginError({ code: 'public_failure', message: 'Public diagnostic', details: { public: publicFields } });
            },
        }] });
        try {
            const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value }, surface: 'agent' });
            expect(result).toMatchObject({ status: 'failed', code: 'public_failure', data: { details: { public: publicFields } } });
            expect(records.at(-1)?.fields).toEqual(publicFields);
        } finally { registry.dispose(); }
    });

    it('preserves successful public results when confidential input is true', async () => {
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent'] }),
            handler: async () => ({ enabled: true, count: 1, optional: null }),
        }] });
        try {
            expect(await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: true }, surface: 'agent' }))
                .toMatchObject({ status: 'executed', value: { enabled: true, count: 1, optional: null } });
        } finally { registry.dispose(); }
    });

    it('keeps bounded log sanitization before confidential path projection', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent'] }),
            handler: async (_input, context) => {
                const fields: Record<string, JsonValue> = { value: 1, count: 31 };
                fields.circular = fields;
                context.services.logger.info('Public diagnostic', fields);
                return null;
            },
        }] });
        try {
            await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 1 }, surface: 'agent' });
            expect(records.at(-1)?.fields).toEqual({ value: '[REDACTED]', count: 31, circular: '[Circular]' });
        } finally { registry.dispose(); }
    });

    it.each([738291642, '738291642'])('projects path-bearing issues in plugin failure and log details while preserving public issues for %s', async value => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
        const privateIssues = [738291642, true, false, null, { pin: 738291642 }, [738291642]].map(suffix => ({
            path: ['value', suffix], code: 'invalid_value', message: 'Rejected 738291642',
        }));
        const publicIssue = { path: ['items', 31], code: 'public_v1', message: 'Public count 31 with true false null 1' };
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent'] }),
            handler: async (_input, context) => {
                const details = { issues: [...privateIssues, publicIssue], count: 31 };
                context.services.logger.info('Validation failed', details);
                context.services.logger.diagnostic({ code: 'validation_failed', severity: 'error', details });
                throw new PluginError({ code: 'validation_failed', message: 'Validation failed', details });
            },
        }] });
        try {
            const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value }, surface: 'agent' });
            const expected = { issues: [...privateIssues.map(() => ({ path: ['value'], code: 'invalid_value',
                message: typeof value === 'string' ? 'Rejected [REDACTED]' : 'Confidential input is invalid' })), publicIssue], count: 31 };
            expect.soft(result).toMatchObject({ status: 'failed', data: { details: expected } });
            expect.soft(records.find(record => record.fields)?.fields).toEqual(expected);
            expect.soft(records.at(-1)?.diagnostic?.details).toEqual(expected);
        } finally { registry.dispose(); }
    });

    it.each(['agent', 'mcp', 'cli'] as const)('redacts declared JSON operands from parser diagnostics and structured failures on %s', async surface => {
        const values: readonly JsonValue[] = [1, 738291642, true, false, null,
            { nested: [928374651, 'synthetic-json-secret'] }, ['synthetic-array-secret', 837264519]];
        for (const value of values) {
            const records: PluginInvocationLogRecord[] = [];
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
            for (const phase of ['parser', 'handler'] as const) {
                let started = false;
                const registry = createRegistry({ ...owners, actions: [{
                    ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent', 'mcp', 'cli'] }),
                    ...(phase === 'parser' ? { inputParser: () => ({ success: false as const,
                        issues: [{ path: typeof value === 'number' ? ['value', value] : ['value'], code: 'invalid_value', message: `Rejected operand ${JSON.stringify(value)}` },
                            { path: ['items', 31], code: 'invalid_value', message: 'Public diagnostic: true false null 1 at item 31' }] }) } : {}),
                    handler: async (_input, context) => {
                        started = true;
                        context.services.logger.info('Failed at public-endpoint', { value, count: 31 });
                        context.services.logger.diagnostic({ code: 'publish_failed', severity: 'error', details: { value, count: 31 } });
                        throw new PluginError({ code: 'publish_failed', message: 'Failed at public-endpoint', details: { value, count: 31 } });
                    },
                }] });
                try {
                    const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value }, surface });
                    expect(started).toBe(phase === 'handler');
                    expect(result).toMatchObject(phase === 'parser'
                        ? { status: 'invalid', code: 'plugin_action_input_schema_invalid' } : { status: 'failed', code: 'publish_failed' });
                    if (result.status !== 'invalid' && result.status !== 'failed') throw new Error('Expected a diagnostic result');
                    if (typeof value === 'number' && value !== 1) expect(JSON.stringify(result)).not.toContain(String(value));
                    if (phase === 'parser') {
                        expect(result.issues?.[0]?.path).toEqual(['value']);
                        expect(result.issues?.[0]?.message).not.toContain(JSON.stringify(value));
                        expect(result.issues?.[1]).toEqual({ path: ['items', 31], code: 'invalid_value', message: 'Public diagnostic: true false null 1 at item 31' });
                    }
                    if (phase === 'handler') {
                        expect(result.message).toContain('public-endpoint');
                        expect(result).toMatchObject({ data: { details: { value: '[REDACTED]', count: 31 } } });
                        expect(records.find(record => record.fields)?.fields).toEqual({ value: '[REDACTED]', count: 31 });
                        expect(records.at(-1)?.diagnostic?.details).toEqual({ value: '[REDACTED]', count: 31 });
                    }
                } finally { registry.dispose(); }
            }
        }
    });

    it.each(['agent', 'mcp', 'cli'] as const)('withholds opaque numeric result-parser diagnostics on %s', async surface => {
        const secret = 738291642;
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
        const registry = createRegistry({ ...owners, actions: [{
            ...action({ inputSchema: {}, resultSchema: {}, secretInputPaths: ['value'], surfaces: ['agent', 'mcp', 'cli'] }),
            resultParser: () => ({ success: false as const, issues: [{ path: ['value'], code: 'invalid_value', message: `Rejected ${secret}` }] }),
            handler: async () => ({ value: secret }),
        }] });
        try {
            const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: secret }, surface });
            expect(result).toMatchObject({ status: 'invalid', code: 'plugin_action_result_schema_invalid' });
            expect(JSON.stringify(result)).not.toContain(String(secret));
        } finally { registry.dispose(); }
    });

    it.each([
        { surface: 'agent', phase: 'input' }, { surface: 'mcp', phase: 'input' }, { surface: 'cli', phase: 'input' },
        { surface: 'agent', phase: 'result' }, { surface: 'mcp', phase: 'result' }, { surface: 'cli', phase: 'result' },
    ] as const)('redacts declared-secret $phase parser diagnostics on $surface', async ({ surface, phase }) => {
            const secret = 'synthetic-confidential-parser-operand';
            const publicValue = 'public-endpoint';
            let handlerStarted = false;
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} } });
            const scopes: Parameters<typeof owners.beginDiagnosticScope>[0][] = [];
            let stored: TargetActionApprovalRequestV1 | undefined;
            let settled: TargetActionApprovalRequestV1 | undefined;
            const adapter = createTargetActionCurrentIntentAdapter({
                create: async request => {
                    settled = undefined;
                    stored = StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
                    return { artifactId: `parser-${surface}` };
                },
                update: async ({ request }) => { settled = request; return { ok: true }; },
                read: async () => settled ?? (stored ? { ...stored, status: 'approved',
                    decision: { kind: 'approve', decidedAtMs: stored.updatedAtMs } } : null),
            });
            const reject = () => {
                if (phase === 'result') expect(owners.redactDiagnosticText(scopes.at(-1)!, secret)).toBe('[REDACTED]');
                return { success: false as const, issues: [{ path: ['value', secret], code: 'invalid_value',
                    message: `Rejected ${secret} at ${publicValue}` }] };
            };
            const registry = createRegistry({ ...owners,
                beginDiagnosticScope: (...args) => { scopes.push(args[0]); owners.beginDiagnosticScope(...args); },
                actions: [{ ...action({ secretInputPaths: ['value'], resultSchema: {},
                    surfaces: ['agent', 'mcp', 'cli'], dangerLevel: 'writesRemote', confirmation: { title: 'Publish' } }),
                    ...(phase === 'input' ? { inputParser: reject } : { resultParser: reject }),
                    handler: async () => { handlerStarted = true; return { response: 'invalid response' }; },
                }],
            });
            try {
                const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run',
                    input: { value: secret }, surface, requestCurrentIntent: adapter });
                expect(handlerStarted).toBe(phase === 'result');
                expect(result).toMatchObject({ status: 'invalid', code: `plugin_action_${phase}_schema_invalid` });
                expect(JSON.stringify(result)).not.toContain(secret);
                expect(JSON.stringify(result)).toContain(publicValue);
                if (phase === 'result') expect(stored?.approvalInputCustody).toBe('live_only');
                if (stored) expect(JSON.stringify(stored)).not.toContain(secret);
                for (const scope of scopes) expect(owners.redactDiagnosticText(scope, secret)).toBe(secret);
            } finally { registry.dispose(); }
    });

    it.each(['agent', 'mcp', 'cli'] as const)(
        'redacts confidential normalized input from production logs and handler failures on %s', async surface => {
            const secrets = ['synthetic-declared-release', 'synthetic-nested-release', 'synthetic-carrier-release', 'synthetic-raw-release'] as const;
            const normalized = {
                releases: [{ value: secrets[0] }],
                bundle: { nested: [secrets[1]] },
                carriers: [{ _isSecretValue: true, value: secrets[2] }],
                endpoint: 'public-release-endpoint',
            };
            const records: PluginInvocationLogRecord[] = [];
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write: record => records.push(record) },
            });
            const scopes: Parameters<typeof owners.beginDiagnosticScope>[0][] = [];
            let stored: TargetActionApprovalRequestV1 | undefined;
            let settled: TargetActionApprovalRequestV1 | undefined;
            const adapter = createTargetActionCurrentIntentAdapter({
                create: async request => {
                    settled = undefined;
                    for (const secret of secrets) {
                        expect(owners.redactDiagnosticText(scopes.at(-1)!, secret)).toBe('[REDACTED]');
                    }
                    stored = StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
                    return { artifactId: `confidential-egress-${surface}` };
                },
                update: async ({ request }) => { settled = request; return { ok: true }; },
                read: async () => settled ?? (stored ? {
                    ...stored, status: 'approved', decision: { kind: 'approve', decidedAtMs: stored.updatedAtMs },
                } : null),
            });
            for (const failure of ['error', 'pluginError'] as const) {
                let context: PluginInvocationContext | undefined;
                const registry = createRegistry({
                    ...owners,
                    beginDiagnosticScope: (...args) => { scopes.push(args[0]); owners.beginDiagnosticScope(...args); },
                    actions: [{
                        ...action({ dangerLevel: 'writesRemote', confirmation: { title: 'Publish' },
                            surfaces: ['agent', 'mcp', 'cli'], inputSchema: {},
                            secretInputPaths: ['releases.[].value', 'bundle'], resultSchema: { type: 'null' } }),
                        inputParser: () => ({ success: true, data: normalized }),
                        handler: async (input, invocationContext) => {
                            context = invocationContext;
                            expect(input).toEqual(normalized);
                            const message = `Publishing ${secrets.join(' ')} to ${normalized.endpoint}`;
                            context.services.logger.info(message, { ordinary: secrets, endpoint: normalized.endpoint });
                            context.services.logger.diagnostic({ code: 'publish_failed', severity: 'error', message, details: { ordinary: secrets } });
                            if (failure === 'error') throw new Error(message);
                            throw new PluginError({ code: 'publish_failed', message, details: { ordinary: secrets } });
                        },
                    }],
                });
                try {
                    const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run',
                        input: { value: 'before-normalization', bundle: secrets[3] }, surface, requestCurrentIntent: adapter });
                    expect(result).toMatchObject({ status: 'failed' });
                    expect(context?.invocationId).toBe(`confidential-egress-${surface}`);
                    expect(stored?.approvalInputCustody).toBe('live_only');
                    expect(records.length).toBeGreaterThan(0);
                    for (const secret of secrets) {
                        expect.soft(JSON.stringify(stored)).not.toContain(secret);
                        expect.soft(JSON.stringify(result)).not.toContain(secret);
                        expect.soft(JSON.stringify(records)).not.toContain(secret);
                    }
                    expect(JSON.stringify(result)).toContain(normalized.endpoint);
                    expect(JSON.stringify(records)).toContain(normalized.endpoint);
                    if (!context?.invocationId) throw new Error('Handler did not start with an invocation id');
                    // The incumbent scope ends after failure projection, rather than
                    // retaining raw invocation material after the result settles.
                    expect(owners.redactDiagnosticText({ pluginId: context.plugin.id, occurrenceId: '7',
                        correlationId: context.invocationId }, secrets[0]!)).toBe(secrets[0]);
                    for (const scope of scopes) expect(owners.redactDiagnosticText(scope, secrets[0]!)).toBe(secrets[0]);
                } finally { registry.dispose(); }
            }
        },
    );

    it.each(['reject', 'retire', 'abort', 'approvalError'] as const)(
        'enrolls root SecretString input before approval and releases it on %s', async outcome => {
            const secret = 'synthetic-root-carrier-release';
            const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: () => {} } });
            const scopes: Parameters<typeof owners.beginDiagnosticScope>[0][] = [];
            const controller = new AbortController();
            let enteredHandler = false;
            const registry = createRegistry({
                ...owners,
                beginDiagnosticScope: (...args) => { scopes.push(args[0]); owners.beginDiagnosticScope(...args); },
                actions: [{ ...action({ inputSchema: {}, resultSchema: { type: 'null' },
                    dangerLevel: 'writesRemote', confirmation: { title: 'Publish' } }),
                    handler: async () => { enteredHandler = true; return null; } }],
            });
            try {
                const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', surface: 'cli',
                    input: { _isSecretValue: true, value: secret }, signal: controller.signal,
                    requestCurrentIntent: async () => {
                        expect(owners.redactDiagnosticText(scopes[0]!, secret)).toBe('[REDACTED]');
                        if (outcome === 'retire') registry.dispose();
                        if (outcome === 'abort') controller.abort();
                        if (outcome === 'approvalError') throw new Error(`Approval failed for ${secret}`);
                        return { status: 'rejected', code: 'approval_rejected' };
                    },
                });
                expect(enteredHandler).toBe(false);
                expect(result.status).not.toBe('executed');
                expect(JSON.stringify(result)).not.toContain(secret);
                expect(new Set(scopes.map(scope => scope.correlationId)).size).toBe(1);
                expect(owners.redactDiagnosticText(scopes[0]!, secret)).toBe(secret);
            } finally { registry.dispose(); }
        },
    );

    it.each(['agent', 'mcp', 'cli'] as const)('keeps the real rotation token out of an approvable Artifact on %s', async surface => {
        const localId = 'rotate-document-review-webhook-token';
        const declaration = normalizePluginManifestV2(actionContractProducer.manifest).contributes.actions.find(entry => entry.id === localId);
        if (!declaration) throw new Error('Rotation example declaration missing');
        // This maintained producer must declare its credential operand; unrelated
        // undeclared strings remain literal under the declaration-only rule.
        const token = 'synthetic-r16b-fix4-rotation-value';
        const material = new Map<string, string>();
        const plugin = await createPluginTestkit({
            manifest: actionContractProducer.manifest,
            module: actionContractProducer,
            // The plugin Secrets service is a persistent host boundary; its handler stays real.
            services: { secrets: {
                async readSavedSecret() { throw new Error('Saved Secret reference reads are not provided by this fixture'); },
                async saveShared() { throw new Error('Shared save is not provided by this fixture'); },
                async status(id) { return { state: material.has(id) ? 'configured' : 'missing', revision: 'r0' }; },
                async set(id, value) { material.set(id, value); return { revision: 'r1' }; },
                async get(id) { const value = material.get(id); if (value === undefined) throw new Error('Secret missing'); return value; },
                async delete(id) { material.delete(id); return { revision: 'r2' }; },
            } },
        });
        const requests: TargetActionApprovalRequestV1[] = [];
        let settled: TargetActionApprovalRequestV1 | undefined;
        const adapter = createTargetActionCurrentIntentAdapter({
            now: () => 1,
            create: async request => {
                    settled = undefined;
                requests.push(StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))));
                return { artifactId: `confidential-rotation-${surface}` };
            },
            update: async ({ request }) => { settled = request; return { ok: true }; },
            read: async () => {
                const request = requests.at(-1);
                if (settled) return settled;
                return request ? { ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } } : null;
            },
        });
        const registry = createRegistry({ actions: [{
            pluginId: actionContractProducer.manifest.id,
            pluginVersion: actionContractProducer.manifest.version,
            occurrenceId: '7' as PluginRuntimeOccurrenceId,
            sourceCustody: createManagedPluginSourceCustody('rotation-example-generation'),
            localId,
            definition: {
                id: localId,
                dangerLevel: declaration.dangerLevel,
                scopes: declaration.scopes,
                surfaces: declaration.surfaces,
                inputSchema: declaration.inputSchema,
                resultSchema: declaration.resultSchema,
                secretInputPaths: (declaration.inputHints?.fields ?? []).filter(field => field.widget === 'secret').map(field => field.path),
            },
            handler: input => plugin.invokeAction(localId, input, { surface }),
        }] });
        try {
            await expect(registry.invoke({ pluginId: actionContractProducer.manifest.id, localId,
                input: { token }, surface, isApprovalRequiredByActionSettings: () => true,
                requestCurrentIntent: adapter })).resolves.toEqual({ status: 'executed', value: { state: 'configured', revision: 'r1' } });
            expect(material.get('document-review-webhook-token')).toBe(token);
            expect(requests).toHaveLength(1);
            expect.soft(JSON.stringify(requests)).not.toContain(token);
            expect.soft(resolveApprovalRequestApproveAdmission(requests[0]!)).toMatchObject({ status: 'available' });
            expect.soft(JSON.stringify(resolveApprovalRequestApproveAdmission(requests[0]!).presentation)).not.toContain(token);
        } finally { registry.dispose(); await plugin.dispose(); }
    });

    it.each(['agent', 'mcp', 'cli'] as const)('requires a confidential approval for a declared hidden releaseTag on %s', async surface => {
        const requests: TargetActionApprovalRequestV1[] = [];
        let executedInput: JsonValue | undefined;
        let settled: TargetActionApprovalRequestV1 | undefined;
        const adapter = createTargetActionCurrentIntentAdapter({
            now: () => 1,
            create: async request => {
                    settled = undefined;
                requests.push(StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))));
                return { artifactId: `confidential-release-${surface}` };
            },
            update: async ({ request }) => { settled = request; return { ok: true }; },
            read: async () => {
                const request = requests.at(-1);
                if (settled) return settled;
                return request ? { ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } } : null;
            },
        });
        const input = { releaseTag: 'synthetic-confidential-release', benign: 'public-endpoint' };
        const registry = createRegistry({ actions: [{
            ...action({ dangerLevel: 'writesRemote', confirmation: { title: 'Publish' }, surfaces: ['agent', 'mcp', 'cli'],
                inputSchema: { type: 'object', properties: { releaseTag: { type: 'string' }, benign: { type: 'string' } },
                    required: ['releaseTag', 'benign'], additionalProperties: false },
                secretInputPaths: ['releaseTag'], resultSchema: { type: 'null' } }),
            handler: async value => { executedInput = value; return null; },
        }] });
        try {
            const result = await registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input, surface, requestCurrentIntent: adapter });
            expect.soft(result).toEqual({ status: 'executed', value: null });
            expect.soft(executedInput).toEqual(input);
            expect.soft(requests).toHaveLength(1);
            if (requests.length) {
                expect(JSON.stringify(requests)).not.toContain(input.releaseTag);
                const admission = resolveApprovalRequestApproveAdmission(requests[0]!);
                expect(admission).toMatchObject({ status: 'available' });
                expect(JSON.stringify(admission.presentation)).toContain(input.benign);
            }
        } finally { registry.dispose(); }
    });

    it.each(['agent', 'mcp', 'cli', 'ui'] as const)('preserves the public Triage credential binding through approval on %s', async surface => {
        const requests: TargetActionApprovalRequestV1[] = [];
        let applied: JsonValue | undefined;
        const adapter = createTargetActionCurrentIntentAdapter({
            now: () => 1,
            create: async request => { requests.push(StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)))); return { artifactId: `triage-${surface}` }; },
            read: async () => {
                const request = requests.at(-1);
                return request ? { ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 } } : null;
            },
        });
        const declaration = action({ dangerLevel: 'writesLocal', confirmation: { title: 'Start session' },
            surfaces: ['ui', 'agent', 'mcp', 'cli'], inputSchema: TriageStartEntrySessionInputV1Schema.jsonSchema,
            resultSchema: { type: 'null' } });
        const registry = createRegistry({ actions: [{ ...declaration, pluginId: 'happier.triage', localId: TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
            definition: { ...declaration.definition, id: TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 },
            handler: async input => { applied = input; return null; } },
        ] });
        try {
            const input = createTriageSelectedPrStartApprovalInput();
            const result = await registry.invoke({ pluginId: 'happier.triage', localId: TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
                input, surface, requestCurrentIntent: adapter });
            if (surface === 'ui') {
                // UI admission requires its carried present-user confirmation;
                // a durable Artifact by itself cannot authorize the handler.
                expect(result).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable', actionHandlerInvocation: 'notStarted' });
            } else {
                expect(result).toEqual({ status: 'deferred', artifactId: `triage-${surface}` });
            }
            expect(applied).toBeUndefined();
            expect(requests).toHaveLength(1);
            expect(requests[0]!.input).toEqual(input);
            expect(requests[0]!.approvalInputCustody).toBeUndefined();
            expect(resolveApprovalRequestApproveAdmission(requests[0]!)).toMatchObject({ status: 'available' });
            expect(JSON.stringify(resolveApprovalRequestApproveAdmission(requests[0]!).presentation)).toContain('account-1');
            const approved = requests[0]!;
            await expect(registry.invoke({
                pluginId: 'happier.triage', localId: TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
                input: approved.input, surface, requireCurrentIntent: true,
                requestCurrentIntent: async request => targetActionApprovalMatchesCurrentIntent(approved, request)
                    ? { status: 'approved', fingerprint: request.fingerprint, artifactId: `triage-${surface}` }
                    : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' },
            })).resolves.toEqual({ status: 'executed', value: null });
            expect(applied).toEqual(input);
        } finally { registry.dispose(); }
    });

    it.each(['version', 'input declaration', 'unchanged'] as const)(
        'binds deferred development approval across restarted occurrences: %s', async change => {
            let stored: TargetActionApprovalRequestV1 | undefined;
            let appliedVersion: string | undefined;
            const declaration = action({ dangerLevel: 'writesRemote', confirmation: { title: 'Publish' } });
            const sourceCustody = { kind: 'development', registeredRootId: 'alpha-root' } as const;
            const occurrenceId = 'acme.alpha:1' as PluginRuntimeOccurrenceId;
            const replayPlacement = { serverId: 'server-1', machineId: 'machine-1' };
            const executionOriginV1 = {
                v: 1, authority: 'account_automation', surface: 'api', caller: { kind: 'host' },
                serverId: 'server-1', machineId: 'machine-1', accountId: 'account-1',
                principalId: 'principal-1', credentialId: 'credential-1',
                actionId: 'action.invoke', requestId: 'request-development-replay',
            } as const;
            const adapter = createTargetActionCurrentIntentAdapter({
                now: () => 1,
                create: async request => {
                    stored = StoredTargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
                    return { artifactId: 'approval-development-replay' };
                },
                read: async () => stored ?? null,
            });
            const first = createRegistry({ actions: [{
                ...declaration, pluginVersion: '1.0.0', sourceCustody, occurrenceId,
                handler: async () => { throw new Error('Deferred handler must not start'); },
            }] });
            try {
                await expect(first.invoke({
                    pluginId: 'acme.alpha', localId: 'run', input: { value: 'approved' },
                    surface: 'cli', invocationSurface: 'api', replayPlacement,
                    requestCurrentIntent: request => adapter({ ...request, executionOriginV1 }),
                })).resolves.toEqual({ status: 'deferred', artifactId: 'approval-development-replay' });
            } finally { first.dispose(); }
            if (!stored) throw new Error('Approval was not saved');
            const saved = stored;
            const version = change === 'version' ? '2.0.0' : '1.0.0';
            const successor = createRegistry({ actions: [{
                ...declaration, pluginVersion: version, sourceCustody, occurrenceId,
                definition: {
                    ...declaration.definition,
                    // Both declarations accept the saved JSON; validation alone cannot bind intent.
                    inputSchema: change === 'input declaration'
                        ? { ...declaration.definition.inputSchema, properties: { value: { type: 'string', enum: ['approved'] } } }
                        : declaration.definition.inputSchema,
                },
                inputParser: () => { throw new Error('Replay must not reparse normalized input'); },
                handler: async () => { appliedVersion = version; return { echoed: version }; },
            }] });
            try {
                const result = await successor.invoke({
                    pluginId: 'acme.alpha', localId: 'run', input: saved.input,
                    surface: 'cli', invocationSurface: 'api', replayPlacement, requireCurrentIntent: true,
                    requestCurrentIntent: async request => targetActionApprovalMatchesCurrentIntent(saved, { ...request, executionOriginV1 })
                        ? { status: 'approved', fingerprint: request.fingerprint, artifactId: 'approval-development-replay' }
                        : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' },
                });
                if (change === 'unchanged') {
                    expect(result).toEqual({ status: 'executed', value: { echoed: '1.0.0' } });
                    expect(appliedVersion).toBe('1.0.0');
                } else {
                    expect(result).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch', actionHandlerInvocation: 'notStarted' });
                    expect(appliedVersion).toBeUndefined();
                }
            } finally { successor.dispose(); }
        },
    );

    it('replays the normalized API approval input without transforming it again', async () => {
        let saved: TargetActionCurrentIntentRequest | undefined;
        let applied: unknown;
        const registry = createRegistry({ actions: [{
            ...action({ dangerLevel: 'writesRemote', confirmation: { title: 'Publish' } }),
            inputParser: input => ({ success: true, data: { value: `${Reflect.get(input as object, 'value')}-normalized` } }),
            handler: async input => { applied = input; return { echoed: String(Reflect.get(input as object, 'value')) }; },
        }] });
        try {
            await expect(registry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: { value: 'approved' }, surface: 'cli', invocationSurface: 'api',
                requestCurrentIntent: async request => { saved = request; return { status: 'deferred', artifactId: 'approval-api-normalized' }; },
            })).resolves.toEqual({ status: 'deferred', artifactId: 'approval-api-normalized' });
            expect(saved?.action.input).toEqual({ value: 'approved-normalized' });
            expect(applied).toBeUndefined();
            const approved = saved!;
            await expect(registry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: approved.action.input, surface: 'cli', invocationSurface: 'api',
                requireCurrentIntent: true,
                requestCurrentIntent: async request => request.fingerprint === approved.fingerprint
                    ? { status: 'approved', fingerprint: request.fingerprint, artifactId: 'approval-api-normalized' }
                    : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' },
            })).resolves.toEqual({ status: 'executed', value: { echoed: 'approved-normalized' } });
            expect(applied).toEqual(approved.action.input);
        } finally { registry.dispose(); }
    });

    it('exposes the existing host correlation identity and distinguishes independent Actions', async () => {
        const contexts: PluginInvocationContext[] = [];
        const correlations: string[] = [];
        const services = createUnavailablePluginServicesFactory();
        const registry = createRegistry({
            createServices: (seed, binding) => {
                correlations.push(seed.correlationId);
                return services(seed, binding);
            },
            actions: [{ ...action(), handler: async (_input, context) => {
                contexts.push(context);
                return { echoed: 'executed' };
            } }],
        });
        try {
            const results = await Promise.all(['session-first', 'session-second'].map(sessionId => registry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
                sessionId,
            })));
            expect(results).toMatchObject([{ status: 'executed' }, { status: 'executed' }]);
            expect(contexts.map(context => context.invocationId)).toEqual(correlations);
            expect(contexts.map(context => context.session?.id)).toEqual(['session-first', 'session-second']);
            expect(contexts[0]!.invocationId).toBeTruthy();
            expect(contexts[1]!.invocationId).not.toBe(contexts[0]!.invocationId);
        } finally {
            registry.dispose();
        }
    });

    it('executes a waived dangerous agent Action without a present-user requester', async () => {
        const registry = createRegistry({ actions: [{
            ...action({ dangerLevel: 'destructive', surfaces: ['agent'], confirmation: { title: 'Delete' } }),
            handler: async () => ({ echoed: 'executed' }),
        }] });
        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'agent',
            isApprovalRequiredByActionSettings: () => false,
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'executed' } });
        registry.dispose();
    });

    it('fails closed even for a safe Action when its settings read throws', async () => {
        const registry = createRegistry({ actions: [{
            ...action({ dangerLevel: 'safe', surfaces: ['agent'] }),
            handler: async () => ({ echoed: 'must-not-run' }),
        }] });
        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'agent',
            isApprovalRequiredByActionSettings: () => { throw new Error('settings unreadable'); },
        })).resolves.toMatchObject({ status: 'unavailable', actionHandlerInvocation: 'notStarted' });
        registry.dispose();
    });
    it('keeps a prepared handler inert when retirement occurs during host custody admission', async () => {
        const handler = vi.fn(async () => ({ echoed: 'value' }));
        let transitions = 0;
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const prepared = await registry.prepare({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'value' }, surface: 'cli',
            beforeHandlerInvocation: async () => {
                transitions += 1;
                registry.dispose();
            },
        });
        expect(prepared.kind).toBe('ready');
        expect(transitions).toBe(0);
        if (prepared.kind !== 'ready') throw new Error('Expected prepared invocation');
        await expect(prepared.run()).resolves.toMatchObject({ actionHandlerInvocation: 'notStarted' });
        expect(transitions).toBe(1);
        expect(handler).not.toHaveBeenCalled();
    });

    it('passes one executable-parser-normalized input to host admission and the handler', async () => {
        const inputParser = vi.fn((input: unknown) => Object.freeze({
            success: true as const,
            data: Object.freeze({
                value: String((input as Readonly<Record<string, unknown>>).value),
            }),
        }));
        const revalidateActionFormInput = vi.fn(async () => null);
        const handler = vi.fn(async (input: JsonValue) => {
            const record = isJsonRecord(input) ? input : {};
            return { echoed: String(record.value) };
        });
        const registry = createRegistry({
            revalidateActionFormInput,
            actions: [{
                ...action({
                    inputSchema: {
                        type: 'object',
                        properties: { value: { type: 'string' } },
                        required: ['value'],
                        additionalProperties: true,
                    },
                }),
                inputParser,
                handler,
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'normalized', ignored: true },
            surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'normalized' } });

        expect(inputParser).toHaveBeenCalledOnce();
        expect(revalidateActionFormInput).toHaveBeenCalledWith(expect.objectContaining({
            input: { value: 'normalized' },
        }));
        expect(handler).toHaveBeenCalledWith(
            { value: 'normalized' },
            expect.any(Object),
        );
        registry.dispose();
    });

    it('stamps one stable host clock value on the admitted Action context', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_777_777_777_777);
        const handler = vi.fn(async (_input, context: PluginInvocationContext) => ({
            first: context.invokedAtMs,
            second: context.invokedAtMs,
        }));
        const registry = createRegistry({ actions: [{
            ...action({
                resultSchema: {
                    type: 'object',
                    properties: {
                        first: { type: 'number' },
                        second: { type: 'number' },
                    },
                    required: ['first', 'second'],
                    additionalProperties: false,
                },
            }),
            handler,
        }] });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toEqual({
            status: 'executed',
            value: { first: 1_777_777_777_777, second: 1_777_777_777_777 },
        });
        now.mockRestore();
    });

    it('requires current intent before a safe handler when the host stamps Action-settings approval', async () => {
        const handler = vi.fn(async () => ({ echoed: 'approved' }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        let approve: ((value: Readonly<{ status: 'approved'; fingerprint: string }>) => void) | undefined;
        const requestCurrentIntent = vi.fn(async (request: TargetActionCurrentIntentRequest) => await new Promise<Readonly<{
            status: 'approved'; fingerprint: string;
        }>>((resolve) => {
            approve = (value) => resolve(value);
        }));

        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
            isApprovalRequiredByActionSettings: () => true,
            requestCurrentIntent,
        });

        await vi.waitFor(() => expect(requestCurrentIntent).toHaveBeenCalledOnce());
        expect(handler).not.toHaveBeenCalled();
        const request = requestCurrentIntent.mock.calls[0]?.[0];
        if (!request || !approve) throw new Error('Expected host Action-settings approval request');
        approve({ status: 'approved', fingerprint: request.fingerprint });

        await expect(invocation).resolves.toEqual({ status: 'executed', value: { echoed: 'approved' } });
        expect(handler).toHaveBeenCalledOnce();
    });

    it('rechecks host Action-settings enablement immediately before the handler', async () => {
        const handler = vi.fn(async () => ({ echoed: 'should-not-run' }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
            isEnabledByActionSettings: () => false,
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_unavailable',
            actionHandlerInvocation: 'notStarted',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('prepares without entering the handler and runs the exact admitted handler once with progress', async () => {
        const handler = vi.fn(async (_input, context: PluginInvocationContext) => {
            context.operation?.update({ phase: 'publishing', label: 'Publishing' });
            return { echoed: 'ready' };
        });
        const registry = createRegistry({
            actions: [{
                ...action({
                    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
                }),
                handler,
            }],
        });

        const prepared = await registry.prepare({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
        });
        expect(prepared.kind).toBe('ready');
        expect(handler).not.toHaveBeenCalled();
        if (prepared.kind !== 'ready') throw new Error('expected ready target action');
        const update = vi.fn();
        const first = prepared.run({ operationProgress: { update } });
        const second = prepared.run({ operationProgress: { update } });

        await expect(Promise.all([first, second])).resolves.toEqual([
            { status: 'executed', value: { echoed: 'ready' } },
            { status: 'executed', value: { echoed: 'ready' } },
        ]);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith({ phase: 'publishing', label: 'Publishing' });
    });

    it('reports validated tracked daemon Action progress through the host port', async () => {
        const updates: unknown[] = [];
        let retainedOperation: PluginInvocationContext['operation'];
        const registry = createRegistry({
            actions: [{
                ...action({
                    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
                }),
                handler: async (_input, context) => {
                    retainedOperation = context.operation;
                    expect(context.operation).toBeDefined();
                    expect(Object.keys(context.operation ?? {})).toEqual(['update']);
                    context.operation?.update({ phase: 'indexing', label: 'Indexing files' });
                    context.operation?.update({ current: 2, total: 4, label: 'Halfway' });
                    expect(() => context.operation?.update({ current: 5, total: 4 })).toThrow();
                    return { echoed: 'tracked' };
                },
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
            operationProgress: {
                update: (progress) => updates.push(progress),
            },
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'tracked' } });

        retainedOperation?.update({ label: 'late' });
        expect(updates).toEqual([
            { phase: 'indexing', label: 'Indexing files' },
            { current: 2, total: 4, label: 'Halfway' },
        ]);
    });

    it('withholds the reporter for untracked Actions and returns tracked handler failures to the host', async () => {
        const untrackedUpdate = vi.fn();
        const untracked = createRegistry({
            actions: [{
                ...action(),
                handler: async (_input, context) => {
                    expect(context.operation).toBeUndefined();
                    return { echoed: 'untracked' };
                },
            }],
        });
        await expect(untracked.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
            operationProgress: {
                update: untrackedUpdate,
            },
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'untracked' } });
        expect(untrackedUpdate).not.toHaveBeenCalled();

        const tracked = createRegistry({
            actions: [{
                ...action({
                    operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
                }),
                handler: async () => {
                    throw new PluginError({ code: 'tracked_failed', message: 'Tracked failed' });
                },
            }],
        });
        await expect(tracked.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
            operationProgress: {
                update: vi.fn(),
            },
        })).resolves.toMatchObject({ status: 'failed', code: 'tracked_failed' });
    });

    it('binds one Connected Account operation to the target correlation and disposes it at settlement', async () => {
        const dispose = vi.fn();
        let operationInput: Readonly<{
            correlationId: string;
            isCurrent(): boolean;
        }> | undefined;
        const bindConnectedAccountActionOperation = vi.fn(async (input: Readonly<{
            correlationId: string;
            isCurrent(): boolean;
        }>) => {
            operationInput = input;
            return Object.freeze({
                exactPurposeBindingSubjectId: `operation:${input.correlationId}`,
                dispose,
            });
        });
        const createServices = vi.fn(createUnavailablePluginServicesFactory());
        const handler = vi.fn(async () => {
            expect(operationInput?.isCurrent()).toBe(true);
            return { echoed: 'bound' };
        });
        const registry = createRegistry({
            createServices,
            bindConnectedAccountActionOperation,
            actions: [{ ...action(), handler }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'bound' } });

        expect(bindConnectedAccountActionOperation).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            correlationId: expect.any(String),
        }));
        expect(createServices).toHaveBeenCalledWith(expect.objectContaining({
            correlationId: operationInput?.correlationId,
        }), expect.objectContaining({
            exactPurposeBindingSubjectId: `operation:${operationInput?.correlationId}`,
        }));
        expect(handler).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(operationInput?.isCurrent()).toBe(false);
    });

    it('refuses an admitted target occurrence that retired before the handler check', async () => {
        const handler = vi.fn(async () => ({ echoed: 'should-not-run' }));
        const registry = createRegistry({
            actions: [{ ...action(), handler }],
            readCurrentPluginOccurrenceId: (pluginId) => (
                pluginId === 'acme.target'
                    ? 'target-occurrence-h'
                    : pluginId === 'acme.alpha' ? '7' : null
            ),
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
            caller: {
                kind: 'plugin',
                pluginId: 'acme.target',
                contribution: {
                    id: 'request',
                    qualifiedId: 'acme.target/actions/request',
                },
                occurrenceId: 'acme-target-generation-1',
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'acme-target-generation-1',
                    installSource: 'archive',
                },
                materialization: {
                    pluginId: 'acme.target',
                    machineId: 'machine-target',
                    materializationId: 'target-materialization-g',
                },
            },
            expectedAdmittedTargetOccurrence: {
                pluginId: 'acme.target',
                occurrenceId: 'target-occurrence-g',
            },
        })).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_generation_retired',
            actionHandlerInvocation: 'notStarted',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('binds context.ui to the validated active session presentation even when public session inventory is unavailable', async () => {
        const notify = vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' }));
        const presentation = {
            notify,
            setStatus: vi.fn(),
            setWidget: vi.fn(),
            purgeOwner: vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' })),
            replaceComposerText: vi.fn(),
            present: vi.fn(),
        };
        const registry = createRegistry({
            resolveCurrentSessionUi: (sessionId) => sessionId === 'session-1'
                ? Object.freeze({
                    interactions: Object.freeze({
                        request: vi.fn() as HostCurrentSessionInteractionsService['request'],
                    }),
                    presentation,
                })
                : null,
            actions: [{
                ...action(),
                handler: async (_input, context) => {
                    if (!context.ui) throw new Error('expected current-session UI');
                    await context.ui.notify('Hello');
                    return { echoed: context.session?.id ?? '' };
                },
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', sessionId: 'session-1',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'session-1' } });
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'Hello' }), expect.any(Object));
        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', sessionId: 'wrong-session',
        })).resolves.toMatchObject({ status: 'failed', code: 'plugin_ui_unavailable' });
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('stamps transient presentation rows from the exact target-action invocation and retires only that owner', async () => {
        const setStatus = vi.fn<HostCurrentSessionPresentationService['setStatus']>(async () => (
            { status: 'applied' as const, revision: 'r1' }
        ));
        const purgeOwner = vi.fn(async () => ({ status: 'applied' as const, revision: 'r2' }));
        const presentation = Object.freeze({
            notify: vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' })),
            setStatus,
            setWidget: vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' })),
            purgeOwner,
            replaceComposerText: vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' })),
            present: vi.fn(async () => ({ status: 'applied' as const, revision: 'r1' })),
        });
        const currentSessionUi = createNativeAgentCurrentSessionUiServices({
            permissionHandler: null,
            pluginId: 'acme.alpha',
            contributionId: 'run',
            runtimeId: 'run',
            sessionId: 'session-1',
            occurrenceId: 'occurrence-7',
            presentation,
        });
        const registry = createRegistry({
            resolveCurrentSessionUi: (sessionId) => sessionId === 'session-1'
                ? currentSessionUi
                : null,
            actions: [{
                ...action(),
                occurrenceId: 'occurrence-alpha' as PluginRuntimeOccurrenceId,
                sourceCustody: {
                    kind: 'managed',
                    immutableGenerationId: 'immutable-generation-alpha',
                    installSource: 'archive',
                },
                handler: async (_input, context) => {
                    if (!context.ui) throw new Error('expected current-session UI');
                    await context.ui.status.set('progress', 'Running');
                    return { echoed: context.session?.id ?? '' };
                },
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
            sessionId: 'session-1',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'session-1' } });

        const statusRequest = setStatus.mock.calls[0]?.[0];
        if (!statusRequest) throw new Error('Expected a status presentation request');
        expect(statusRequest.owner).toMatchObject({
            pluginId: 'acme.alpha',
            contributionId: 'run',
            generationId: 'immutable-generation-alpha',
            invocationId: expect.any(String),
        });
        await vi.waitFor(() => {
            expect(purgeOwner).toHaveBeenCalledWith(expect.objectContaining({
                owner: statusRequest.owner,
            }));
        });
    });

    it('binds target-action services and context.ui to the same validated current-session interaction owner', async () => {
        // Only the Session state/transport boundary is in memory; policy and reply parsing stay real.
        const session = createMutableApiSessionClientFixture({ sessionId: 'session-1' });
        const permissionHandler = createProviderEnforcedPermissionHandler({
            session, logPrefix: '[Target action interaction]', getWorkspaceWrites: () => 'allow',
        });
        const currentSession = createNativeAgentCurrentSessionUiServices({
            permissionHandler,
            pluginId: 'acme.alpha',
            contributionId: 'run',
            runtimeId: 'run',
            sessionId: 'session-1',
            occurrenceId: 'occurrence-7',
            interactionDeadlineMs: 1_000,
            isCurrent: () => true,
            signal: new AbortController().signal,
        });
        const serviceOwners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
        });
        const registry = createRegistry({
            createServices: serviceOwners.createServices,
            resolveHostBinding: serviceOwners.resolveHostBinding,
            resolveCurrentSessionUi: (sessionId) => (
                sessionId === 'session-1' ? currentSession : null
            ),
            actions: [{
                ...action(),
                handler: async (_input, context) => ({
                    echoed: (await context.services.interactions.confirm({
                        kind: 'confirmation',
                        message: 'Use the selected account?',
                    })).status,
                }),
            }],
        });

        try {
            const pending = registry.invoke({
                pluginId: 'acme.alpha',
                localId: 'run',
                input: { value: 'x' },
                surface: 'cli',
                sessionId: 'session-1',
            });
            await vi.waitFor(() => expect(Object.keys(session.__getAgentState().requests ?? {})).toHaveLength(1));
            const [[id, request]] = Object.entries(session.__getAgentState().requests ?? {});
            expect(request).toMatchObject({
                kind: 'user_action', tool: 'AskUserQuestion',
                arguments: { questions: [expect.objectContaining({
                    id: 'confirmation', question: 'Use the selected account?',
                })] },
            });
            await expect(session.rpcHandlerManager.invokeLocal('session.user_action.answer', {
                id, approved: true, answers: { confirmation: ['confirm'] },
            })).resolves.toBeUndefined();
            await expect(pending).resolves.toEqual({ status: 'executed', value: { echoed: 'approved' } });
            expect(Object.keys(session.__getAgentState().requests ?? {})).toHaveLength(0);
            expect(Object.keys(session.__getAgentState().completedRequests ?? {})).toHaveLength(1);
        } finally {
            await permissionHandler.abortPendingRequestsAndFlush('test cleanup');
            await serviceOwners.dispose();
            await session.close();
        }
    });

    it('fails closed when late-bound occurrence currentness no longer matches the registered action', async () => {
        const handler = vi.fn(async () => ({ echoed: 'should-not-run' }));
        const registry = createRegistry({
            resolveAuthorizationFacts: (resolvedAction) => ({
                generation: {
                    targetGeneration: resolvedAction.occurrenceId,
                    desiredGeneration: null,
                    appliedGeneration: resolvedAction.occurrenceId,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            actions: [{ ...action(), handler }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_generation_retired' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('applies enum and const schemas to JSON objects with own valueOf data properties', async () => {
        const handler = vi.fn(async () => ({ valueOf: 'result', nested: [{ accepted: true }], amount: 4 }));
        const registry = createRegistry({
            actions: [{
                ...action({
                    inputSchema: {
                        type: 'object',
                        required: ['selection'],
                        properties: {
                            selection: { const: { valueOf: 'literal', nested: [{ enabled: true }], amount: 4 } },
                        },
                        additionalProperties: false,
                    },
                    resultSchema: {
                        enum: [{ valueOf: 'result', nested: [{ accepted: true }], amount: 4 }],
                    },
                }),
                handler,
            }],
        });

        const result = await registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { selection: { amount: 4, nested: [{ enabled: true }], valueOf: 'literal' } },
            surface: 'cli',
        });

        expect(result).toEqual({
            status: 'executed',
            value: { valueOf: 'result', nested: [{ accepted: true }], amount: 4 },
        });
        expect(handler).toHaveBeenCalledOnce();
    });

  it('constructs one immutable qualified context with all services and truthful unavailable errors', async () => {
    let captured: unknown;
    const createServices = vi.fn(createUnavailablePluginServicesFactory());
    const registry = createRegistry({
            createServices,
            actions: [{
                ...action(),
                handler: async (input, context) => {
                    captured = context;
                    expect(Object.keys(context.services).sort()).toEqual([
                        'actions', 'availability', 'backgroundServices', 'composerContent', 'connectedAccounts', 'events', 'exec', 'fs', 'http',
                        'interactions', 'logger', 'machineProvisioners', 'managedServices', 'mcp', 'notifications', 'providers', 'resources', 'secrets', 'sessions',
                        'settings', 'storage',
                        'targetedContributions',
                    ]);
                    expect(context.services.availability('logger')).toEqual({
                        status: 'unavailable',
                        code: 'plugin_service_unavailable',
                    });
                    expect(context.services.availability('storage')).toEqual({
                        status: 'unavailable',
                        code: 'plugin_service_unavailable',
                    });
                    expect(() => context.services.storage.daemon.get('x')).toThrowError(PluginError);
                    expect(() => context.services.logger.info('not admitted')).toThrowError(PluginError);
                    await expect(context.services.interactions.confirm({
                        kind: 'confirmation',
                        message: 'Proceed?',
                    })).resolves.toMatchObject({
                        kind: 'confirmation',
                        status: 'unavailable',
                    });
                    const serviceShape = {
                        logger: ['debug', 'diagnostic', 'error', 'info', 'warn'],
                        backgroundServices: ['demand'],
                        storage: ['ephemeral', 'daemonSession', 'daemon'],
                        settings: ['forScope'],
                        secrets: ['delete', 'get', 'set', 'status'],
                        events: ['host', 'plugin'],
                        http: ['openWebSocket', 'request'],
                        fs: ['list', 'readFile', 'remove', 'stat', 'writeFile'],
                        exec: ['agentCli', 'clients', 'run', 'spawn', 'systemTools'],
                        machineProvisioners: ['materializeBootstrapCredential', 'withBootstrapCredentialFile'],
                        managedServices: ['dependencies', 'supervise'],
                        sessions: ['current', 'external', 'get', 'list', 'subagents', 'watch'],
                        resources: ['describe', 'read', 'watch'],
                        mcp: ['connect', 'discover', 'list'],
                        notifications: ['listCategories', 'listChannels', 'preferences', 'send', 'watchPreferences'],
                        connectedAccounts: [
                            'getBinding',
                            'listAccounts',
                            'materialize',
                            'materializeListedAccount',
                            'requestSelection',
                            'watch',
                        ],
                        composerContent: ['capabilities', 'stageMedia'],
                        targetedContributions: ['observeForSelf'],
                    } as const;
                    for (const [serviceId, expectedKeys] of Object.entries(serviceShape)) {
                        const service = Reflect.get(context.services, serviceId) as object;
                        expect(Object.keys(service).sort(), serviceId).toEqual([...expectedKeys].sort());
                        expect(Object.isFrozen(service), serviceId).toBe(true);
                        const assertUnavailableLeaves = async (value: Readonly<Record<string, unknown>>, path: string): Promise<void> => {
                            for (const [key, member] of Object.entries(value)) {
                                const memberPath = `${path}.${key}`;
                                if (typeof member === 'function') {
                                    if (memberPath === 'composerContent.capabilities') {
                                        expect(member()).toEqual({
                                            [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: {
                                                status: 'unavailable',
                                                code: 'plugin_service_unavailable',
                                            },
                                        });
                                        continue;
                                    }
                                    if (memberPath === 'sessions.external.capabilities') {
                                        await expect(member()).resolves.toEqual({
                                            list: { status: 'unavailable', code: 'plugin_service_unavailable' },
                                            attach: { status: 'unavailable', code: 'plugin_service_unavailable' },
                                            takeover: { status: 'unavailable', code: 'plugin_service_unavailable' },
                                            transcript: { status: 'unavailable', code: 'plugin_service_unavailable' },
                                            follow: { status: 'unavailable', code: 'plugin_service_unavailable' },
                                        });
                                        continue;
                                    }
                                    if (memberPath === 'sessions.external.followTranscript') {
                                        await expect(member()).resolves.toEqual({
                                            status: 'unavailable',
                                            code: 'plugin_service_unavailable',
                                        });
                                        continue;
                                    }
                                    try {
                                        const returned = member();
                                        if (returned instanceof Promise) {
                                            await expect(returned, memberPath).rejects.toMatchObject({
                                                name: 'PluginError',
                                                code: serviceId === 'managedServices'
                                                    ? 'plugin_managed_service_unavailable'
                                                    : 'plugin_service_unavailable',
                                            });
                                            continue;
                                        }
                                        throw new Error(`${memberPath} returned instead of throwing`);
                                    } catch (error) {
                                        expect(error, memberPath).toBeInstanceOf(PluginError);
                                        expect(error, memberPath).toMatchObject({
                                            code: serviceId === 'managedServices'
                                                ? 'plugin_managed_service_unavailable'
                                                : 'plugin_service_unavailable',
                                        });
                                    }
                                    continue;
                                }
                                if (member === null) {
                                    expect(memberPath).toBe('sessions.current');
                                    continue;
                                }
                                expect(member && typeof member === 'object', memberPath).toBe(true);
                                expect(Object.isFrozen(member), memberPath).toBe(true);
                                await assertUnavailableLeaves(member as Readonly<Record<string, unknown>>, memberPath);
                            }
                        };
                        if (serviceId === 'settings') {
                            const scoped = context.services.settings.forScope({ kind: 'daemon' });
                            expect(Object.keys(scoped).sort()).toEqual([
                                'describe', 'get', 'reset', 'set', 'snapshot', 'watch',
                            ]);
                            expect(Object.isFrozen(scoped)).toBe(true);
                            await assertUnavailableLeaves(
                                scoped as unknown as Readonly<Record<string, unknown>>,
                                'settings.forScope',
                            );
                            continue;
                        }
                        await assertUnavailableLeaves(service as unknown as Readonly<Record<string, unknown>>, serviceId);
                    }
                    expect(Object.keys(context.services.storage.daemon).sort()).toEqual([
                        'consistency', 'database', 'delete', 'get', 'list', 'set', 'transaction',
                    ]);
                    expect(Object.keys(context.services.exec.clients)).toEqual(['spawn']);
                    const managedServices = Reflect.get(context.services, 'managedServices') as Readonly<{
                        dependencies: object;
                    }>;
                    expect(Object.keys(managedServices.dependencies).sort()).toEqual(['ensure', 'remove', 'status', 'update']);
                    expect(context.services.sessions.current).toBeNull();
                    expect(Object.keys(context.services.sessions.subagents).sort()).toEqual([
                        'get', 'list', 'watch',
                    ]);
                    try {
                        await context.services.storage.daemon.get('x');
                    } catch (error) {
                        expect(error).toMatchObject({ code: 'plugin_service_unavailable' });
                    }
                    if (!isJsonRecord(input) || typeof input.value !== 'string') {
                        throw new Error('validated action input was not preserved');
                    }
                    return { echoed: input.value };
                },
            }],
        });

        const result = await registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'hello' },
            surface: 'cli',
        });

        expect(result).toEqual({ status: 'executed', value: { echoed: 'hello' } });
        expect(captured).toMatchObject({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: 'acme.alpha/actions/run' },
            surface: 'cli',
        });
        expect(createServices).toHaveBeenCalledWith(
            expect.objectContaining({
                plugin: { id: 'acme.alpha', version: '1.2.3' },
                contribution: { id: 'run', qualifiedId: 'acme.alpha/actions/run' },
                occurrenceId: '7',
                correlationId: expect.any(String),
                surface: 'cli',
                isOccurrenceCurrent: expect.any(Function),
            }),
            expect.objectContaining({ occurrenceId: '7' }),
        );
        expect(Object.isFrozen(captured)).toBe(true);
    });

    it('isolates equal local ids by plugin and rejects wrong family or generation publication', async () => {
        const alpha = vi.fn(async () => ({ echoed: 'alpha' }));
        const beta = vi.fn(async () => ({ echoed: 'beta' }));
        const registry = createRegistry({
            actions: [
                { ...action(), handler: alpha },
                { ...action(), pluginId: 'acme.beta', handler: beta },
            ],
        });

        await expect(registry.invoke({ pluginId: 'acme.beta', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toEqual({ status: 'executed', value: { echoed: 'beta' } });
        expect(alpha).not.toHaveBeenCalled();
        expect(() => createRegistry({
            actions: [{ ...action(), family: 'hooks', handler: alpha }],
        })).toThrow(/family/i);
        expect(() => createRegistry({
            actions: [{ ...action(), localId: 'other', handler: alpha }],
        })).toThrow(/does not match/i);
        expect(() => createRegistry({
            actions: [{ ...action(), handler: alpha }, { ...action(), handler: alpha }],
        })).toThrow(/duplicate/i);
    });

    it('keeps another plugin callable after one handler throws, rejects, or is caller-timed-out', async () => {
        let failure: 'throw' | 'reject' | 'timeout' = 'throw';
        const alpha = vi.fn((_input, context) => {
            if (failure === 'throw') throw new Error('alpha threw');
            if (failure === 'reject') return Promise.reject(new Error('alpha rejected'));
            return new Promise<never>((_resolve, reject) => {
                context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
            });
        });
        const beta = vi.fn(async () => ({ echoed: 'beta healthy' }));
        const registry = createRegistry({
            actions: [
                { ...action(), handler: alpha },
                { ...action(), pluginId: 'acme.beta', handler: beta },
            ],
        });
        const invokeAlpha = (signal?: AbortSignal) => registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: failure },
            surface: 'cli',
            ...(signal ? { signal } : {}),
        });
        const expectBetaHealthy = async () => {
            await expect(registry.invoke({
                pluginId: 'acme.beta',
                localId: 'run',
                input: { value: 'still healthy' },
                surface: 'cli',
            })).resolves.toEqual({ status: 'executed', value: { echoed: 'beta healthy' } });
        };

        await expect(invokeAlpha()).resolves.toMatchObject({
            status: 'failed',
            code: 'plugin_action_execution_failed',
        });
        await expectBetaHealthy();

        failure = 'reject';
        await expect(invokeAlpha()).resolves.toMatchObject({
            status: 'failed',
            code: 'plugin_action_execution_failed',
        });
        await expectBetaHealthy();

        failure = 'timeout';
        const timeout = new AbortController();
        const timedOut = invokeAlpha(timeout.signal);
        await vi.waitFor(() => expect(alpha).toHaveBeenCalledTimes(3));
        timeout.abort(new Error('caller timeout'));
        await expect(timedOut).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_aborted',
        });
        await expectBetaHealthy();
        expect(beta).toHaveBeenCalledTimes(3);
    });

    it('redacts materialized credential representations from failed action results without changing successful values', async () => {
        const authorizationHeader = 'Bearer synthetic-action-result-token';
        const token = 'synthetic-action-result-token';
        const encodedHeader = encodeURIComponent(authorizationHeader);
        const environmentCredential = 'environment action credential';
        const encodedEnvironmentCredential = Buffer.from(environmentCredential).toString('base64');
        const secretRedactor = createPluginInvocationSecretRedactor();
        const createServicesBase = createUnavailablePluginServicesFactory();
        const lateRecords: PluginInvocationLogRecord[] = [];
        const lateLoggers: ReturnType<typeof createPluginInvocationLogger>[] = [];
        const completedScopes: Array<Readonly<{
            pluginId: string;
            occurrenceId: string;
            correlationId: string;
        }>> = [];
        const registry = createRegistry({
            createServices(seed, binding) {
                const scope = {
                    pluginId: seed.plugin.id,
                    occurrenceId: seed.occurrenceId,
                    correlationId: seed.correlationId,
                };
                secretRedactor.beginInvocation(
                    scope,
                    seed.redactionLifetimeSignal ?? seed.signal,
                );
                secretRedactor.registerRaw(scope, authorizationHeader);
                secretRedactor.registerRaw(scope, token);
                secretRedactor.registerExact(scope, encodedEnvironmentCredential);
                const logger = createPluginInvocationLogger({
                    seed,
                    sink: { write: (record) => { lateRecords.push(record); } },
                    secretRedactor,
                });
                lateLoggers.push(logger);
                return Object.freeze({
                    ...createServicesBase(seed, binding),
                    logger,
                });
            },
            redactDiagnosticText(scope, value) {
                return secretRedactor.redact(scope, value);
            },
            completeDiagnosticScope(scope) {
                completedScopes.push(scope);
                secretRedactor.completeInvocation(scope);
            },
            actions: [{
                ...action(),
                handler: async (input) => {
                    const value = isJsonRecord(input) ? input.value : null;
                    if (value === 'fail') {
                        throw new Error(`upstream rejected ${token} (${encodedHeader})`);
                    }
                    if (value === 'coded-fail') {
                        throw new PluginError({
                            code: token,
                            message: `upstream rejected ${encodedHeader}`,
                        });
                    }
                    if (value === 'environment-fail') {
                        throw new Error(`environment rejected ${encodedEnvironmentCredential}`);
                    }
                    return { echoed: token };
                },
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'fail' },
            surface: 'cli',
        })).resolves.toEqual({
            status: 'failed',
            code: 'plugin_action_execution_failed',
            message: 'upstream rejected [REDACTED] ([REDACTED])',
        });
        // A canonical PluginError publishes its `retryable` signal and payload
        // to the caller, and the same scoped credential redactor that owns the
        // code and message reaches every string inside that payload.
        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'coded-fail' },
            surface: 'cli',
        })).resolves.toEqual({
            status: 'failed',
            code: 'plugin_action_execution_failed',
            message: 'upstream rejected [REDACTED]',
            retryable: false,
            data: {
                name: 'PluginError',
                code: '[REDACTED]',
                message: 'upstream rejected [REDACTED]',
            },
        });
        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'environment-fail' },
            surface: 'cli',
        })).resolves.toEqual({
            status: 'failed',
            code: 'plugin_action_execution_failed',
            message: 'environment rejected [REDACTED]',
        });
        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'success' },
            surface: 'cli',
        })).resolves.toEqual({
            status: 'executed',
            value: { echoed: token },
        });
        lateLoggers.at(-1)?.info(`late ${token}`);
        expect(lateRecords).toEqual([]);
        expect(completedScopes).toHaveLength(4);
        for (const scope of completedScopes) {
            expect(secretRedactor.redact(scope, encodedEnvironmentCredential))
                .toBe(encodedEnvironmentCredential);
        }

        registry.dispose();
        secretRedactor.retireGeneration('7', 'acme.alpha');
    });

    it('admits safe actions without prompting and fails closed for unresolved policy inputs', async () => {
        const handler = vi.fn(async () => ({ echoed: 'no' }));
        const local = createRegistry({ actions: [{ ...action(), handler }] });
        await expect(local.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'executed' });
        const cases = [
            action({
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'api',
                        capability: 'network',
                        reason: 'API',
                        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] },
                    },
                }],
            }),
            action({ availability: { when: { fact: 'host.feature', operator: 'enabled', value: 'x' } } }),
            action({ surfaces: ['agent'] }),
            action({ scopes: ['session'] }),
        ];

        for (const candidate of cases) {
            const registry = createRegistry({ actions: [{ ...candidate, handler }] });
            await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
                .resolves.toMatchObject({ status: 'unavailable' });
        }
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('evaluates action availability from canonical invocation facts', async () => {
        const handler = vi.fn(async () => ({ echoed: 'yes' }));
        const registry = createRegistry({
            actions: [{
                ...action({
                    availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
                }),
                handler,
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'yes' } });
        expect(handler).toHaveBeenCalledOnce();
    });

    it('snapshots exact structured HostAccess requests at registration time', async () => {
        const request: PluginHostAccessRequestV2 = {
            id: 'api',
            capability: 'network',
            reason: 'API',
            scope: {
                targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }],
                methods: ['GET'],
            },
        };
        const unavailableResolver = createTargetActionHostBindingResolver();
        const resolveHostBinding = vi.fn(unavailableResolver);
        const registry = createRegistry({
            resolveHostBinding,
            actions: [{
                ...action({ hostAccessRequests: [{ request, required: false }] }),
                handler: async () => ({ echoed: 'ok' }),
            }],
        });

        const target = request.scope.targets[0];
        if (target?.kind !== 'fixedOrigin') throw new Error('network fixture must use a fixed origin');
        target.origin = 'https://mutated.test';
        await registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        });

        expect(resolveHostBinding).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                hostAccessRequests: [expect.objectContaining({
                    request: expect.objectContaining({
                        scope: expect.objectContaining({
                            targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }],
                        }),
                    }),
                })],
            }),
        );
    });

    it('requires a fingerprint-bound current decision for remote writes', async () => {
        const handler = vi.fn(async () => ({ echoed: 'yes' }));
        const requestCurrentIntent = vi.fn(async ({ fingerprint }) => ({ status: 'approved' as const, fingerprint }));
        const registry = createRegistry({ actions: [{ ...action({ dangerLevel: 'writesRemote' }), handler }] });
        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', requestCurrentIntent }))
            .resolves.toMatchObject({ status: 'executed' });
        expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rechecks a mounted caller after current-intent resolution and before the target handler', async () => {
        let callerCurrent = true;
        let settleIntent: (value: Readonly<{ status: 'approved'; fingerprint: string }>) => void = () => {
            throw new Error('current intent was not requested');
        };
        const handler = vi.fn(async () => ({ echoed: 'should-not-run' }));
        const requestCurrentIntent = vi.fn(({ fingerprint }: Readonly<{ fingerprint: string }>) => (
            new Promise<Readonly<{ status: 'approved'; fingerprint: string }>>((resolve) => {
                settleIntent = resolve;
            })
        ));
        const registry = createRegistry({
            actions: [{ ...action({ dangerLevel: 'writesRemote' }), handler }],
        });

        const pending = registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'cli',
            requestCurrentIntent,
            isMountedCallerCurrent: () => callerCurrent,
        });
        await vi.waitFor(() => expect(requestCurrentIntent).toHaveBeenCalledOnce());
        callerCurrent = false;
        const fingerprint = requestCurrentIntent.mock.calls[0]?.[0]?.fingerprint;
        if (typeof fingerprint !== 'string') throw new Error('expected current-intent fingerprint');
        settleIntent({ status: 'approved', fingerprint });

        await expect(pending).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_mounted_caller_unavailable',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects a decision when refresh replaces the registered generation while intent is pending', async () => {
        const oldHandler = vi.fn(async () => ({ echoed: 'old' }));
        const newHandler = vi.fn(async () => ({ echoed: 'new' }));
        let actions: Parameters<typeof createTargetActionInvocationRegistry>[0]['actions'] = [
            { ...action({ dangerLevel: 'writesRemote' }), handler: oldHandler },
        ];
        const registry = createRegistry({ actions, readActions: () => actions });

        const result = await registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
            requestCurrentIntent: async ({ fingerprint }) => {
                actions = [{ ...action({ dangerLevel: 'writesRemote' }), occurrenceId: '8' as PluginRuntimeOccurrenceId, handler: newHandler }];
                registry.refresh();
                return { status: 'approved', fingerprint };
            },
        });

        expect(result).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
        expect(oldHandler).not.toHaveBeenCalled();
        expect(newHandler).not.toHaveBeenCalled();
    });

    it('validates input and result and invokes a valid handler exactly once', async () => {
        const invalidResult = vi.fn(async () => ({ wrong: true }));
        const registry = createRegistry({ actions: [{ ...action(), handler: invalidResult }] });

        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'invalid', code: 'plugin_action_input_schema_invalid' });
        expect(invalidResult).not.toHaveBeenCalled();
        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toMatchObject({ status: 'invalid', code: 'plugin_action_result_schema_invalid' });
        expect(invalidResult).toHaveBeenCalledTimes(1);
    });

    it('does not preserve ordinary or schema-invalid settlements when private cleanup fails', async () => {
        const unavailableServices = createUnavailablePluginServicesFactory();
        for (const [retainIssuedResult, validResult] of [[false, true], [true, false]] as const) {
            // The disposer is the genuine private-file OS boundary. Registry,
            // result validation and invocation lifetime remain real.
            const removalFailure = Object.assign(new Error('Private lease removal refused'), { code: 'EACCES' });
            const registry = createRegistry({
                createServices(seed, binding) {
                    seed.retainCleanup!({ dispose: async () => { throw removalFailure; } });
                    return unavailableServices(seed, binding);
                },
                actions: [{ ...action(), handler: async (): Promise<JsonValue> => validResult ? { echoed: 'x' } : { wrong: true } }],
            });
            await expect(registry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
                ...(retainIssuedResult ? { retainHandlerResultAfterCancellation: true } : {}),
            })).rejects.toMatchObject({ name: 'AggregateError', errors: [removalFailure] });
        }
    });

    it('normalizes strict JSON at both invocation boundaries and rejects non-JSON values without invoking', async () => {
        const handler = vi.fn(async (input) => input);
        const registry = createRegistry({
            actions: [{
                ...action({ inputSchema: undefined, resultSchema: undefined }),
                handler,
            }],
        });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const sparse = new Array(1);

        for (const input of [new Date(), sparse, cyclic, Promise.resolve('not-json')]) {
            await expect(registry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input, surface: 'cli',
            })).resolves.toMatchObject({
                status: 'invalid', code: 'plugin_action_input_schema_invalid',
            });
        }
        expect(handler).not.toHaveBeenCalled();

        const invalidResults = [new Date(), sparse, cyclic, { nested: Promise.resolve('not-json') }];
        for (const result of invalidResults) {
            const resultRegistry = createRegistry({
                actions: [{
                    ...action({ inputSchema: undefined, resultSchema: undefined }),
                    handler: async () => result as never,
                }],
            });
            await expect(resultRegistry.invoke({
                pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
            })).resolves.toMatchObject({
                status: 'invalid', code: 'plugin_action_result_schema_invalid',
            });
        }
    });

    it('atomically refreshes the complete target index after lazy activation', async () => {
        const handler = vi.fn(async () => ({ echoed: 'lazy' }));
        let actions = [] as Parameters<typeof createTargetActionInvocationRegistry>[0]['actions'];
        const registry = createRegistry({
            actions,
            readActions: () => actions,
        });

        expect(registry.has('acme.alpha', 'run')).toBe(false);
        actions = [{ ...action(), handler }];
        registry.refresh();

        expect(registry.has('acme.alpha', 'run')).toBe(true);
        await expect(registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'lazy' } });
    });

    it('compiles an action schema on first invoke and not again when the index is refreshed', async () => {
        // Compiling an Action's JSON Schema is the expensive part: it constructs an AJV instance
        // and generates a validator. Building the index must not compile every Action (that
        // blocked the daemon for minutes); the first invoke compiles, and a refresh that keeps the
        // same generation reuses it. A counting schema asserts the work itself, not call wiring.
        let schemaReads = 0;
        const countingInputSchema = new Proxy({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
        }, {
            getPrototypeOf(target) {
                // Schema preparation checks strict-JSON prototypes before compilation.
                // Fingerprinting also enumerates the declaration, so ownKeys cannot
                // distinguish legitimate approval binding from repeated preparation.
                schemaReads += 1;
                return Reflect.getPrototypeOf(target);
            },
        });
        const base = action();
        const registration = {
            ...base,
            occurrenceId: 'bytes-7',
            definition: { ...base.definition, inputSchema: countingInputSchema, resultSchema: undefined },
            handler: vi.fn(async () => ({ echoed: 'kept' })),
        } as unknown as Parameters<typeof createTargetActionInvocationRegistry>[0]['actions'][number];
        let actions = [registration];
        const registry = createRegistry({ actions, readActions: () => actions });
        const invokeRun = () => registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        });

        expect(schemaReads).toBe(0);
        await expect(invokeRun()).resolves.toEqual({ status: 'executed', value: { echoed: 'kept' } });
        expect(schemaReads).toBeGreaterThan(0);
        const compiledOnce = schemaReads;

        registry.refresh();
        registry.refresh();

        // The reused invocation must still be the live one that dispatches, without recompiling.
        await expect(invokeRun()).resolves.toEqual({ status: 'executed', value: { echoed: 'kept' } });
        expect(schemaReads).toBe(compiledOnce);

        // A genuinely new generation of the same Action must be recompiled, so this cannot be
        // satisfied by never recompiling.
        actions = [{
            ...registration,
            occurrenceId: 'bytes-8',
        } as typeof registration];
        registry.refresh();
        await invokeRun();
        expect(schemaReads).toBeGreaterThan(compiledOnce);
    });

    it('links caller and generation cancellation and rejects stale results after retirement', async () => {
        let resolveHandler!: (value: { echoed: string }) => void;
        const handler = vi.fn(() => new Promise<{ echoed: string }>((resolve) => {
            resolveHandler = resolve;
        }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const invocation = registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        registry.dispose();
        resolveHandler({ echoed: 'x' });

        const retiredAfterHandlerStart = await invocation;
        expect(retiredAfterHandlerStart).toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_generation_retired',
        });
        expect(retiredAfterHandlerStart).not.toHaveProperty('actionHandlerInvocation');
        expect(handler).toHaveBeenCalledTimes(1);

        await expect(registry.invoke({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
            .resolves.toMatchObject({
                status: 'unavailable',
                code: 'plugin_action_generation_retired',
                actionHandlerInvocation: 'notStarted',
            });

        const aborted = new AbortController();
        aborted.abort(new Error('caller stopped'));
        await expect(createRegistry({ actions: [{ ...action(), handler }] }).invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: aborted.signal,
        })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });
    });

    it('aborts an in-flight handler when its caller is cancelled', async () => {
        const caller = new AbortController();
        const handler = vi.fn((_input, context) => new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        caller.abort(new Error('caller stopped'));
        await expect(invocation).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });
    });

    it('settles an ignored caller abort without waiting for the handler and discards late success exactly once', async () => {
        let resolveHandler!: (value: { echoed: string }) => void;
        const caller = new AbortController();
        const completeDiagnosticScope = vi.fn();
        const alpha = vi.fn(() => new Promise<{ echoed: string }>((resolve) => {
            resolveHandler = resolve;
        }));
        const beta = vi.fn(async () => ({ echoed: 'beta healthy' }));
        const registry = createRegistry({
            completeDiagnosticScope,
            actions: [
                { ...action(), handler: alpha },
                { ...action(), pluginId: 'acme.beta', handler: beta },
            ],
        });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(alpha).toHaveBeenCalledOnce());

        caller.abort(new Error('caller stopped'));

        await vi.waitFor(
            () => expect(completeDiagnosticScope).toHaveBeenCalledOnce(),
            { timeout: 1_000 },
        );
        await expect(invocation).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_aborted',
        });
        expect(completeDiagnosticScope).toHaveBeenCalledOnce();

        resolveHandler({ echoed: 'late' });
        await Promise.resolve();
        await Promise.resolve();

        expect(completeDiagnosticScope).toHaveBeenCalledOnce();
        await expect(registry.invoke({
            pluginId: 'acme.beta', localId: 'run', input: { value: 'x' }, surface: 'cli',
        })).resolves.toEqual({ status: 'executed', value: { echoed: 'beta healthy' } });
        expect(beta).toHaveBeenCalledOnce();
    }, 2_000);

    it('observes and discards a late handler rejection after caller cancellation', async () => {
        let rejectHandler!: (error: Error) => void;
        const caller = new AbortController();
        const handler = vi.fn(() => new Promise<never>((_resolve, reject) => {
            rejectHandler = reject;
        }));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

        caller.abort(new Error('caller stopped'));
        await expect(invocation).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_aborted',
        });

        rejectHandler(new Error('late handler rejection'));
        await Promise.resolve();
        await Promise.resolve();
    });

    it('settles a generation retirement without waiting for an abort-ignoring handler', async () => {
        const handler = vi.fn(() => new Promise<never>(() => {}));
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli',
        });
        await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

        registry.dispose();

        await expect(invocation).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_generation_retired',
        });
    });

    it('discards a successful handler result that settles after caller cancellation', async () => {
        let resolveHandler!: (value: { echoed: string }) => void;
        const caller = new AbortController();
        const registry = createRegistry({
            actions: [{
                ...action(),
                handler: () => new Promise<{ echoed: string }>((resolve) => { resolveHandler = resolve; }),
            }],
        });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(resolveHandler).toBeTypeOf('function'));
        caller.abort(new Error('caller stopped'));
        resolveHandler({ echoed: 'x' });

        await expect(invocation).resolves.toMatchObject({
            status: 'unavailable',
            code: 'plugin_action_aborted',
        });
    });

    it('retains a successful result that settled before caller cancellation', async () => {
        let resolveHandler!: (value: { echoed: string }) => void;
        const caller = new AbortController();
        const registry = createRegistry({
            actions: [{
                ...action(),
                handler: () => new Promise<{ echoed: string }>((resolve) => { resolveHandler = resolve; }),
            }],
        });
        const invocation = registry.invoke({
            pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli', signal: caller.signal,
        });
        await vi.waitFor(() => expect(resolveHandler).toBeTypeOf('function'));

        resolveHandler({ echoed: 'x' });
        await expect(invocation).resolves.toEqual({ status: 'executed', value: { echoed: 'x' } });
        caller.abort(new Error('caller stopped'));
    });
});

describe('SDK testkit and production action invocation parity', () => {
    const parityManifest = {
        schemaVersion: 2,
        id: 'acme.alpha',
        version: '1.2.3',
        displayName: 'Action parity fixture',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        contributes: {
            actions: [{
                id: 'run',
                title: 'Run',
                scopes: ['global'],
                surfaces: ['cli'],
                execution: { target: 'daemon' },
                placementBindings: ['commandPalette'],
                dangerLevel: 'safe',
                inputSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false,
                },
                resultSchema: {
                    type: 'object',
                    properties: { echoed: { type: 'string' } },
                    required: ['echoed'],
                    additionalProperties: false,
                },
            }],
        },
    } satisfies PluginManifest;

    async function invokeThroughProduction(
        handler: ActionHandler,
        input: unknown,
        signal?: AbortSignal,
    ) {
        const registry = createRegistry({ actions: [{ ...action(), handler }] });
        try {
            return await registry.invoke({
                pluginId: 'acme.alpha',
                localId: 'run',
                input,
                surface: 'cli',
                ...(signal ? { signal } : {}),
            });
        } finally {
            registry.dispose();
        }
    }

    async function invokeThroughTestkit(
        handler: ActionHandler,
        input: unknown,
        signal?: AbortSignal,
    ) {
        const testkit = await createPluginTestkit({
            manifest: parityManifest,
            module: {
                activate(api) {
                    api.actions.register('run', handler);
                },
            },
        });
        try {
            const value = await testkit.invokeAction('run', input as never, signal ? { signal } : undefined);
            return Object.freeze({ status: 'executed' as const, value: value ?? null });
        } catch (error) {
            return normalizeTestkitResult(error);
        } finally {
            await testkit.dispose();
        }
    }

    function normalizeTestkitResult(error: unknown) {
        if (isPluginError(error)) {
            const status = error.code.includes('_schema_invalid') ? 'invalid' as const
                : error.code === 'plugin_action_aborted' || error.code === 'plugin_action_generation_retired'
                    ? 'unavailable' as const
                    : 'failed' as const;
            return Object.freeze({ status, code: error.code, message: error.message });
        }
        return Object.freeze({
            status: 'failed' as const,
            code: 'plugin_action_execution_failed',
            message: error instanceof Error ? error.message : 'Plugin action execution failed',
        });
    }

    const invokePaths = [
        ['production', invokeThroughProduction],
        ['testkit', invokeThroughTestkit],
    ] as const;

    for (const [path, invoke] of invokePaths) {
        it(`${path} uses the canonical qualified identity`, async () => {
            await expect(invoke(async (_input, context) => ({
                echoed: context.contribution.qualifiedId,
            }), { value: 'x' })).resolves.toEqual({
                status: 'executed',
                value: { echoed: 'acme.alpha/actions/run' },
            });
        });

        it(`${path} rejects schema-invalid input before invoking the handler`, async () => {
            const handler = vi.fn(async () => ({ echoed: 'not-called' }));
            await expect(invoke(handler, {})).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_input_schema_invalid',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it(`${path} rejects schema-invalid and non-JSON results`, async () => {
            await expect(invoke(async () => ({ wrong: true }), { value: 'x' })).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_result_schema_invalid',
            });
            await expect(invoke(async () => new Date() as never, { value: 'x' })).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_result_schema_invalid',
            });
        });

        it(`${path} rejects non-JSON input without invoking the handler`, async () => {
            const handler = vi.fn(async () => ({ echoed: 'not-called' }));
            await expect(invoke(handler, new Date())).resolves.toMatchObject({
                status: 'invalid',
                code: 'plugin_action_input_schema_invalid',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it(`${path} preserves PluginError codes and caller abort`, async () => {
            await expect(invoke(async () => {
                throw new PluginError({ code: 'fixture_failed', message: 'Fixture failed' });
            }, { value: 'x' })).resolves.toMatchObject({
                status: 'failed',
                code: 'fixture_failed',
            });

            const caller = new AbortController();
            caller.abort(new Error('caller stopped'));
            const handler = vi.fn(async () => ({ echoed: 'not-called' }));
            await expect(invoke(handler, { value: 'x' }, caller.signal)).resolves.toMatchObject({
                status: 'unavailable',
                code: 'plugin_action_aborted',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it(`${path} rejects a late handler result after disposal`, async () => {
            let resolveHandler!: (value: { echoed: string }) => void;
            const handler = vi.fn(() => new Promise<{ echoed: string }>((resolve) => {
                resolveHandler = resolve;
            }));
            if (path === 'production') {
                const registry = createRegistry({ actions: [{ ...action(), handler }] });
                const invocation = registry.invoke({
                    pluginId: 'acme.alpha',
                    localId: 'run',
                    input: { value: 'x' },
                    surface: 'cli',
                });
                await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
                registry.dispose();
                resolveHandler({ echoed: 'x' });
                await expect(invocation).resolves.toMatchObject({
                    status: 'unavailable',
                    code: 'plugin_action_generation_retired',
                });
                return;
            }

            const testkit = await createPluginTestkit({
                manifest: parityManifest,
                module: { activate(api) { api.actions.register('run', handler); } },
            });
            const invocation = testkit.invokeAction('run', { value: 'x' }).catch(normalizeTestkitResult);
            await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
            await testkit.dispose();
            resolveHandler({ echoed: 'x' });
            await expect(invocation).resolves.toMatchObject({
                status: 'unavailable',
                code: 'plugin_action_generation_retired',
            });
        });
    }

    it('delivers a host-stamped message-action snapshot through the SDK invocation context', async () => {
        const messageAction = Object.freeze({
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'message-updated-at:1',
            role: 'agent',
            contentCategory: 'text',
            seq: 7,
            visibleText: 'Current message text',
            structuredPresentationSummary: null,
            provenanceCategory: 'owner',
        } satisfies MessageActionAvailableSnapshotV1);
        const registry = createRegistry({
            actions: [{
                ...action({ surfaces: ['cli', 'ui'] }),
                handler: async (_input, context) => {
                    expect(context.messageAction).toEqual(messageAction);
                    expect(Object.isFrozen(context.messageAction)).toBe(true);
                    return { echoed: context.messageAction?.visibleText ?? '' };
                },
            }],
        });

        await expect(registry.invoke({
            pluginId: 'acme.alpha',
            localId: 'run',
            input: { value: 'x' },
            surface: 'ui',
            messageAction,
        } as never)).resolves.toEqual({
            status: 'executed',
            value: { echoed: 'Current message text' },
        });
    });
});
