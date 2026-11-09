import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { expect, it } from 'vitest';
import type { PluginTargetActivationFact } from '../lifecycle/activation/facts';
import { buildTargetActionInvocationRegistry } from './buildTargetActionRegistry';
import { fixture, pluginId } from './actions/managedCustody.testkit';
import { createProductionPluginInvocationServiceOwners } from './services/production';
import type { PluginInvocationLogRecord } from './services/logger';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

it('keeps admitted native descriptors live-only and out of persisted approval and diagnostics', async () => {
    const f = fixture({ nativeCredentialDelivery: true, dangerous: true });
    const occurrenceId = f.custody.contribution.occurrenceId;
    const localId = 'native-credential-apply';
    const facts: PluginTargetActivationFact = {
        pluginId, pluginVersion: f.manifest.version, source: 'localPath', occurrenceId,
        host: 'daemon', platform: 'darwin', occurredAtMs: 1, status: 'active',
        required: [{ family: 'actions', localId }], bound: [{ family: 'actions', localId }], diagnostics: [],
    };
    const records: PluginInvocationLogRecord[] = [];
    const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: record => records.push(record) } });
    const target = buildTargetActionInvocationRegistry({
        ...owners, contributes: f.runtimeRegistry.contributes, targetActivationFacts: [facts],
        targetRegistrations: [{ pluginId, occurrenceId, registration: { family: 'actions', localId,
            value: (async (input, context) => { context.services.logger.info(`native-policy ${JSON.stringify(input)}`); return { kind: 'confirmed' }; }) satisfies ActionHandler,
        } }],
        readCurrentPluginOccurrenceId: () => occurrenceId,
        readCurrentPluginSourceCustody: () => ({ kind: 'managed', immutableGenerationId: 'native-test-generation', installSource: 'localPath' }),
        resolveAuthorizationFacts: () => ({ generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
    });
    const placeholder = 'native-opaque-placeholder-withheld-from-approval';
    const descriptor = { bindingKey: 'binding-one', destination: 'https://api.example.test',
        requests: [{ path: '/v1/responses', methods: ['POST'] }], placeholder: { header: 'authorization', value: placeholder } };
    const input = { resource: { contributionRef: { pluginId, localId: 'vm' }, schemaVersion: 1, value: {} },
        baseline: { kind: 'allow-all' }, bindings: [descriptor], ownedBindings: [descriptor] };
    let stored: TargetActionApprovalRequestV1 | undefined;
    let invoked = false;
    const approval = createTargetActionCurrentIntentAdapter({
        create: async request => {
            stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
            // Artifact state is observation, not authenticated decision delivery.
            setImmediate(() => { void getSharedBlockingApprovalCoordinator().resolveBlockingDecision({
                artifactId: 'native-private-approval', request: { ...request, status: 'approved',
                    decision: { kind: 'approve', decidedAtMs: Date.now() } },
                decision: 'approve', decisionAuthority: 'present_user',
            }); });
            return { artifactId: 'native-private-approval' };
        },
        read: async () => stored?.status === 'open' ? { ...stored, status: 'approved', decision: { kind: 'approve', decidedAtMs: Date.now() } } : stored ?? null,
        update: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request))); return { ok: true }; },
    });
    try {
        const result = await target.invoke({ pluginId, localId, surface: 'cli', input, requestCurrentIntent: approval,
            beforeHandlerInvocation: async () => { invoked = true; } });
        expect(result).toMatchObject({ status: 'executed' });
        expect(invoked).toBe(true);
        expect(stored).toMatchObject({ approvalInputCustody: 'live_only' });
        expect(JSON.stringify(stored)).not.toContain(placeholder);
        expect(records.some(record => JSON.stringify(record).includes('native-policy'))).toBe(true);
        expect(JSON.stringify(records)).not.toContain(placeholder);
        expect(JSON.stringify(result)).not.toContain(placeholder);
    } finally { target.dispose(); }
});
