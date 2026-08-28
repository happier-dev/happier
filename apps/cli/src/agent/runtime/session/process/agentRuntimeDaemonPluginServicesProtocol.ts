import { z } from 'zod';

import {
    ConnectedAccountMaterializationRequestSchema,
    ConnectedAccountRequestAuthUsesV1Schema,
    AgentRuntimeJsonValueV1Schema,
    ExternalSessionOperationReferenceV1Schema,
    ExternalSessionRefSchema,
    ExternalSessionTranscriptFollowEventV1Schema,
    ExternalSessionTranscriptItemIdV1Schema,
    ExternalSessionTranscriptSourceTimestampV1Schema,
    HostEventIdV1Schema,
    HostEventTargetV1Schema,
    ManagedExecutableRefSchema,
    PluginContributionIdentityV1Schema,
    ProviderRuntimeBindingBasisV1Schema,
    QualifiedConnectedAccountRefSchema,
    SessionIdSchema,
    SessionProviderBindingMetadataV1Schema,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountRequestAuthUseV1,
    ProviderRuntimeBindingBasisV1,
    SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import { PluginInvocableActionIdSchema } from '@happier-dev/protocol/actions';
import {
    AgentRuntimeDaemonServiceTurnWitnessV1Schema,
} from './agentRuntimeDaemonServiceTurnWitness';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const BoundedIdSchema = z.string().trim().min(1).max(512);
const HostPluginContributionIdentityV1Schema = asHostProtocolZod(
    PluginContributionIdentityV1Schema,
);
const HostQualifiedConnectedAccountRefSchema = asHostProtocolZod(
    QualifiedConnectedAccountRefSchema,
);
const HostSessionIdSchema = asHostProtocolZod(SessionIdSchema);
const HostExternalSessionRefSchema = asHostProtocolZod(ExternalSessionRefSchema);
const HostExternalSessionOperationReferenceV1Schema = asHostProtocolZod(
    ExternalSessionOperationReferenceV1Schema,
);
const HostExternalSessionTranscriptFollowEventV1Schema = asHostProtocolZod(
    ExternalSessionTranscriptFollowEventV1Schema,
);
const BoundedTextSchema = z.string().max(65_536);
const Base64Schema = z.string().regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
);
const SafeNonNegativeIntegerSchema =
    z.number().int().nonnegative().safe();
const CursorSchema = z.string().max(32_768);
const PluginStorageScopeSchema =
    z.enum(['ephemeral', 'daemonSession', 'daemon']);
export const RunnerDaemonPluginSettingsScopeV1Schema =
    z.enum(['account', 'daemon']);
export type RunnerDaemonPluginSettingsScopeV1 = z.infer<
    typeof RunnerDaemonPluginSettingsScopeV1Schema
>;
const ManagedProviderManifestAuthoritySchema =
    z.enum(['external', 'bundled_first_party']);
const OptionalConnectedAccountsServiceScopeSchema = {
    serviceScope: z.literal('managedProvider').optional(),
};
const HttpMethodSchema =
    z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const StringRecordSchema = z.record(
    z.string().trim().min(1).max(256),
    BoundedTextSchema,
).refine((value) => Object.keys(value).length <= 512);
const RunnerDaemonHostEventDeliveryScopeV1Schema = z.union([
    z.object({
        kind: z.literal('session'),
        sessionId: HostSessionIdSchema,
    }).strict(),
    z.object({ kind: z.literal('account') }).strict(),
]);

const RunnerDaemonExternalSessionRemediationV1Schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('retry') }).strict(),
    z.object({ kind: z.literal('openSettings'), path: BoundedTextSchema }).strict(),
    z.object({
        kind: z.literal('selectAccount'),
        service: z.object({ pluginId: BoundedIdSchema, localId: BoundedIdSchema }).strict(),
    }).strict(),
    z.object({ kind: z.literal('installDependency'), dependencyId: BoundedIdSchema }).strict(),
    z.object({ kind: z.literal('openUrl'), url: z.string().url().max(8_192) }).strict(),
]);
const RunnerDaemonExternalSessionAvailabilityV1Schema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('available') }).strict(),
    z.object({
        status: z.literal('unavailable'),
        code: BoundedIdSchema,
        remediation: RunnerDaemonExternalSessionRemediationV1Schema.optional(),
    }).strict(),
    z.object({
        status: z.literal('denied'),
        code: BoundedIdSchema,
        remediation: RunnerDaemonExternalSessionRemediationV1Schema.optional(),
    }).strict(),
]);
const RunnerDaemonExternalSessionTakeoverCapabilityV1Schema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('unavailable'), code: BoundedIdSchema }).strict(),
    z.object({
        status: z.literal('available'),
        storageModes: z.array(z.enum(['external-linked', 'persisted'])).max(2),
    }).strict(),
]);
const RunnerDaemonExternalSessionDiagnosticV1Schema = z.object({
    code: BoundedIdSchema,
    severity: z.enum(['info', 'warning', 'error']),
    message: BoundedTextSchema.optional(),
    details: AgentRuntimeJsonValueV1Schema.optional(),
    remediation: RunnerDaemonExternalSessionRemediationV1Schema.optional(),
}).strict();
const RunnerDaemonExternalSessionTranscriptItemV1Schema = z.object({
    id: ExternalSessionTranscriptItemIdV1Schema,
    timestampMs: ExternalSessionTranscriptSourceTimestampV1Schema.optional(),
    kind: z.enum(['user', 'agent', 'system', 'event']),
    data: AgentRuntimeJsonValueV1Schema,
}).strict();

export const RunnerDaemonExternalSessionsCapabilitiesResultV1Schema = z.object({
    list: RunnerDaemonExternalSessionAvailabilityV1Schema,
    attach: RunnerDaemonExternalSessionAvailabilityV1Schema,
    takeover: RunnerDaemonExternalSessionTakeoverCapabilityV1Schema,
    transcript: RunnerDaemonExternalSessionAvailabilityV1Schema,
    follow: RunnerDaemonExternalSessionAvailabilityV1Schema,
}).strict();
export const RunnerDaemonExternalSessionsListResultV1Schema = z.object({
    items: z.array(z.object({
        ref: HostExternalSessionRefSchema,
        title: BoundedTextSchema.optional(),
        updatedAtMs: SafeNonNegativeIntegerSchema.optional(),
        capabilities: z.array(z.enum(['attach', 'transcript', 'follow'])).max(3),
        takeover: RunnerDaemonExternalSessionTakeoverCapabilityV1Schema,
    }).strict()).max(1_000),
    nextCursor: CursorSchema.nullable(),
    diagnostics: z.array(RunnerDaemonExternalSessionDiagnosticV1Schema).max(1_000).optional(),
}).strict();
export const RunnerDaemonExternalSessionsAttachResultV1Schema = z.object({
    sessionId: BoundedIdSchema,
}).strict();
const RunnerDaemonExternalSessionsReadAfterDiagnosticV1Schema = z.object({
    code: BoundedIdSchema,
    severity: z.enum(['benign', 'required']),
    count: z.number().int().positive().safe(),
    positions: z.array(SafeNonNegativeIntegerSchema).max(200),
}).strict();
export const RunnerDaemonExternalSessionsTranscriptResultV1Schema = z.union([
    z.object({
        mode: z.literal('page'),
        items: z.array(RunnerDaemonExternalSessionTranscriptItemV1Schema).max(1_000),
        nextCursor: CursorSchema.nullable(),
        tailCursor: CursorSchema.nullable().optional(),
        hasMore: z.boolean().optional(),
        truncated: z.boolean().optional(),
    }).strict(),
    z.object({ mode: z.literal('readAfter'), outcome: z.literal('already_current') }).strict(),
    z.object({
        mode: z.literal('readAfter'),
        outcome: z.literal('advanced'),
        items: z.array(RunnerDaemonExternalSessionTranscriptItemV1Schema).max(1_000),
        nextCursor: CursorSchema,
        boundary: BoundedTextSchema,
        hasMore: z.boolean(),
        diagnostics: z.array(RunnerDaemonExternalSessionsReadAfterDiagnosticV1Schema).max(32).optional(),
    }).strict(),
    z.object({
        mode: z.literal('readAfter'),
        outcome: z.enum([
            'gap_or_cursor_expired',
            'source_replaced',
            'source_unavailable',
            'read_failed',
        ]),
    }).strict(),
]);
export const RunnerDaemonExternalSessionsTakeoverResultV1Schema =
    HostExternalSessionOperationReferenceV1Schema;
export const RunnerDaemonExternalSessionsFollowEventV1Schema =
    HostExternalSessionTranscriptFollowEventV1Schema;

export type RunnerDaemonManagedProviderCustodyScopeV1 = Readonly<{
    v: 1;
    sessionId: string;
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1;
    pluginId: string;
    providerLocalId: string;
    activationGeneration: string;
    immutableGenerationId: string;
    manifestAuthority: 'external' | 'bundled_first_party';
    operationClaimId: string;
}>;

export type RunnerDaemonManagedProviderBootstrapV1 = Readonly<{
    v: 1;
    scope: RunnerDaemonManagedProviderCustodyScopeV1;
    requestAuth: Readonly<{
        capabilityPath: string;
        requestAuthUses:
            readonly ConnectedAccountRequestAuthUseV1[];
    }> | null;
    providerPluginHardRevocationRevisionAtAdmission: number;
    sessionBindingMetadata?: SessionProviderBindingMetadataV1;
}>;

export const RunnerDaemonManagedProviderCustodyScopeV1Schema:
    z.ZodType<RunnerDaemonManagedProviderCustodyScopeV1> = z.object({
    v: z.literal(1),
    sessionId: BoundedIdSchema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
    pluginId: BoundedIdSchema,
    providerLocalId: BoundedIdSchema,
    activationGeneration: BoundedIdSchema,
    immutableGenerationId: BoundedIdSchema,
    manifestAuthority: ManagedProviderManifestAuthoritySchema,
    operationClaimId: BoundedIdSchema,
}).strict().superRefine((value, context) => {
    const basis = value.runtimeBindingBasis;
    if (
        basis.deployment.kind !== 'managedLocal'
        || basis.deployment.implementationIdentity.pluginId
            !== value.pluginId
        || basis.deployment.implementationIdentity.localId
            !== value.providerLocalId
    ) {
        context.addIssue({
            code: 'custom',
            path: ['runtimeBindingBasis'],
            message:
                'Managed Provider bootstrap identity must match its runtime binding basis',
        });
    }
});

export const RunnerDaemonManagedProviderBootstrapV1Schema:
    z.ZodType<RunnerDaemonManagedProviderBootstrapV1> = z.object({
    v: z.literal(1),
    scope: RunnerDaemonManagedProviderCustodyScopeV1Schema,
    requestAuth: z.object({
        capabilityPath: z.string().trim().min(1).max(32_768),
        requestAuthUses: ConnectedAccountRequestAuthUsesV1Schema,
    }).strict().nullable(),
    providerPluginHardRevocationRevisionAtAdmission:
        SafeNonNegativeIntegerSchema,
    sessionBindingMetadata:
        SessionProviderBindingMetadataV1Schema.optional(),
}).strict().superRefine((value, context) => {
    const expectedUses = value.scope.runtimeBindingBasis.deployment.kind
        === 'managedLocal'
        ? value.scope.runtimeBindingBasis.deployment.managedRuntime
            .requestAuthUses
        : [];
    const receivedUses = value.requestAuth?.requestAuthUses ?? [];
    if (
        (expectedUses.length === 0) !== (value.requestAuth === null)
        || JSON.stringify(receivedUses) !== JSON.stringify(expectedUses)
    ) {
        context.addIssue({
            code: 'custom',
            path: ['requestAuth'],
            message:
                'Managed Provider bootstrap request-auth uses must match its runtime binding basis',
        });
    }
    const metadata = value.sessionBindingMetadata;
    if (
        metadata
        && (
            !metadata.runtimeBindingBasis
            || JSON.stringify(metadata.runtimeBindingBasis)
                !== JSON.stringify(value.scope.runtimeBindingBasis)
            || metadata.connectionId
                !== value.scope.runtimeBindingBasis.connectionId
            || metadata.contributionKey
                !== value.scope.runtimeBindingBasis.contributionKey
        )
    ) {
        context.addIssue({
            code: 'custom',
            path: ['sessionBindingMetadata'],
            message:
                'Managed Provider bootstrap metadata must match its exact runtime binding basis',
        });
    }
});

export type RunnerDaemonManagedProviderRetentionV1 = Readonly<{
    v: 1;
    scope: RunnerDaemonManagedProviderCustodyScopeV1;
    providerPluginHardRevocationRevisionAtAdmission: number;
}>;

export const RunnerDaemonManagedProviderRetentionV1Schema:
    z.ZodType<RunnerDaemonManagedProviderRetentionV1> = z.object({
        v: z.literal(1),
        scope: RunnerDaemonManagedProviderCustodyScopeV1Schema,
        providerPluginHardRevocationRevisionAtAdmission:
            SafeNonNegativeIntegerSchema,
    }).strict();

const RunnerDaemonPluginServiceWireValueV1Schema: z.ZodType<
    RunnerDaemonPluginServiceWireValueV1
> = z.lazy(() => z.discriminatedUnion('t', [
    z.object({ t: z.literal('null') }).strict(),
    z.object({ t: z.literal('boolean'), value: z.boolean() }).strict(),
    z.object({ t: z.literal('number'), value: z.number().finite() }).strict(),
    z.object({ t: z.literal('string'), value: BoundedTextSchema }).strict(),
    z.object({ t: z.literal('bytes'), base64: Base64Schema }).strict(),
    z.object({
        t: z.literal('array'),
        value: z.array(RunnerDaemonPluginServiceWireValueV1Schema).max(65_536),
    }).strict(),
    z.object({
        t: z.literal('object'),
        value: z.record(
            z.string().max(4_096),
            RunnerDaemonPluginServiceWireValueV1Schema,
        ).refine((value) => Object.keys(value).length <= 65_536),
    }).strict(),
]));

export type RunnerDaemonPluginServiceWireValueV1 =
    | Readonly<{ t: 'null' }>
    | Readonly<{ t: 'boolean'; value: boolean }>
    | Readonly<{ t: 'number'; value: number }>
    | Readonly<{ t: 'string'; value: string }>
    | Readonly<{ t: 'bytes'; base64: string }>
    | Readonly<{
        t: 'array';
        value: readonly RunnerDaemonPluginServiceWireValueV1[];
    }>
    | Readonly<{
        t: 'object';
        value: Readonly<
            Record<string, RunnerDaemonPluginServiceWireValueV1>
        >;
    }>;

interface RunnerDaemonPluginServiceWireInputObject {
    readonly [key: string]: RunnerDaemonPluginServiceWireInput;
}

export type RunnerDaemonPluginServiceWireInput =
    | null
    | boolean
    | number
    | string
    | Uint8Array
    | readonly RunnerDaemonPluginServiceWireInput[]
    | RunnerDaemonPluginServiceWireInputObject;

export function encodeRunnerDaemonPluginServiceWireValueV1(
    value: unknown,
): RunnerDaemonPluginServiceWireValueV1 {
    if (value === null) return Object.freeze({ t: 'null' });
    if (value instanceof Uint8Array) {
        return Object.freeze({
            t: 'bytes',
            base64: Buffer.from(value).toString('base64'),
        });
    }
    switch (typeof value) {
        case 'boolean':
            return Object.freeze({ t: 'boolean', value });
        case 'number':
            if (!Number.isFinite(value)) {
                throw new Error(
                    'Plugin service wire numbers must be finite',
                );
            }
            return Object.freeze({ t: 'number', value });
        case 'string':
            return Object.freeze({ t: 'string', value });
        case 'object':
            if (Array.isArray(value)) {
                return Object.freeze({
                    t: 'array',
                    value: Object.freeze(value.map(
                        encodeRunnerDaemonPluginServiceWireValueV1,
                    )),
                });
            }
            if (!value) break;
            return Object.freeze({
                t: 'object',
                value: Object.freeze(Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [
                        key,
                        encodeRunnerDaemonPluginServiceWireValueV1(item),
                    ]),
                )),
            });
    }
    throw new Error('Unsupported PluginServices wire value');
}

export function decodeRunnerDaemonPluginServiceWireValueV1(
    value: RunnerDaemonPluginServiceWireValueV1,
): RunnerDaemonPluginServiceWireInput {
    switch (value.t) {
        case 'null':
            return null;
        case 'boolean':
        case 'number':
        case 'string':
            return value.value;
        case 'bytes':
            return new Uint8Array(Buffer.from(value.base64, 'base64'));
        case 'array':
            return value.value.map(
                decodeRunnerDaemonPluginServiceWireValueV1,
            );
        case 'object':
            return Object.fromEntries(Object.entries(value.value).map(
                ([key, item]) => [
                    key,
                    decodeRunnerDaemonPluginServiceWireValueV1(item),
                ],
            ));
    }
}

const PluginPathSchema = z.discriminatedUnion('root', [
    z.object({
        root: z.literal('pluginData'),
        relativePath: z.string().max(32_768),
    }).strict(),
    z.object({
        root: z.literal('workspace'),
        relativePath: z.string().max(32_768),
    }).strict(),
    z.object({
        root: z.literal('project'),
        projectId: BoundedIdSchema,
        relativePath: z.string().max(32_768),
    }).strict(),
]);

const PaginationSchema = {
    cursor: CursorSchema.optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
};
const OperationBaseSchema = {
    requestId: BoundedIdSchema,
    invocationId: BoundedIdSchema,
};
const ExpectedRevisionSchema = {
    expectedRevision: BoundedIdSchema.optional(),
};
const OptionalWitnessSchema = {
    witness:
        AgentRuntimeDaemonServiceTurnWitnessV1Schema.optional(),
};
const OptionalSignalTimeoutSchema = {
    timeoutMs: SafeNonNegativeIntegerSchema.optional(),
};

export const RUNNER_DAEMON_PROVIDER_OPERATION_IDS_V1 = [
    'connections.describe',
    'connections.mutate',
    'connections.bindingStatus',
    'catalog.probe',
    'catalog.listModels',
    'catalog.setModelLoad',
    'catalog.projectModels',
    'catalog.mutateModelSettings',
    'migrations.preview',
    'migrations.confirm',
    'migrations.confirmConflict',
] as const;
export type RunnerDaemonProviderOperationIdV1 =
    (typeof RUNNER_DAEMON_PROVIDER_OPERATION_IDS_V1)[number];
const RunnerDaemonProviderOperationIdV1Schema = z.enum(
    RUNNER_DAEMON_PROVIDER_OPERATION_IDS_V1,
);

const ExecSpawnRequestSchema = z.object({
    executable: ManagedExecutableRefSchema,
    args: z.array(BoundedTextSchema).max(4_096).optional(),
    cwd: PluginPathSchema.optional(),
    env: StringRecordSchema.optional(),
    stdin: Base64Schema.optional(),
    maxStdoutBytes: SafeNonNegativeIntegerSchema.optional(),
    maxStderrBytes: SafeNonNegativeIntegerSchema.optional(),
    timeoutMs: SafeNonNegativeIntegerSchema.optional(),
}).strict();

export const RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS = [
    z.object({
        kind: z.literal('plugin_services.prepare_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        managedProviderRetention:
            RunnerDaemonManagedProviderRetentionV1Schema.optional(),
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_services.managed_provider.start_v1',
        ),
        ...OperationBaseSchema,
        retained: RunnerDaemonManagedProviderRetentionV1Schema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_services.managed_provider.materialize_agent_binding_v1',
        ),
        ...OperationBaseSchema,
        retained: RunnerDaemonManagedProviderRetentionV1Schema,
        endpointUrl: z.string().url().max(8_192),
        credentialPlaceholder:
            z.string().min(32).max(512),
    }).strict(),
    z.object({
        kind: z.literal('plugin_services.close_v1'),
        ...OperationBaseSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_logger.write_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        entry: z.discriminatedUnion('kind', [
            z.object({
                kind: z.literal('log'),
                level: z.enum([
                    'debug',
                    'info',
                    'warn',
                    'error',
                ]),
                message: BoundedTextSchema,
                fields:
                    RunnerDaemonPluginServiceWireValueV1Schema
                        .optional(),
            }).strict(),
            z.object({
                kind: z.literal('diagnostic'),
                data: z.object({
                    code: BoundedIdSchema,
                    severity: z.enum([
                        'info',
                        'warning',
                        'error',
                    ]),
                    message: BoundedTextSchema.optional(),
                    details:
                        RunnerDaemonPluginServiceWireValueV1Schema
                            .optional(),
                    remediation: z.discriminatedUnion('kind', [
                        z.object({
                            kind: z.literal('retry'),
                        }).strict(),
                        z.object({
                            kind: z.literal('openSettings'),
                            path: z.string().max(32_768),
                        }).strict(),
                        z.object({
                            kind: z.literal('selectAccount'),
                            service:
                                HostPluginContributionIdentityV1Schema,
                        }).strict(),
                        z.object({
                            kind: z.literal('installDependency'),
                            dependencyId: BoundedIdSchema,
                        }).strict(),
                        z.object({
                            kind: z.literal('openUrl'),
                            url: z.string().url().max(8_192),
                        }).strict(),
                    ]).optional(),
                }).strict(),
            }).strict(),
        ]),
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.get_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: PluginStorageScopeSchema,
        key: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.set_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: PluginStorageScopeSchema,
        key: BoundedIdSchema,
        value: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.delete_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: PluginStorageScopeSchema,
        key: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.list_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: PluginStorageScopeSchema,
        prefix: z.string().max(4_096).optional(),
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.transaction.open_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        transactionId: BoundedIdSchema,
        scope: PluginStorageScopeSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.transaction.get_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        transactionId: BoundedIdSchema,
        key: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.transaction.set_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        transactionId: BoundedIdSchema,
        key: BoundedIdSchema,
        value: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.transaction.delete_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        transactionId: BoundedIdSchema,
        key: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.transaction.commit_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        transactionId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_storage.transaction.rollback_v1'),
        ...OperationBaseSchema,
        transactionId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_settings.snapshot_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: RunnerDaemonPluginSettingsScopeV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_settings.get_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: RunnerDaemonPluginSettingsScopeV1Schema,
        id: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_settings.set_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...ExpectedRevisionSchema,
        scope: RunnerDaemonPluginSettingsScopeV1Schema,
        id: BoundedIdSchema,
        value: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_settings.reset_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...ExpectedRevisionSchema,
        scope: RunnerDaemonPluginSettingsScopeV1Schema,
        id: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_settings.watch.open_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        scope: RunnerDaemonPluginSettingsScopeV1Schema,
        subscriptionId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_secrets.status_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        id: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_secrets.get_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        id: BoundedIdSchema,
        reason: z.string().trim().min(1).max(4_096).optional(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_secrets.set_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...ExpectedRevisionSchema,
        id: BoundedIdSchema,
        value: BoundedTextSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_secrets.delete_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...ExpectedRevisionSchema,
        id: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_events.emit_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        eventId: BoundedIdSchema,
        payload: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_events.subscribe.open_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        subscriptionId: BoundedIdSchema,
        event: HostPluginContributionIdentityV1Schema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_events.host.subscribe.open_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        subscriptionId: BoundedIdSchema,
        target: HostEventTargetV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_fetch.request_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        request: z.object({
            url: z.string().url().max(8_192),
            method: HttpMethodSchema.optional(),
            headers: StringRecordSchema.optional(),
            body: Base64Schema.optional(),
            redirect: z.enum(['error', 'follow', 'manual']),
            timeoutMs: SafeNonNegativeIntegerSchema.optional(),
            credentialBinding:
                RunnerDaemonPluginServiceWireValueV1Schema.optional(),
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_actions.execute_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        actionId: PluginInvocableActionIdSchema,
        input: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_sessions.external.capabilities_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_sessions.external.list_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        query: RunnerDaemonPluginServiceWireValueV1Schema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_sessions.external.attach_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ref: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_sessions.external.read_transcript_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ref: RunnerDaemonPluginServiceWireValueV1Schema,
        query: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_sessions.external.follow_transcript.open_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        subscriptionId: BoundedIdSchema,
        ref: RunnerDaemonPluginServiceWireValueV1Schema,
        options: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_sessions.external.takeover_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ref: RunnerDaemonPluginServiceWireValueV1Schema,
        request: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_providers.invoke_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        operation: RunnerDaemonProviderOperationIdV1Schema,
        request: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_fs.read_file_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        path: PluginPathSchema,
        maxBytes: SafeNonNegativeIntegerSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_fs.write_file_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        path: PluginPathSchema,
        data: Base64Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_fs.stat_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        path: PluginPathSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_fs.list_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        path: PluginPathSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_fs.remove_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        path: PluginPathSchema,
        recursive: z.boolean().optional(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_resources.describe_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        id: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_resources.read_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        id: BoundedIdSchema,
        maxBytes: SafeNonNegativeIntegerSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_resources.watch.open_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        subscriptionId: BoundedIdSchema,
        id: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.list_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        sessionId: BoundedIdSchema.optional(),
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.discover_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        provider: HostPluginContributionIdentityV1Schema,
        input: RunnerDaemonPluginServiceWireValueV1Schema.optional(),
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.connect_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        ref: HostPluginContributionIdentityV1Schema,
        sessionId: BoundedIdSchema.optional(),
        elicitation: z.discriminatedUnion('mode', [
            z.object({
                mode: z.literal('hostMediated'),
                sessionId: BoundedIdSchema,
            }).strict(),
            z.object({ mode: z.literal('reject') }).strict(),
        ]),
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.list_tools_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.call_tool_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        name: BoundedIdSchema,
        input: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.list_resources_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.list_resource_templates_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.read_resource_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        uri: z.string().trim().min(1).max(8_192),
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.subscribe_resource.open_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        subscriptionId: BoundedIdSchema,
        uri: z.string().trim().min(1).max(8_192),
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.list_prompts_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.get_prompt_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        clientId: BoundedIdSchema,
        name: BoundedIdSchema,
        args: StringRecordSchema.optional(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_mcp.client.close_v1'),
        ...OperationBaseSchema,
        clientId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_notifications.send_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        request: z.object({
            clientRequestId: BoundedIdSchema,
            categoryId: BoundedIdSchema,
            title: BoundedTextSchema,
            body: BoundedTextSchema.optional(),
            channelIds: z.array(BoundedIdSchema).max(256).optional(),
            data: RunnerDaemonPluginServiceWireValueV1Schema.optional(),
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_notifications.list_channels_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_notifications.list_categories_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...PaginationSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_notifications.preferences_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        categoryId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_notifications.watch_preferences.open_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        subscriptionId: BoundedIdSchema,
        categoryId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_connected_accounts.get_binding_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        purpose: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_connected_accounts.request_selection_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        purpose: BoundedIdSchema,
        reason: z.string().trim().min(1).max(4_096),
    }).strict(),
    z.object({
        kind: z.literal('plugin_connected_accounts.materialize_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        purpose: BoundedIdSchema,
        expectedAccount: HostQualifiedConnectedAccountRefSchema.optional(),
        request: ConnectedAccountMaterializationRequestSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_connected_accounts.list_accounts_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        purpose: BoundedIdSchema,
        limit: z.number().int().min(1).max(1_000).optional(),
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_connected_accounts.materialize_listed_account_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        purpose: BoundedIdSchema,
        account: HostQualifiedConnectedAccountRefSchema,
        request: ConnectedAccountMaterializationRequestSchema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_connected_accounts.watch.open_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        subscriptionId: BoundedIdSchema,
        purpose: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_connected_accounts.watch.next_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        ...OptionalConnectedAccountsServiceScopeSchema,
        subscriptionId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_services.subscription.next_v1',
        ),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        subscriptionId: BoundedIdSchema,
        acknowledgement: z.enum([
            'settled',
            'rejected',
        ]).optional(),
    }).strict(),
    z.object({
        kind: z.literal(
            'plugin_services.subscription.close_v1',
        ),
        ...OperationBaseSchema,
        subscriptionId: BoundedIdSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_exec.agent_cli.check_readiness_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        request: z.object({
            candidates: z.array(BoundedIdSchema).min(1).max(256),
            requirement: z.enum(['any', 'all']),
            cwd: z.string().max(32_768).optional(),
            projectId: BoundedIdSchema.optional(),
            workspaceId: BoundedIdSchema.optional(),
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_exec.system_tools.resolve_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        request: z.object({
            toolId: BoundedIdSchema,
            purpose: z.string().trim().min(1).max(4_096),
            cwd: z.string().max(32_768).optional(),
            preferredPath:
                z.string().max(32_768).nullable().optional(),
        }).strict(),
    }).strict(),
    z.object({
        kind: z.literal('plugin_exec.launch.authorize_v1'),
        ...OperationBaseSchema,
        ...OptionalWitnessSchema,
        systemToolResolutionId: BoundedIdSchema.optional(),
        request: ExecSpawnRequestSchema,
    }).strict(),
    z.object({
        kind: z.literal('plugin_exec.launch.release_v1'),
        ...OperationBaseSchema,
        authorizationId: BoundedIdSchema,
    }).strict(),
] as const;

export const RunnerDaemonPluginServiceOperationV1Schema =
    z.discriminatedUnion(
        'kind',
        RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS,
    );

export type RunnerDaemonPluginServiceOperationV1 = z.infer<
    typeof RunnerDaemonPluginServiceOperationV1Schema
>;

export const RunnerDaemonPluginServiceSubscriptionEventV1Schema =
    z.discriminatedUnion('kind', [
        z.object({
                kind: z.literal(
                    'plugin_settings.watch.event_v1',
                ),
                invocationId: BoundedIdSchema,
                subscriptionId: BoundedIdSchema,
                scope: RunnerDaemonPluginSettingsScopeV1Schema,
                change: z.object({
                revision: BoundedIdSchema,
                changedIds: z.array(BoundedIdSchema).max(65_536),
                values: z.record(
                    z.string().max(4_096),
                    RunnerDaemonPluginServiceWireValueV1Schema,
                ),
            }).strict(),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_events.subscribe.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            event: z.object({
                ref: HostPluginContributionIdentityV1Schema,
                payload:
                    RunnerDaemonPluginServiceWireValueV1Schema,
                sequence:
                    z.number().int().nonnegative().safe(),
            }).strict(),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_events.host.subscribe.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            event: z.object({
                eventId: HostEventIdV1Schema,
                scope: RunnerDaemonHostEventDeliveryScopeV1Schema,
                payload:
                    RunnerDaemonPluginServiceWireValueV1Schema,
            }).strict(),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_resources.watch.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            change: z.object({
                digest: BoundedTextSchema,
            }).strict(),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_sessions.external.follow_transcript.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            event: RunnerDaemonPluginServiceWireValueV1Schema,
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_sessions.external.follow_transcript.opened_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            result: z.discriminatedUnion('status', [
                z.object({
                    status: z.literal('following'),
                    startingCursor:
                        z.string().max(4_096).nullable(),
                }).strict(),
                z.object({
                    status: z.literal('unavailable'),
                    code: BoundedIdSchema,
                }).strict(),
                z.object({
                    status: z.literal('failed'),
                    code: BoundedIdSchema,
                    message: BoundedTextSchema,
                }).strict(),
            ]),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_mcp.client.subscribe_resource.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            event: z.object({
                uri: z.string().trim().min(1).max(8_192),
            }).strict(),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_notifications.watch_preferences.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            preferences: z.object({
                categoryId: BoundedIdSchema,
                enabled: z.boolean(),
                channelIds:
                    z.array(BoundedIdSchema).max(65_536),
                revision: BoundedIdSchema,
            }).strict(),
        }).strict(),
        z.object({
            kind: z.literal(
                'plugin_connected_accounts.watch.event_v1',
            ),
            invocationId: BoundedIdSchema,
            subscriptionId: BoundedIdSchema,
            event: z.object({
                kind: z.literal('resync'),
            }).strict(),
        }).strict(),
    ]);

export type RunnerDaemonPluginServiceSubscriptionEventV1 = z.infer<
    typeof RunnerDaemonPluginServiceSubscriptionEventV1Schema
>;

export const RunnerDaemonPluginServiceResultV1Schema =
    z.object({
        kind: z.literal('plugin_services.result_v1'),
        requestId: BoundedIdSchema,
        value: RunnerDaemonPluginServiceWireValueV1Schema,
    }).strict();

export type RunnerDaemonPluginServiceResultV1 = z.infer<
    typeof RunnerDaemonPluginServiceResultV1Schema
>;
