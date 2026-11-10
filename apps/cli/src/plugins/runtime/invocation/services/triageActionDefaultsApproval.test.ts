import { describe, expect, it } from 'vitest';
import { createActionExecutor, ActionsSettingsV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    computeExternalActionRequestEnvelopeDigestV1, StrictJsonValueSchema, type ActionExecutorContext } from '@happier-dev/protocol';
import { fingerprintPluginAccountActionConfirmation, pluginActionRequiresPresentUserIntent, formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/invocation';
import { createProfileOperations } from '@happier-dev/protocol/profiles/profileOperations';
import { createProfileActionExecuteV1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { createPromptDocInLibrary, type PromptLibraryArtifactStore, type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from '@happier-dev/plugins-triage/manifest';
import { TRIAGE_SAVE_ACTION_DEFAULTS_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createCommittedContributedActionInvoker } from '../actions/createCommittedContributedActionDeps';
import { createTargetActionInvocationRegistry } from '../targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from './production';
import { createTestkitAccountKv } from '../../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support.js';
import { createTestkitCorpusCollections } from '../../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../../../../../../packages/plugins/triage/src/settings/actions.js';
import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_USER_MARKS_COLLECTION_ID } from '../../../../../../../packages/plugins/triage/src/corpus/collections/ids.js';

describe('Triage Save defaults approval through the Account host', () => {
    it.each([
        { label: 'own present-user UI Save click', ask: false, confirm: false, direct: true },
        { label: 'disabled own present-user UI Save click', ask: false, confirm: false, direct: true, disabled: true },
        { label: 'automation without UI consent', ask: false, confirm: false, direct: false },
        { label: 'explicit Ask confirmed', ask: true, confirm: true, direct: false },
        { label: 'explicit Ask confirmed before Action disabled', ask: true, confirm: true, direct: false, disabled: true },
        { label: 'explicit Ask belongs to another Account', ask: true, confirm: true, direct: false, change: 'account' },
        { label: 'explicit Ask approved different operands', ask: true, confirm: true, direct: false, change: 'input' },
        { label: 'explicit Ask without consent', ask: true, confirm: false, direct: false },
    ])('saves only reviewed Profile and prompt effects: $label', async scenario => {
        const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === TRIAGE_SAVE_ACTION_DEFAULTS_ACTION_REF_V1.localId)!;
        const action = { pluginId: PLUGIN_MANIFEST.id, localId: declaration.id };
        const input = { action, input: { v: 1, kind: 'saveDefaults', actionId: 'fix', label: 'Repair carefully',
            promptText: 'Fix it with a regression test.', profileId: null, placement: 'ask', checkout: 'ask', launchMode: 'review' } };
        const sourceCustody = { kind: 'bundled_first_party' as const,
            packagedRuntime: { kind: 'source_declaration' as const, packageName: '@happier-dev/plugins-triage' } };
        const occurrenceId = createPluginRuntimeOccurrenceId(PLUGIN_MANIFEST.id);
        const kv = createTestkitAccountKv();
        const corpus = createTestkitCorpusCollections();
        // Account KV and collections model the external storage boundary.
        const storage = { account: { kv: kv.kv, collection: (definition: { id: string }) => {
            if (definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID) return corpus.collections.sourceInstances;
            if (definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID) return corpus.collections.sessionLinks;
            if (definition.id === CORPUS_USER_MARKS_COLLECTION_ID) return corpus.collections.userMarks;
            throw new Error(`Unexpected collection ${definition.id}`);
        } } } as unknown as StorageService;
        let plugin!: PluginTestkit;
        const targetedContributions = { observeForSelf: (point: Parameters<PluginTestkit['readTargetedContributionFixture']>[0]) => ({
            readCurrent: async () => plugin.readTargetedContributionFixture(point), dispose() {},
        }) } as unknown as PluginServices['targetedContributions'];
        plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { storage, targetedContributions } });
        const profiles: ProfileRecordV1[] = [];
        const nestedActions: string[] = [];
        const effectContexts: ActionExecutorContext[] = [];
        const documents = new Map<string, PromptLibraryStoredArtifact>();
        const store: PromptLibraryArtifactStore = {
            read: async id => documents.get(id) ?? null,
            update: async ({ artifactId, header, body }) => { documents.set(artifactId, { id: artifactId, header, body,
                revision: { headerVersion: 1, bodyVersion: 2 } }); },
            create: async ({ header, body }) => { const artifactId = 'saved-prompt';
                documents.set(artifactId, { id: artifactId, header, body, revision: { headerVersion: 1, bodyVersion: 1 } });
                return artifactId; },
        };
        let invocationRecord: PromptLibraryRecordV1 = { key: 'invocations', value: { v: 1, entries: [] } };
        const operations = createProfileOperations({
            readCatalog: () => ({ source: 'destination', authority: 'active', controlRevision: 1,
                control: { revision: 1, record: { v: 1, phase: 'active', sourceSettingsVersion: 0, migratedLogicalRevision: 0, inventory: [] } },
                status: 'ready', records: profiles.map(record => ({ record, revision: 1 })), diagnostics: [], referenceGuardRevision: 1 }),
            artifactsById: () => new Map(),
            writeRecord: async ({ record }) => { profiles.push(record); return { status: 'updated', id: record.id, revision: 1 }; },
            deleteRecord: async () => { throw new Error('Unexpected deletion'); },
        });
        let runtime!: ResolvedExecutablePluginRuntimeRegistry;
        // Registry acquisition is the process-loading boundary; dispatch, target
        // admission, the registered Triage handler and nested Action policy are real.
        const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => ({
            registry: runtime, source: 'ephemeral', durableRevision: -1, release: async () => {},
        }) });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            invokeContributedAction: invoke,
            profileActionExecute: async (request, context) => {
                effectContexts.push(context);
                return createProfileActionExecuteV1({ operations })(request, context);
            },
            promptDocCreate: async request => createPromptDocInLibrary({ store, request }),
            promptStacks: { serverId: 'home', assertCurrent() {},
                readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: invocationRecord, revision: 0 }], tombstones: [], diagnostics: [] } }),
                writeRecord: async ({ record }) => { invocationRecord = record; return { status: 'updated', revision: 1, cursor: 1 }; },
            },
            approvalsCreate: async () => {
                if (scenario.direct || scenario.confirm) throw new Error('An admitted UI Save must not create a second Ask');
                return { artifactId: 'nested-approval' };
            },
        });
        const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: {
            execute: (id, value, context) => { nestedActions.push(id); return executor.execute(id, value, context); },
        },
            invokeContributedAction: async request => {
                const result = await invoke({ action: request.action, input: request.input,
                    context: request.approvalContext ?? { surface: request.surface }, signal: request.signal });
                return result.ok ? { status: 'executed', value: StrictJsonValueSchema.parse(result.result) }
                    : { status: 'failed', code: result.errorCode, message: result.error };
            },
        });
        const targets = createTargetActionInvocationRegistry({
            actions: [{ pluginId: PLUGIN_MANIFEST.id, pluginVersion: PLUGIN_MANIFEST.version, occurrenceId, sourceCustody,
                localId: declaration.id, definition: declaration,
                handler: async (value, context) => StrictJsonValueSchema.parse(await plugin.invokeAction(declaration.id, value, { ...context,
                    services: { ...context.services, storage, targetedContributions } })),
            }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
            readCurrentPluginOccurrenceId: () => occurrenceId,
        });
        // The executable registry is a host boundary fixture, populated from the
        // real declaration rather than reproducing its approval policy.
        const contribution = { pluginId: PLUGIN_MANIFEST.id, identity: action,
            definition: { ...declaration, surfaces: Object.fromEntries(declaration.surfaces.map(surface => [surface, true])) },
        } as unknown as ResolvedActionContribution;
        runtime = { executionRealm: 'account', contributes: { actionsById: new Map([[`${action.pluginId}/${action.localId}`, contribution]]) },
            targetActionInvocations: targets, readPluginOccurrenceId: () => occurrenceId,
            revalidateAccountExecution: async () => true,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const target = { kind: 'machine' as const, machineId: 'account-host' };
        const envelope = { v: 1 as const, requestId: 'save-defaults', target, input };
        // The Account relay retains the real caller: an own host UI press, or
        // a plugin's automation ceiling with separately reviewed intent.
        const context: ActionExecutorContext = { surface: 'ui', authority: scenario.direct ? 'present_user' : 'account_automation', actionCaller: scenario.direct ? { kind: 'host' } : {
            kind: 'plugin', pluginId: action.pluginId, contributionLocalId: action.localId,
            occurrenceId, sourceCustody, originSurface: 'ui',
        },
            runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'home', actionRequestId: envelope.requestId,
            externalActionTarget: target, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                actions: scenario.disabled ? { [formatQualifiedPluginActionId(action)]: { enabled: false } }
                    : scenario.ask ? { [formatQualifiedPluginActionId(action)]: { approvalRequiredSurfaces: ['ui'] } } : {} }),
            externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-root', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                serverIdentityId: 'home', machineId: target.machineId, installationId: 'installation', actionId: 'action.invoke',
                requestId: envelope.requestId, target, accountEncryptionMode: 'plain', admittedMachineRole: 'manage',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } }),
            signExternalActionApprovalInput: () => 'host-signature',
        };
        // The mounted native modal is an external UI boundary. Its completed
        // consent uses the exact production Account wrapper fingerprint.
        if (scenario.confirm && pluginActionRequiresPresentUserIntent({ ...declaration,
            ...(scenario.ask ? { approvalRequiredByActionSettings: true } : {}) }, 'ui', input.input, 'present_user')) {
            context.presentUserConfirmation = { actionId: 'action.invoke', requestId: envelope.requestId,
                accountId: scenario.change === 'account' ? 'other-owner' : 'owner', serverId: 'home', target,
                inputDigest: fingerprintPluginAccountActionConfirmation({
                    input: scenario.change === 'input' ? { ...input, input: { ...input.input, label: 'Other approved label' } } : input,
                    pluginId: PLUGIN_MANIFEST.id,
                    pluginVersion: PLUGIN_MANIFEST.version, declaration, sourceCustody })!,
            };
        }
        try {
            const result = await executor.execute('action.invoke', input, context);
            if ((!scenario.confirm && !scenario.direct) || scenario.change || scenario.disabled && !scenario.confirm) {
                expect(result.ok).toBe(false);
                if (scenario.disabled) expect(result).toMatchObject({ errorCode: 'plugin_action_unavailable' });
                if (scenario.change) expect(result).toMatchObject({ errorCode: 'plugin_action_current_intent_mismatch',
                    details: { actionHandlerInvocation: 'notStarted', details: { currentIntentMismatch: {
                        field: scenario.change === 'account' ? 'account' : 'fingerprint_source',
                    } } } });
                expect(profiles).toEqual([]);
                expect(documents.size).toBe(0);
                expect(kv.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toBeUndefined();
                return;
            }
            expect(result, JSON.stringify({ result, nestedActions })).toMatchObject({ ok: true, result: { status: 'applied' } });
            expect(profiles).toHaveLength(1);
            expect(effectContexts).toEqual([expect.objectContaining({ surface: 'plugin', authority: 'account_automation',
                actionCaller: expect.objectContaining({ kind: 'plugin', pluginId: action.pluginId }) })]);
            expect(documents.get('saved-prompt')?.body).toContain('Fix it with a regression test.');
            expect(invocationRecord).toMatchObject({ key: 'invocations', value: { entries: [
                expect.objectContaining({ target: { kind: 'doc', artifactId: 'saved-prompt' } }),
            ] } });
            expect(kv.read(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1)).toMatchObject({ actions: expect.arrayContaining([
                expect.objectContaining({ actionId: 'fix', label: 'Repair carefully', profileId: profiles[0]!.id }),
            ]) });
        } finally {
            targets.dispose();
            await owners.dispose();
            await plugin.dispose();
        }
    });
});
