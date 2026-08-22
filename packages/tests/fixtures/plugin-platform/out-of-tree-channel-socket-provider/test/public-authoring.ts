import {
    definePlugin,
    type PluginContributionRef,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import {
    AutomationConversationAdmitInputV1Schema,
    AutomationConversationAdmitResultV1Schema,
} from '@happier-dev/plugin-sdk/automations';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    ConversationProviderSetupResultV1Schema as ConversationProviderSetupResultV1RootSchema,
} from '@happier-dev/channels-protocol';
import {
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
    ConversationProvidersContributionProtocolV1,
    ConversationConnectionTestInputV1Schema,
    ConversationConnectionTestResultV1Schema,
    ConversationDeliveryResultV1Schema,
    ConversationProviderConnectionsSnapshotV1Schema,
    ConversationTransportFactReportResultV1Schema,
    type ConversationProviderObservationIngestInputV1,
} from '@happier-dev/channels-protocol/v1';
import { createConversationProviderSetupResultV1Fixture } from '@happier-dev/channels-protocol/testing/v1';

const emptyObjectSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {},
} satisfies PluginJsonSchema;

const publicTargetedProtocol = ConversationProvidersContributionProtocolV1;
const publicSetupFixture = ConversationProviderSetupResultV1RootSchema.parse(
    createConversationProviderSetupResultV1Fixture({
        providerConnectionKey: 'fixture:authoring',
    }),
);
const setupOperation = publicTargetedProtocol.operations.setup;
const setupDeclaration = setupOperation.declaration;
const connectionTestOperation = publicTargetedProtocol.operations.connectionTest;
const connectionTestDeclaration = connectionTestOperation.declaration;
if (connectionTestDeclaration.input.kind !== 'protocolDefined') {
    throw new Error('Channels connectionTest input must be protocol-defined');
}
const connectionTestInputSchema = connectionTestDeclaration.input.schema.jsonSchema;
const connectionTestResultSchema = connectionTestDeclaration.resultSchema.jsonSchema;
const publicConnectionTestInput = ConversationConnectionTestInputV1Schema.parse({
    v: 1,
    connectionId: 'connection-1',
    providerConnectionKey: 'fixture:authoring',
    providerConfigVersion: 1,
    providerConfig: {},
    credentialRef: null,
    selectedTransport: 'socket',
});
const messageDeliverOperation = publicTargetedProtocol.operations.messageDeliver;
const messageDeliverDeclaration = messageDeliverOperation.declaration;
if (messageDeliverDeclaration.input.kind !== 'protocolDefined') {
    throw new Error('Channels messageDeliver input must be protocol-defined');
}

/**
 * Compile-only external-author proof for one target point. Its counterpart
 * below binds an intentionally arbitrary Action local id, so this cannot pass
 * through a Channels magic-ID convention.
 */
const publicTargetedContributionTarget = definePlugin({
    id: 'happier.channels',
    version: '1.0.0',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    contributionPoints: {
        providers: publicTargetedProtocol.point(),
    },
});

const publicTargetedContributionContributor = definePlugin({
    id: 'acme.channels.out-of-tree-socket',
    version: '1.0.0',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    actions: {
        'fixture/setup': {
            title: 'Set up remote socket',
            scopes: ['global'],
            surfaces: setupDeclaration.surfaces,
            dangerLevel: setupDeclaration.dangerLevel,
            execution: { target: 'daemon' },
            inputSchema: emptyObjectSchema,
            resultSchema: setupDeclaration.resultSchema.jsonSchema,
            run: async () => publicSetupFixture,
        },
        'fixture/test': {
            title: 'Diagnose remote socket',
            scopes: ['global'],
            surfaces: connectionTestDeclaration.surfaces,
            dangerLevel: connectionTestDeclaration.dangerLevel,
            execution: { target: 'daemon' },
            inputSchema: connectionTestDeclaration.input.schema.jsonSchema,
            resultSchema: connectionTestDeclaration.resultSchema.jsonSchema,
            run: async () => ConversationConnectionTestResultV1Schema.parse({
                kind: 'ready',
                integrationPrincipal: { id: 'fixture:integration' },
                providerConnectionKey: 'fixture:authoring',
            }),
        },
        'fixture/deliver': {
            title: 'Deliver remote socket message',
            scopes: ['global'],
            surfaces: messageDeliverDeclaration.surfaces,
            dangerLevel: messageDeliverDeclaration.dangerLevel,
            execution: { target: 'daemon' },
            inputSchema: messageDeliverDeclaration.input.schema.jsonSchema,
            resultSchema: messageDeliverDeclaration.resultSchema.jsonSchema,
            run: async () => ConversationDeliveryResultV1Schema.parse({
                kind: 'delivered',
                providerMessageIds: ['fixture:authoring:delivery'],
            }),
        },
    },
    contributesTo: {
        'happier.channels': {
            providers: {
                'fixture-socket': publicTargetedProtocol.contribute({
                    operations: {
                        setup: publicTargetedProtocol.operations.setup.bind('fixture/setup'),
                        connectionTest: publicTargetedProtocol.operations.connectionTest.bind(
                            'fixture/test',
                        ),
                        messageDeliver: publicTargetedProtocol.operations.messageDeliver.bind(
                            'fixture/deliver',
                        ),
                    },
                }),
            },
        },
    },
});

/**
 * Compile-only target-side proof: the target observes only its own
 * helper-produced point and invokes an admitted role through the incumbent
 * Action service. The admitted handle, including its immutable-generation
 * fence, is host-stamped; this author supplies no registry lookup, selector,
 * materialization id, or dispatcher.
 */
async function publicTargetedContributionInvocation(
    context: PluginInvocationContext,
): Promise<void> {
    const observation = context.services.targetedContributions.observeForSelf(
        publicTargetedContributionTarget.contributionPoints.providers,
        { onInvalidated: () => undefined },
    );
    try {
        const snapshot = await observation.readCurrent({ signal: context.signal });
        const contributor = snapshot.contributions[0];
        if (!contributor) return;
        await context.services.actions.executeAdmittedTargetedOperation(
            contributor.operations.connectionTest,
            publicConnectionTestInput,
            { signal: context.signal },
        );
    } finally {
        observation.dispose();
    }
}

const coreObservationIngest = {
    pluginId: 'happier.channels',
    localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest,
} satisfies PluginContributionRef;

const coreConnectionsList = {
    pluginId: 'happier.channels',
    localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
} satisfies PluginContributionRef;

const coreConnectionRead = {
    pluginId: 'happier.channels',
    localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
} satisfies PluginContributionRef;

const coreTransportFactReport = {
    pluginId: 'happier.channels',
    localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
} satisfies PluginContributionRef;

const publicSocketObservationIngress = {
    connectionId: 'connection-1',
    observation: {
        kind: 'fullText',
        observation: {
            v: 1,
            occurrenceId: 'fixture:occurrence:1',
            occurredAt: 1_725_000_000_000,
            transport: { kind: 'socket' },
            endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
            actor: {
                principalId: 'fixture:human',
                kind: 'human',
                isIntegrationSelf: false,
            },
            message: {
                id: 'fixture:message:1',
                text: 'incoming fixture message',
                addressingEvidence: 'none',
                contentProvenance: 'original',
                providerTimestamp: 1_725_000_000_000,
            },
        },
    },
} satisfies ConversationProviderObservationIngestInputV1;

const publicSocketShellIngress = {
    connectionId: 'connection-1',
    observation: {
        kind: 'routableNonAdmission',
        shell: {
            v: 1,
            occurrenceId: 'fixture:occurrence:2',
            occurredAt: 1_725_000_000_001,
            transport: { kind: 'socket' },
            endpoint: { kind: 'direct', audience: 'direct', id: 'fixture:room' },
            actor: {
                principalId: 'fixture:human',
                kind: 'human',
                isIntegrationSelf: false,
            },
            message: {
                id: 'fixture:message:2',
                addressingEvidence: 'none',
                contentProvenance: 'original',
                providerTimestamp: 1_725_000_000_001,
            },
        },
        reason: 'unsupportedContent',
    },
} satisfies ConversationProviderObservationIngestInputV1;

function publicActionInvocation(context: PluginInvocationContext): Promise<unknown> {
    return context.services.actions.execute(coreObservationIngest, publicSocketObservationIngress, { signal: context.signal });
}

/**
 * Compile-only external-author proof for the socket lifecycle surface. The
 * real fixture owns its lifecycle; this probe ensures all of those calls stay
 * available through published SDK and Channels protocol packages.
 */
async function publicSocketLifecycle(context: BackgroundServiceContext): Promise<void> {
    const listed = ConversationProviderConnectionsSnapshotV1Schema.parse(
        await context.services.actions.execute(coreConnectionsList, {}, { signal: context.signal }),
    );
    const snapshot = Object.values(listed)[0];
    if (snapshot === undefined) return;

    const exact = ConversationProviderConnectionsSnapshotV1Schema.parse(
        await context.services.actions.execute(
            coreConnectionRead,
            { connectionId: snapshot.connectionId },
            { signal: context.signal },
        ),
    );
    const current = exact[snapshot.connectionId];
    if (current === undefined || current.authorityEpoch !== snapshot.authorityEpoch) return;

    const socket = await context.services.http.openWebSocket({
        url: 'wss://channels-fixture.invalid/socket',
        protocols: ['channels-fixture-v1'],
        maxMessageBytes: 128 * 1024,
    }, { signal: context.signal });
    try {
        await socket.send({
            kind: 'text',
            text: JSON.stringify({
                kind: 'subscribe',
                connectionId: current.connectionId,
                requiresFullSharedMessageContent: current.requiresFullSharedMessageContent,
            }),
        }, { signal: context.signal });
        const factResult = await context.services.actions.execute(
            coreTransportFactReport,
            {
                connectionId: current.connectionId,
                authorityEpoch: current.authorityEpoch,
                fact: { kind: 'stopConfirmed', reason: 'notRunningOnReconcile' },
            },
            { signal: context.signal },
        );
        ConversationTransportFactReportResultV1Schema.parse(factResult);
    } finally {
        socket.close({ code: 1000, reason: 'public authoring probe complete' });
        await socket.dispose();
    }
}

/**
 * An out-of-tree plugin binds an existing Account Automation through the same
 * published Actions a bundled plugin uses.  Nothing here names a plugin id:
 * every current Automation is selectable and several bindings may name one.
 */
async function publicConversationTargetSelection(context: PluginInvocationContext) {
    const targets = await context.services.actions.execute(
        'automation.conversation.targets.list',
        { limit: 10 },
        { signal: context.signal },
    );
    const first = targets.items[0];
    if (!first) return targets.nextCursor;
    const verification = await context.services.actions.execute(
        'automation.conversation.target.verify',
        {
            automationId: first.automationId,
            expectedTemplateVersion: first.templateVersion,
            resultDelivery: 'finalResult',
        },
        { signal: context.signal },
    );
    if (verification.kind === 'notVerified') {
        const reason: 'notFound' | 'templateVersionMismatch' | 'resultDeliveryUnsupported' =
            verification.reason;
        return reason;
    }
    const templateVersion: number = verification.templateVersion;
    return { automationId: first.automationId, templateVersion };
}

/**
 * Public-authoring regression for the generated built-in Action map.  This
 * deliberately uses only the SDK root surface: a missing or widened map entry
 * loses the discriminated result below instead of being repaired with a
 * Channels-specific wrapper or cast.
 */
async function publicConversationAdmission(context: PluginInvocationContext) {
    const input = AutomationConversationAdmitInputV1Schema.parse({
        automationId: 'automation-1',
        bindingId: 'binding-1',
        templateVersion: 1,
        occurrenceId: 'public-fixture:conversation:1',
        occurredAt: 1_700_000_000_000,
        sender: { id: 'sender-1' },
        text: 'Public Action authoring probe',
        resultDelivery: {
            kind: 'finalResult',
            actionRef: {
                pluginId: 'happier.channels',
                localId: 'automation/result-deliver-v1',
            },
            opaqueContext: { conversationId: 'conversation-1', messageId: 'message-1' },
        },
    });
    const result = AutomationConversationAdmitResultV1Schema.parse(
        await context.services.actions.execute(
            'automation.conversation.admit',
            input,
            { signal: context.signal },
        ),
    );

    if (result.kind === 'blocked') {
        const checkpointSafe: false = result.checkpointSafe;
        return checkpointSafe;
    }
    const checkpointSafe: true = result.checkpointSafe;
    return { runId: result.runId, checkpointSafe };
}

const authoringProbe = definePlugin({
    id: 'acme.channels.public-authoring-probe',
    version: '1.0.0',
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './src/index.mjs' },
    activation: { events: [{ kind: 'startup' }] },
    actions: {
        'fixture/public-probe': {
            title: 'Public contract probe',
            scopes: ['global'],
            surfaces: ['plugin'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
            inputSchema: connectionTestInputSchema,
            resultSchema: connectionTestResultSchema,
            run: async () => ConversationConnectionTestResultV1Schema.parse({
                kind: 'notReady',
                reason: 'unsupported',
            }),
        },
    },
    resources: {
        'probe-status': {
            source: 'dynamic',
            kind: 'config',
            scope: 'global',
            contentType: 'application/json',
            maxBytes: 1024,
            runtime: {
                read: () => new TextEncoder().encode('{}'),
                observe: () => ({ dispose: () => undefined }),
            },
        },
    },
    backgroundServices: [{
        declaration: { id: 'probe-background', title: 'Public background service probe' },
        runner: async (context) => {
            await publicActionInvocation(context);
        },
    }],
});

void emptyObjectSchema;
void publicSetupFixture;
void publicSocketObservationIngress;
void publicSocketShellIngress;
void publicConversationTargetSelection;
void publicConversationAdmission;
void publicSocketLifecycle;
void authoringProbe;
void publicTargetedContributionTarget;
void publicTargetedContributionContributor;
void publicTargetedContributionInvocation;
