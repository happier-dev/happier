import { randomBytes, randomUUID } from 'node:crypto';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS,
    validateAgentExternalSessionHookMapEventRequest,
    validateAgentExternalSessionHookMapEventResult,
    type AgentExternalSessionLinkData,
    type AgentExternalSessionHookMapEventValue,
    type AgentExternalSessionHooksContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    agentRoutingIdAddressesContributionIdentityV1,
    buildLinkedExternalSessionQualifiedIdentityV1,
    type ExternalAgentObservationLeafFactV1,
    type ExternalAgentObservationTargetV1,
    type LinkedExternalSessionQualifiedIdentityV1,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';

import type {
    ExternalSessionIndexedTagLookupProof,
} from '@/api/session/external/linking/ensureExternalSessionLink';
import {
    preservesExternalSessionSourceIdentity,
} from '@/session/external/sourceIdentity';
import type {
    BoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';

const TOTAL_FORWARDING_DEADLINE_MS =
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.totalHookDeadlineMs;
const MAP_EVENT_MAX_SERIALIZED_BYTES =
    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks.mapHookEvent.maxEnvelopeUtf8Bytes;
const EXTERNAL_SESSION_MAX_SERIALIZED_BYTES = 262_144;

export type QualifiedExternalSessionHookPrincipalState =
    | 'disabled'
    | 'enabled'
    | 'revoked'
    | 'generation_retired';

type PrincipalState = QualifiedExternalSessionHookPrincipalState;

type Principal = {
    principalRef: string;
    token: string | null;
    scopeKey: string;
    installationIdentity: string;
    machineId: string;
    agentId: string;
    qualifiedContributionId: PluginContributionIdentityV1;
    variantId: string;
    eventId: string;
    pluginGeneration: string;
    retirementSignal: AbortSignal;
    ingressController: AbortController;
    state: PrincipalState;
    removeRetirementListener: () => void;
};

export type QualifiedExternalSessionHookRuntimeLease = Readonly<{
    hooks: AgentExternalSessionHooksContribution;
    externalSessions: BoundedAgentExternalSessionsContribution;
    generation: string;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
    release(): Promise<void>;
}>;

type ResolvedMappedIdentity = Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    linkData?: AgentExternalSessionLinkData;
    qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
}>;

type EnsuredLink = Readonly<{
    sessionId: string;
    created: boolean;
}>;

type CurrentLinkResolution =
    | Readonly<{
        state: 'linked';
        sessionId: string;
        linkGeneration: string;
    }>
    | Readonly<{
        sessionId: string;
        linkGeneration: string;
    }>
    | Readonly<{
        state: 'absent';
        indexedTagLookupProof: ExternalSessionIndexedTagLookupProof;
    }>
    | Readonly<{ state: 'blocked' }>;

type QualifiedExternalSessionHookIngressParams = Readonly<{
    shouldCommit?: () => boolean;
    readAccountScopeKey?: () => string | null;
    acquireRuntime(input: Readonly<{
        qualifiedContributionId: PluginContributionIdentityV1;
        agentId: string;
        pluginGeneration: string;
        variantId: string;
    }>): Promise<QualifiedExternalSessionHookRuntimeLease | null>;
    resolveCurrentLink(input: Readonly<{
        machineId: string;
        agentId: string;
        identity: ResolvedMappedIdentity;
        sessionId?: string;
        signal: AbortSignal;
        deadlineAtMs: number;
    }>): Promise<CurrentLinkResolution | null>;
    admitFacts(input: Readonly<{
        sessionId: string;
        agentId: string;
        identity: ResolvedMappedIdentity;
        target: ExternalAgentObservationTargetV1;
        facts: readonly ExternalAgentObservationLeafFactV1[];
        signal: AbortSignal;
        deadlineAtMs: number;
        shouldCommit?: () => boolean;
    }>): Promise<void>;
    readAutoLinkPolicy(input: Readonly<{
        machineId: string;
        agentId: string;
        qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
        source: AgentExternalSessionSource;
    }>): Promise<Readonly<{
        accountScopeKey: string;
        canonicalResolvedSourceKey: string;
        sourcePolicyId: string;
        enabledAtMs: number;
    }> | null>;
    isAutoLinkPolicyCurrent(input: Readonly<{
        machineId: string;
        qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
        sourcePolicyId: string;
        enabledAtMs: number;
        accountScopeKey: string;
    }>): boolean;
    ensureLink(input: Readonly<{
        machineId: string;
        agentId: string;
        qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
        sourcePolicyId: string;
        expectedSourceKey: string;
        source: AgentExternalSessionSource;
        remoteSessionId: string;
        linkData?: AgentExternalSessionLinkData;
        storageMode: 'machine_only';
        indexedTagLookupProof?: ExternalSessionIndexedTagLookupProof;
        signal: AbortSignal;
        deadlineAtMs: number;
        shouldCommit?: () => boolean;
    }>): Promise<Readonly<{
        sessionId: string;
        created: boolean;
    }>>;
    now?: () => number;
}>;

export type QualifiedExternalSessionHookPrincipalInput = Readonly<{
    installationIdentity: string;
    machineId: string;
    agentId: string;
    qualifiedContributionId: PluginContributionIdentityV1;
    variantId: string;
    eventId: string;
    pluginGeneration: string;
    retirementSignal: AbortSignal;
    principalRef?: string;
    token?: string;
}>;

export type QualifiedExternalSessionHookDeliveryInput = Readonly<{
    token: string;
    eventId: string;
    observedAtMs: number;
    forwardingStartedAtMs: number;
    nativePayload: JsonValue;
    signal: AbortSignal;
}>;

export type QualifiedExternalSessionHookDeliveryResult =
    | Readonly<{ state: 'admitted'; facts: number }>
    | Readonly<{ state: 'linked'; sessionId: string; created: boolean }>
    | Readonly<{ state: 'ignored' | 'rejected' }>;

function normalizedId(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0
        && trimmed.length <= AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits
        ? trimmed
        : null;
}

function principalScopeKey(input: Readonly<{
    installationIdentity: string;
    machineId: string;
    agentId: string;
    qualifiedContributionId: PluginContributionIdentityV1;
    variantId: string;
    eventId: string;
}>): string {
    return JSON.stringify([
        input.machineId,
        input.agentId,
        input.qualifiedContributionId.pluginId,
        input.qualifiedContributionId.localId,
        input.installationIdentity,
        input.variantId,
        input.eventId,
    ]);
}

function readSuccessfulValue(value: unknown): unknown | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return record.ok === true
        && Object.keys(record).length === 2
        && Object.prototype.hasOwnProperty.call(record, 'value')
        ? record.value
        : null;
}

function composeDeliverySignal(params: Readonly<{
    signals: readonly AbortSignal[];
    deadlineAtMs: number;
    now(): number;
}>) {
    const controller = new AbortController();
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
    });
    const abort = () => {
        if (controller.signal.aborted) return;
        controller.abort();
        resolveTerminal();
    };
    for (const signal of params.signals) {
        signal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(abort, Math.max(0, params.deadlineAtMs - params.now()));
    timer.unref?.();
    if (
        params.deadlineAtMs <= params.now()
        || params.signals.some((signal) => signal.aborted)
    ) {
        abort();
    }
    return {
        signal: controller.signal,
        terminal,
        cleanup() {
            clearTimeout(timer);
            for (const signal of params.signals) {
                signal.removeEventListener('abort', abort);
            }
        },
    };
}

async function settleBeforeAbort<T>(
    operation: () => T | Promise<T>,
    terminal: Promise<void>,
): Promise<T | null> {
    const settled = Promise.resolve()
        .then(operation)
        .then(
            (value) => ({ kind: 'value' as const, value }),
            () => ({ kind: 'failed' as const }),
        );
    const outcome = await Promise.race([
        settled,
        terminal.then(() => ({ kind: 'terminal' as const })),
    ]);
    return outcome.kind === 'value' ? outcome.value : null;
}

async function acquireBeforeAbort(
    operation: () => Promise<QualifiedExternalSessionHookRuntimeLease | null>,
    terminal: Promise<void>,
): Promise<QualifiedExternalSessionHookRuntimeLease | null> {
    const settled = Promise.resolve()
        .then(operation)
        .then(
            (lease) => ({ kind: 'value' as const, lease }),
            () => ({ kind: 'failed' as const }),
        );
    const outcome = await Promise.race([
        settled,
        terminal.then(() => ({ kind: 'terminal' as const })),
    ]);
    if (outcome.kind === 'value') return outcome.lease;
    void settled.then(async (late) => {
        if (late.kind === 'value' && late.lease) {
            await late.lease.release().catch(() => undefined);
        }
    });
    return null;
}

function parseResolvedSource(
    value: unknown,
): AgentExternalSessionSource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1) return null;
    const source = AgentRuntimeJsonValueV1Schema.safeParse(record.source);
    if (
        !source.success
        || !source.data
        || typeof source.data !== 'object'
        || Array.isArray(source.data)
        || typeof Reflect.get(source.data, 'kind') !== 'string'
    ) {
        return null;
    }
    return Object.freeze({
        ...(source.data as Record<string, unknown>),
        kind: Reflect.get(source.data, 'kind') as string,
    }) as AgentExternalSessionSource;
}

function parseResolvedIdentity(value: unknown): Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    linkData: AgentExternalSessionLinkData;
}> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).some(
            (key) => !['source', 'remoteSessionId', 'linkData'].includes(key),
        )
        || typeof record.remoteSessionId !== 'string'
        || !normalizedId(record.remoteSessionId)
    ) {
        return null;
    }
    const source = parseResolvedSource({ source: record.source });
    const linkData = AgentRuntimeJsonValueV1Schema.safeParse(record.linkData);
    if (
        !source
        || !linkData.success
        || !linkData.data
        || typeof linkData.data !== 'object'
        || Array.isArray(linkData.data)
    ) {
        return null;
    }
    return {
        source,
        remoteSessionId: record.remoteSessionId.trim(),
        linkData: Object.freeze({
            ...(linkData.data as Record<string, unknown>),
        }) as AgentExternalSessionLinkData,
    };
}

export function createQualifiedExternalSessionHookIngress(
    params: QualifiedExternalSessionHookIngressParams,
) {
    const now = params.now ?? Date.now;
    const principalsByRef = new Map<string, Principal>();
    const principalsByToken = new Map<string, Principal>();
    const currentPrincipalByScope = new Map<string, Principal>();
    const inFlightEnsures = new Map<string, Readonly<{
        promise: Promise<EnsuredLink>;
        currentCommitGuards: Set<() => boolean>;
        effectController: AbortController;
    }>>();

    const transition = (principal: Principal, state: PrincipalState): void => {
        if (
            principal.state === 'revoked'
            || principal.state === 'generation_retired'
        ) {
            return;
        }
        principal.ingressController.abort();
        principal.state = state;
        if (state === 'revoked' || state === 'generation_retired') {
            if (principal.token) principalsByToken.delete(principal.token);
            principal.token = null;
            principal.removeRetirementListener();
            if (currentPrincipalByScope.get(principal.scopeKey) === principal) {
                currentPrincipalByScope.delete(principal.scopeKey);
            }
        }
    };

    const isCurrent = (
        principal: Principal,
        runtime: QualifiedExternalSessionHookRuntimeLease,
        ingressSignal: AbortSignal,
    ): boolean => (
        principal.state === 'enabled'
        && principal.token !== null
        && principalsByToken.get(principal.token) === principal
        && currentPrincipalByScope.get(principal.scopeKey) === principal
        && !ingressSignal.aborted
        && !principal.retirementSignal.aborted
        && runtime.generation === principal.pluginGeneration
        && !runtime.retirementSignal.aborted
        && runtime.isCurrent()
        && (params.shouldCommit?.() ?? true)
    );

    return {
        createPrincipal(input: QualifiedExternalSessionHookPrincipalInput): Readonly<{
            principalRef: string;
            token: string;
        }> {
            const installationIdentity = normalizedId(input.installationIdentity);
            const machineId = normalizedId(input.machineId);
            const agentId = normalizedId(input.agentId);
            const pluginId = normalizedId(input.qualifiedContributionId.pluginId);
            const localId = normalizedId(input.qualifiedContributionId.localId);
            const variantId = normalizedId(input.variantId);
            const eventId = normalizedId(input.eventId);
            const pluginGeneration = normalizedId(input.pluginGeneration);
            if (
                !installationIdentity
                || !machineId
                || !agentId
                || !pluginId
                || !localId
                || !agentRoutingIdAddressesContributionIdentityV1(
                    agentId,
                    { pluginId, localId },
                )
                || !variantId
                || !eventId
                || !pluginGeneration
            ) {
                throw new Error('Invalid qualified External Session hook principal');
            }
            const qualifiedContributionId = Object.freeze({ pluginId, localId });
            const scopeKey = principalScopeKey({
                installationIdentity,
                machineId,
                agentId,
                qualifiedContributionId,
                variantId,
                eventId,
            });
            const previous = currentPrincipalByScope.get(scopeKey);
            if (previous) transition(previous, 'revoked');

            const persistedPrincipalRef = input.principalRef === undefined
                ? null
                : normalizedId(input.principalRef);
            const persistedToken = input.token === undefined
                ? null
                : /^[A-Za-z0-9_-]{43}$/u.test(input.token)
                    ? input.token
                    : null;
            if (
                (input.principalRef !== undefined && !persistedPrincipalRef)
                || (input.token !== undefined && !persistedToken)
            ) {
                throw new Error(
                    'Invalid persisted qualified External Session hook principal',
                );
            }
            const token =
                persistedToken ?? randomBytes(32).toString('base64url');
            const principalRef = persistedPrincipalRef ?? randomUUID();
            const previousByRef = principalsByRef.get(principalRef);
            if (previousByRef) transition(previousByRef, 'revoked');
            let principal!: Principal;
            const retire = () => transition(principal, 'generation_retired');
            input.retirementSignal.addEventListener('abort', retire, { once: true });
            principal = {
                principalRef,
                token,
                scopeKey,
                installationIdentity,
                machineId,
                agentId,
                qualifiedContributionId,
                variantId,
                eventId,
                pluginGeneration,
                retirementSignal: input.retirementSignal,
                ingressController: new AbortController(),
                state: input.retirementSignal.aborted
                    ? 'generation_retired'
                    : 'disabled',
                removeRetirementListener: () =>
                    input.retirementSignal.removeEventListener('abort', retire),
            };
            principalsByRef.set(principalRef, principal);
            if (principal.state !== 'generation_retired') {
                principalsByToken.set(token, principal);
                currentPrincipalByScope.set(scopeKey, principal);
            } else {
                principal.token = null;
                principal.ingressController.abort();
                principal.removeRetirementListener();
            }
            return Object.freeze({ principalRef, token });
        },

        readPrincipal(principalRef: string): Readonly<{ state: PrincipalState }> {
            return {
                state: principalsByRef.get(principalRef)?.state ?? 'revoked',
            };
        },

        enable(principalRef: string): Readonly<{ state: PrincipalState }> {
            const principal = principalsByRef.get(principalRef);
            if (!principal) return { state: 'revoked' };
            if (principal.state === 'disabled') {
                principal.ingressController = new AbortController();
                principal.state = 'enabled';
            }
            return { state: principal.state };
        },

        disable(principalRef: string): Readonly<{ state: PrincipalState }> {
            const principal = principalsByRef.get(principalRef);
            if (!principal) return { state: 'revoked' };
            if (principal.state === 'enabled') transition(principal, 'disabled');
            return { state: principal.state };
        },

        revoke(principalRef: string): Readonly<{ state: PrincipalState }> {
            const principal = principalsByRef.get(principalRef);
            if (!principal) return { state: 'revoked' };
            transition(principal, 'revoked');
            return { state: principal.state };
        },

        async handleAuthenticatedEvent(
            input: QualifiedExternalSessionHookDeliveryInput,
        ): Promise<QualifiedExternalSessionHookDeliveryResult> {
            const principal = principalsByToken.get(input.token);
            const totalDeadlineAtMs =
                input.forwardingStartedAtMs + TOTAL_FORWARDING_DEADLINE_MS;
            const receivedAtMs = now();
            if (
                !principal
                || principal.state !== 'enabled'
                || input.eventId !== principal.eventId
                || !Number.isSafeInteger(input.observedAtMs)
                || input.observedAtMs < 0
                || input.observedAtMs > receivedAtMs
                || !Number.isSafeInteger(input.forwardingStartedAtMs)
                || input.forwardingStartedAtMs < 0
                || input.forwardingStartedAtMs > receivedAtMs
                || totalDeadlineAtMs <= receivedAtMs
                || input.signal.aborted
            ) {
                return { state: 'rejected' };
            }
            const accountScopeKeyAtStart =
                params.readAccountScopeKey?.()?.trim() ?? null;
            if (params.readAccountScopeKey && !accountScopeKeyAtStart) {
                return { state: 'rejected' };
            }
            const isAccountScopeCurrent = (): boolean => (
                !params.readAccountScopeKey
                || params.readAccountScopeKey()?.trim() === accountScopeKeyAtStart
            );
            const isDeliveryCurrent = (
                currentPrincipal: Principal,
                currentRuntime: QualifiedExternalSessionHookRuntimeLease,
                currentIngressSignal: AbortSignal,
            ): boolean => (
                isAccountScopeCurrent()
                && isCurrent(
                    currentPrincipal,
                    currentRuntime,
                    currentIngressSignal,
                )
            );

            const ingressSignal = principal.ingressController.signal;
            const initial = composeDeliverySignal({
                signals: [
                    input.signal,
                    ingressSignal,
                    principal.retirementSignal,
                ],
                deadlineAtMs: totalDeadlineAtMs,
                now,
            });
            const runtime = await acquireBeforeAbort(
                async () => await params.acquireRuntime({
                    qualifiedContributionId: principal.qualifiedContributionId,
                    agentId: principal.agentId,
                    pluginGeneration: principal.pluginGeneration,
                    variantId: principal.variantId,
                }),
                initial.terminal,
            );
            initial.cleanup();
            if (
                !runtime
                || initial.signal.aborted
                || runtime.generation !== principal.pluginGeneration
                || runtime.retirementSignal.aborted
                || !runtime.isCurrent()
                || !isAccountScopeCurrent()
            ) {
                await runtime?.release().catch(() => undefined);
                return { state: 'rejected' };
            }

            const composed = composeDeliverySignal({
                signals: [
                    input.signal,
                    ingressSignal,
                    principal.retirementSignal,
                    runtime.retirementSignal,
                ],
                deadlineAtMs: totalDeadlineAtMs,
                now,
            });
            try {
                const variant = runtime.hooks.installationVariants.find(
                    (candidate) => candidate.variantId === principal.variantId,
                );
                const event = variant?.events.find(
                    (candidate) => candidate.eventId === principal.eventId,
                );
                if (
                    !variant
                    || !event
                    || input.eventId !== event.eventId
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                    || composed.signal.aborted
                ) {
                    return { state: 'rejected' };
                }

                let mapperRequest;
                try {
                    mapperRequest = validateAgentExternalSessionHookMapEventRequest({
                        installationIdentity: principal.installationIdentity,
                        variantId: principal.variantId,
                        eventId: principal.eventId,
                        observedAtMs: input.observedAtMs,
                        nativePayload: input.nativePayload,
                        signal: composed.signal,
                        deadlineAtMs: totalDeadlineAtMs,
                        maxSerializedBytes: MAP_EVENT_MAX_SERIALIZED_BYTES,
                    });
                } catch {
                    return { state: 'rejected' };
                }
                const rawMapped = await settleBeforeAbort(
                    () => runtime.hooks.mapHookEvent(mapperRequest),
                    composed.terminal,
                );
                if (
                    rawMapped === null
                    || composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                ) {
                    return { state: 'rejected' };
                }
                let mapped: AgentExternalSessionHookMapEventValue;
                try {
                    const validated =
                        validateAgentExternalSessionHookMapEventResult(rawMapped);
                    if (!validated.ok) return { state: 'rejected' };
                    mapped = validated.value;
                } catch {
                    return { state: 'rejected' };
                }
                if (mapped.kind === 'ignored') return { state: 'ignored' };

                const resolvedSourceEnvelope = await settleBeforeAbort(
                    () => runtime.externalSessions.resolveSource({
                        source: mapped.sourceInput,
                        signal: composed.signal,
                        deadlineAtMs: totalDeadlineAtMs,
                        maxSerializedBytes: EXTERNAL_SESSION_MAX_SERIALIZED_BYTES,
                    }),
                    composed.terminal,
                );
                const resolvedSource = parseResolvedSource(
                    readSuccessfulValue(resolvedSourceEnvelope),
                );
                if (
                    !resolvedSource
                    || composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                ) {
                    return { state: 'rejected' };
                }

                const resolvedIdentityEnvelope = await settleBeforeAbort(
                    () => runtime.externalSessions.resolveLinkIdentity({
                        source: resolvedSource,
                        remoteSessionId: mapped.remoteSessionId,
                        ...(mapped.linkData === undefined
                            ? {}
                            : { linkData: mapped.linkData }),
                        signal: composed.signal,
                        deadlineAtMs: totalDeadlineAtMs,
                        maxSerializedBytes: EXTERNAL_SESSION_MAX_SERIALIZED_BYTES,
                    }),
                    composed.terminal,
                );
                const resolvedIdentity = parseResolvedIdentity(
                    readSuccessfulValue(resolvedIdentityEnvelope),
                );
                if (
                    !resolvedIdentity
                    || !preservesExternalSessionSourceIdentity(
                        resolvedSource,
                        resolvedIdentity.source,
                    )
                    || resolvedIdentity.remoteSessionId !== mapped.remoteSessionId
                    || composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                ) {
                    return { state: 'rejected' };
                }

                const qualifiedIdentity =
                    buildLinkedExternalSessionQualifiedIdentityV1({
                        agent: principal.qualifiedContributionId,
                        sourceKind: resolvedIdentity.source.kind,
                    });
                const identity: ResolvedMappedIdentity = {
                    ...resolvedIdentity,
                    qualifiedIdentity,
                };
                const admitCurrentLink = async (currentLink: Readonly<{
                    sessionId: string;
                    linkGeneration: string;
                }>): Promise<QualifiedExternalSessionHookDeliveryResult> => {
                    const target = Object.freeze({
                        qualifiedLinkIdentity: qualifiedIdentity,
                        linkGeneration: currentLink.linkGeneration,
                    });
                    if (mapped.facts.length > 0) {
                        const admitted = await settleBeforeAbort(
                            () => params.admitFacts({
                                sessionId: currentLink.sessionId,
                                agentId: principal.agentId,
                                identity,
                                target,
                                facts: mapped.facts,
                                signal: composed.signal,
                                deadlineAtMs: totalDeadlineAtMs,
                                shouldCommit: () => (
                                    !composed.signal.aborted
                                    && isDeliveryCurrent(
                                        principal,
                                        runtime,
                                        ingressSignal,
                                    )
                                ),
                            }),
                            composed.terminal,
                        );
                        if (
                            admitted === null
                            || composed.signal.aborted
                            || !isDeliveryCurrent(
                                principal,
                                runtime,
                                ingressSignal,
                            )
                        ) {
                            return { state: 'rejected' };
                        }
                    }
                    return { state: 'admitted', facts: mapped.facts.length };
                };
                const currentLink = await settleBeforeAbort(
                    () => params.resolveCurrentLink({
                        machineId: principal.machineId,
                        agentId: principal.agentId,
                        identity,
                        signal: composed.signal,
                        deadlineAtMs: totalDeadlineAtMs,
                    }),
                    composed.terminal,
                );
                if (
                    composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                ) {
                    return { state: 'rejected' };
                }
                if (currentLink && 'sessionId' in currentLink) {
                    return await admitCurrentLink(currentLink);
                }
                if (
                    currentLink
                    && 'state' in currentLink
                    && currentLink.state === 'blocked'
                ) {
                    return { state: 'ignored' };
                }
                const indexedTagLookupProof =
                    currentLink
                    && 'state' in currentLink
                    && currentLink.state === 'absent'
                        ? currentLink.indexedTagLookupProof
                        : undefined;

                const policy = await settleBeforeAbort(
                    () => params.readAutoLinkPolicy({
                        machineId: principal.machineId,
                        agentId: principal.agentId,
                        qualifiedIdentity,
                        source: resolvedIdentity.source,
                    }),
                    composed.terminal,
                );
                if (
                    !policy
                    || composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                ) {
                    return { state: 'ignored' };
                }
                const ensureKey = JSON.stringify([
                    principal.pluginGeneration,
                    policy.accountScopeKey,
                    policy.sourcePolicyId,
                    policy.enabledAtMs,
                    policy.canonicalResolvedSourceKey,
                    principal.machineId,
                    principal.agentId,
                    qualifiedIdentity,
                    resolvedIdentity.source,
                    resolvedIdentity.remoteSessionId,
                    resolvedIdentity.linkData ?? null,
                ]);
                const currentCommitGuard = () => (
                    !composed.signal.aborted
                    && isDeliveryCurrent(
                        principal,
                        runtime,
                        ingressSignal,
                    )
                    && params.isAutoLinkPolicyCurrent({
                        machineId: principal.machineId,
                        qualifiedIdentity,
                        sourcePolicyId: policy.sourcePolicyId,
                        enabledAtMs: policy.enabledAtMs,
                        accountScopeKey: policy.accountScopeKey,
                    })
                );
                let inFlightEnsure = inFlightEnsures.get(ensureKey);
                if (!inFlightEnsure) {
                    if (!isDeliveryCurrent(
                        principal,
                        runtime,
                        ingressSignal,
                    )) {
                        return { state: 'rejected' };
                    }
                    const currentCommitGuards = new Set([currentCommitGuard]);
                    const effectController = new AbortController();
                    const promise = params.ensureLink({
                        machineId: principal.machineId,
                        agentId: principal.agentId,
                        qualifiedIdentity,
                        sourcePolicyId: policy.sourcePolicyId,
                        expectedSourceKey: policy.canonicalResolvedSourceKey,
                        source: resolvedIdentity.source,
                        remoteSessionId: resolvedIdentity.remoteSessionId,
                        linkData: resolvedIdentity.linkData,
                        storageMode: 'machine_only',
                        ...(indexedTagLookupProof
                            ? { indexedTagLookupProof }
                            : {}),
                        signal: effectController.signal,
                        deadlineAtMs: totalDeadlineAtMs,
                        shouldCommit: () => Array.from(
                            currentCommitGuards,
                        ).some((guard) => guard()),
                    });
                    inFlightEnsure = {
                        promise,
                        currentCommitGuards,
                        effectController,
                    };
                    inFlightEnsures.set(ensureKey, inFlightEnsure);
                    void promise.finally(() => {
                        if (inFlightEnsures.get(ensureKey) === inFlightEnsure) {
                            inFlightEnsures.delete(ensureKey);
                        }
                    }).catch(() => undefined);
                } else {
                    inFlightEnsure.currentCommitGuards.add(currentCommitGuard);
                }
                const abortEnsureWhenNoDeliveryIsCurrent = () => {
                    if (
                        !Array.from(inFlightEnsure.currentCommitGuards)
                            .some((guard) => guard())
                    ) {
                        inFlightEnsure.effectController.abort();
                    }
                };
                composed.signal.addEventListener(
                    'abort',
                    abortEnsureWhenNoDeliveryIsCurrent,
                    { once: true },
                );
                let linked: EnsuredLink | null;
                try {
                    linked = await settleBeforeAbort(
                        () => inFlightEnsure.promise,
                        composed.terminal,
                    );
                } finally {
                    composed.signal.removeEventListener(
                        'abort',
                        abortEnsureWhenNoDeliveryIsCurrent,
                    );
                    inFlightEnsure.currentCommitGuards.delete(
                        currentCommitGuard,
                    );
                    abortEnsureWhenNoDeliveryIsCurrent();
                }
                if (
                    !linked
                    || composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                ) {
                    return { state: 'rejected' };
                }
                const currentLinkAfterEnsure = await settleBeforeAbort(
                    () => params.resolveCurrentLink({
                        machineId: principal.machineId,
                        agentId: principal.agentId,
                        identity,
                        sessionId: linked.sessionId,
                        signal: composed.signal,
                        deadlineAtMs: totalDeadlineAtMs,
                    }),
                    composed.terminal,
                );
                if (
                    !currentLinkAfterEnsure
                    || !('sessionId' in currentLinkAfterEnsure)
                    || composed.signal.aborted
                    || !isDeliveryCurrent(principal, runtime, ingressSignal)
                    || !params.isAutoLinkPolicyCurrent({
                        machineId: principal.machineId,
                        qualifiedIdentity,
                        sourcePolicyId: policy.sourcePolicyId,
                        enabledAtMs: policy.enabledAtMs,
                        accountScopeKey: policy.accountScopeKey,
                    })
                ) {
                    return { state: 'rejected' };
                }
                return await admitCurrentLink(currentLinkAfterEnsure);
            } finally {
                composed.cleanup();
                await runtime.release().catch(() => undefined);
            }
        },
    };
}
