import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerProfileIdentifiersEquivalent } from '../server/serverProfiles';

import { isActionOperationTerminal, resolveActionOperationObservation, type ActionOperationObservation, type ActionOperationStoreSnapshot } from './actionOperationStore';
import {
    actionOperationAddressKey,
    actionOperationMachineAddressKey,
    actionOperationRequestAddressKey,
    actionOperationSessionAddressKey,
    normalizeActionOperationServerId,
    type ActionOperationAddress,
    type ActionOperationSessionAddress,
    type ActionOperationProjectWorkspaceQuery,
    type ActionOperationProjectScriptQuery,
    type ActionOperationManagedMachineQuery,
    type ActionOperationProjectServicesQuery,
    type QualifiedActionOperation,
} from './qualifiedActionOperation';

export type ActionOperationProjection = Readonly<{
    serverId: string;
    snapshot: ActionOperationSnapshotV1;
    observation: ActionOperationObservation;
    isUnavailableProjection: boolean;
    followUpAttention?: string | null;
}>;

export type InboxActionOperationReason = 'failed' | 'status_unavailable' | 'setup_needs_attention';

export type InboxActionOperationEntry = Readonly<{
    operation: ActionOperationProjection;
    reason: InboxActionOperationReason;
}>;

export type ActionOperationActivitySummary = Readonly<{
    activeCount: number;
    hasAttention: boolean;
}>;

export type InboxActionOperationSummary = Readonly<{
    count: number;
    hasAttention: boolean;
}>;

export type ActionOperationSelectors = Readonly<{
    selectAll(state: ActionOperationStoreSnapshot): readonly ActionOperationProjection[];
    selectById(state: ActionOperationStoreSnapshot, address: ActionOperationAddress): ActionOperationProjection | null;
    selectSnapshotByRequestId(
        state: ActionOperationStoreSnapshot,
        requestId: string,
        serverId: string | null,
        accountId?: string | null,
    ): ActionOperationSnapshotV1 | null;
    selectActive(state: ActionOperationStoreSnapshot): readonly ActionOperationProjection[];
    selectMachineReboots(state: ActionOperationStoreSnapshot, scope: Readonly<{ serverId: string; accountId: string }> | null): readonly ActionOperationProjection[];
    selectForSession(state: ActionOperationStoreSnapshot, address: ActionOperationSessionAddress): readonly ActionOperationProjection[];
    selectForProjectScript(state: ActionOperationStoreSnapshot, query: ActionOperationProjectScriptQuery): ActionOperationProjection | null;
    selectForProjectSetup(state: ActionOperationStoreSnapshot, query: ActionOperationProjectWorkspaceQuery): ActionOperationProjection | null;
    selectHeldProjectSetupReview(state: ActionOperationStoreSnapshot, query: ActionOperationProjectWorkspaceQuery): ActionOperationProjection | null;
    selectForManagedMachine(state: ActionOperationStoreSnapshot, query: ActionOperationManagedMachineQuery): ActionOperationProjection | null;
    selectForProjectServices(state: ActionOperationStoreSnapshot, query: ActionOperationProjectServicesQuery): readonly ActionOperationProjection[];
    selectInbox(state: ActionOperationStoreSnapshot): readonly InboxActionOperationEntry[];
    selectActivitySummary(state: ActionOperationStoreSnapshot): ActionOperationActivitySummary;
    selectInboxSummary(state: ActionOperationStoreSnapshot): InboxActionOperationSummary;
    selectHasUnseenTerminal(state: ActionOperationStoreSnapshot): boolean;
    selectHasAttention(state: ActionOperationStoreSnapshot): boolean;
}>;

const EMPTY_OPERATIONS: readonly ActionOperationProjection[] = Object.freeze([]);
const EMPTY_INBOX_OPERATIONS: readonly InboxActionOperationEntry[] = Object.freeze([]);

export type TerminalActionOperationQuery = Readonly<{
    serverId: string | null;
    accountId: string | null;
    machineId: string | null;
    terminalId: string | null;
}>;

/** Custody may live at the Source; match the PTY's actual execution target. */
export function selectTerminalActionOperationState(state: ActionOperationStoreSnapshot, query: TerminalActionOperationQuery): ActionOperationSnapshotV1['state'] | null {
    return selectTerminalActionOperation(state, query)?.snapshot.state ?? null;
}

export function selectTerminalActionOperation(state: ActionOperationStoreSnapshot, query: TerminalActionOperationQuery): QualifiedActionOperation | null {
    if (!query.serverId || !query.accountId || !query.machineId || !query.terminalId) return null;
    for (const operation of state.operationsByKey.values()) {
        const { snapshot } = operation;
        const output = snapshot.domainRef;
        if ((output?.kind === 'projectCommand' || output?.kind === 'machineEnvironment')
            && snapshot.scope.accountId === query.accountId
            && areServerProfileIdentifiersEquivalent(output.serverId, query.serverId)
            && output.machineId === query.machineId && output.terminalId === query.terminalId) return operation;
    }
    return null;
}

function hasSameItems<T>(current: readonly T[], next: readonly T[]): boolean {
    return current.length === next.length && current.every((item, index) => item === next[index]);
}

function compareOperations(a: ActionOperationProjection, b: ActionOperationProjection): number {
    const aActive = !isActionOperationTerminal(a.snapshot.state);
    const bActive = !isActionOperationTerminal(b.snapshot.state);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive) return b.snapshot.createdAt - a.snapshot.createdAt;
    return (b.snapshot.settledAt ?? b.snapshot.createdAt) - (a.snapshot.settledAt ?? a.snapshot.createdAt);
}

/** An active Move owns its nested native Start and the Service's recovery controls. */
export function compareProjectServiceActionOperations(a: ActionOperationProjection, b: ActionOperationProjection): number {
    if (!isActionOperationTerminal(a.snapshot.state) && !isActionOperationTerminal(b.snapshot.state)) {
        const aMove = a.snapshot.actionId === 'projects.service.relocate';
        const bMove = b.snapshot.actionId === 'projects.service.relocate';
        if (aMove !== bMove) return aMove ? -1 : 1;
    }
    return compareOperations(a, b);
}

function isUnseen(
    state: ActionOperationStoreSnapshot,
    operation: Pick<ActionOperationProjection, 'serverId' | 'snapshot'>,
): boolean {
    if (!isActionOperationTerminal(operation.snapshot.state)) return false;
    const key = actionOperationAddressKey({ serverId: operation.serverId, operationId: operation.snapshot.operationId });
    const seen = state.seenAtByOperationKey.get(key);
    return seen === undefined || operation.snapshot.revision > seen.revision;
}

function shouldIncludeOperation(
    state: ActionOperationStoreSnapshot,
    key: string,
    operation: QualifiedActionOperation,
): boolean {
    return !(
        (operation.snapshot.state === 'succeeded'
            && state.dismissedRecentOperationKeys.has(key)
            && readFollowUpAttention(state, operation) === null)
        || (state.unavailableOperationKeys.has(key) && state.dismissedUnavailableOperationKeys.has(key))
    );
}

function readOperationObservation(
    state: ActionOperationStoreSnapshot,
    key: string,
    operation: QualifiedActionOperation,
): ActionOperationObservation {
    if (state.unavailableOperationKeys.has(key)) return 'unavailable';
    return resolveActionOperationObservation(operation.snapshot, state.machineObservationByKey.get(actionOperationMachineAddressKey({
        serverId: operation.serverId,
        machineId: operation.snapshot.scope.machineId,
    })) ?? 'unavailable');
}

function readFollowUpAttention(
    state: ActionOperationStoreSnapshot,
    operation: QualifiedActionOperation,
): string | null {
    const snapshot = operation.snapshot;
    return snapshot.requestId
        ? state.followUpAttentionByRequestKey.get(actionOperationRequestAddressKey({
            serverId: operation.serverId,
            accountId: snapshot.scope.accountId,
            requestId: snapshot.requestId,
        })) ?? null
        : null;
}

export function createActionOperationSelectors(): ActionOperationSelectors {
    let previousState: ActionOperationStoreSnapshot | null = null;
    let previousAll: readonly ActionOperationProjection[] = EMPTY_OPERATIONS;
    let previousActive: readonly ActionOperationProjection[] = EMPTY_OPERATIONS;
    let previousMachineReboots: readonly ActionOperationProjection[] = EMPTY_OPERATIONS;
    let previousMachineRebootsState: ActionOperationStoreSnapshot | null = null;
    let previousMachineRebootScope: Readonly<{ serverId: string; accountId: string }> | null = null;
    let previousInbox: readonly InboxActionOperationEntry[] = EMPTY_INBOX_OPERATIONS;
    let previousActivitySummaryState: ActionOperationStoreSnapshot | null = null;
    let previousActivitySummary: ActionOperationActivitySummary = Object.freeze({ activeCount: 0, hasAttention: false });
    let previousInboxSummaryState: ActionOperationStoreSnapshot | null = null;
    let previousInboxSummary: InboxActionOperationSummary = Object.freeze({ count: 0, hasAttention: false });
    const projectionCache = new WeakMap<QualifiedActionOperation, ActionOperationProjection>();
    const sessionCache = new Map<string, readonly ActionOperationProjection[]>();
    const serviceCache = new Map<string, readonly ActionOperationProjection[]>();

    const readProjection = (state: ActionOperationStoreSnapshot, key: string, operation: QualifiedActionOperation): ActionOperationProjection => {
        const snapshot = operation.snapshot;
        const isUnavailableProjection = state.unavailableOperationKeys.has(key);
        const observation = readOperationObservation(state, key, operation);
        const followUpAttention = readFollowUpAttention(state, operation);
        const cached = projectionCache.get(operation);
        if (
            cached?.snapshot === snapshot
            && cached.serverId === operation.serverId
            && cached.observation === observation
            && cached.isUnavailableProjection === isUnavailableProjection
            && cached.followUpAttention === followUpAttention
        ) return cached;
        const projection = Object.freeze({ serverId: operation.serverId, snapshot, observation, isUnavailableProjection, followUpAttention });
        projectionCache.set(operation, projection);
        return projection;
    };

    const selectAll = (state: ActionOperationStoreSnapshot): readonly ActionOperationProjection[] => {
        if (state === previousState) return previousAll;
        const next = Array.from(state.operationsByKey.entries())
            .filter(([key, operation]) => shouldIncludeOperation(state, key, operation))
            .map(([key, operation]) => readProjection(state, key, operation))
            .sort(compareOperations);
        const nextAll = next.length === 0
            ? EMPTY_OPERATIONS
            : hasSameItems(previousAll, next) ? previousAll : Object.freeze(next);
        const active = nextAll.filter((operation) => !isActionOperationTerminal(operation.snapshot.state));
        previousState = state;
        previousAll = nextAll;
        previousActive = active.length === 0
            ? EMPTY_OPERATIONS
            : hasSameItems(previousActive, active) ? previousActive : Object.freeze(active);
        return previousAll;
    };

    const selectMachineReboots = (state: ActionOperationStoreSnapshot, scope: Readonly<{ serverId: string; accountId: string }> | null): readonly ActionOperationProjection[] => {
        if (state === previousMachineRebootsState && scope === previousMachineRebootScope) return previousMachineReboots;
        // Dismissal affects Activity visibility, not a retained operation's subject.
        const next = [...state.operationsByKey.entries()]
            .filter(([, operation]) => scope && operation.snapshot.actionId === 'machines.reboot'
                && operation.snapshot.scope.accountId === scope.accountId
                && areServerProfileIdentifiersEquivalent(operation.serverId, scope.serverId))
            .map(([key, operation]) => readProjection(state, key, operation))
            .sort(compareOperations);
        previousMachineRebootsState = state;
        previousMachineRebootScope = scope;
        if (!hasSameItems(previousMachineReboots, next)) previousMachineReboots = Object.freeze(next);
        return previousMachineReboots;
    };

    const selectById = (state: ActionOperationStoreSnapshot, address: ActionOperationAddress) => {
        const serverId = normalizeActionOperationServerId(address.serverId);
        if (!serverId) return null;
        const key = actionOperationAddressKey({ ...address, serverId });
        const operation = state.operationsByKey.get(key);
        // Dismissal changes Activity visibility, not an explicit qualified record lookup.
        return operation ? readProjection(state, key, operation) : null;
    };

    const selectProjectOperation = (
        state: ActionOperationStoreSnapshot,
        query: ActionOperationProjectWorkspaceQuery,
        matches: (snapshot: ActionOperationSnapshotV1) => boolean,
    ): ActionOperationProjection | null => {
        const serverId = normalizeActionOperationServerId(query.workspace.serverId);
        const rootPath = normalizeWorkspaceRootPathV1(query.workspace.rootPath);
        if (!serverId || !query.accountId || !rootPath) return null;
        selectAll(state);
        let selected: ActionOperationProjection | null = null;
        for (const [key, operation] of state.operationsByKey) {
            const snapshot = operation.snapshot;
            const attachment = snapshot.domainRef;
            if (operation.serverId !== serverId || snapshot.scope.accountId !== query.accountId || attachment?.kind !== 'projectCommand') continue;
            const source = attachment.sourceWorkspace;
            if (!source || source.serverId !== serverId || source.machineId !== query.workspace.machineId
                || source.workspaceId !== query.workspace.workspaceId || normalizeWorkspaceRootPathV1(source.rootPath) !== rootPath
                || !matches(snapshot)) continue;
            // Activity dismissal affects Activity, not the checkout's last/current run.
            const projection = readProjection(state, key, operation);
            const order = selected ? compareOperations(projection, selected) : -1;
            if (!selected || order < 0 || (order === 0 && key < actionOperationAddressKey({ serverId: selected.serverId, operationId: selected.snapshot.operationId }))) selected = projection;
        }
        return selected;
    };

    const selectForProjectScript = (state: ActionOperationStoreSnapshot, query: ActionOperationProjectScriptQuery) => selectProjectOperation(state, query, snapshot => {
        const attachment = snapshot.domainRef;
        if (snapshot.actionId !== 'projects.script.run' || attachment?.kind !== 'projectCommand' || !attachment.script) return false;
        return query.selection.kind === 'named'
            ? attachment.script.name === query.selection.name
            : attachment.script.name === undefined && attachment.script.source.kind !== 'command'
                && isSameInputOptionValue(attachment.script.source, query.selection.source);
    });

    const selectForProjectSetup = (state: ActionOperationStoreSnapshot, query: ActionOperationProjectWorkspaceQuery) => selectProjectOperation(state, query, snapshot => (
        snapshot.actionId === 'projects.prepare' && snapshot.domainRef?.kind === 'projectCommand'
        && snapshot.domainRef.purpose === 'setup' && snapshot.domainRef.script === undefined
    ));

    /** The setup review this checkout is waiting on, whichever standalone preparation or Script run holds it. */
    const selectHeldProjectSetupReview = (state: ActionOperationStoreSnapshot, query: ActionOperationProjectWorkspaceQuery) => selectProjectOperation(state, query, snapshot => (
        !isActionOperationTerminal(snapshot.state) && snapshot.setupReview !== undefined
    ));

    const selectForProjectServices = (state: ActionOperationStoreSnapshot, query: ActionOperationProjectServicesQuery) => {
        const serverId = normalizeActionOperationServerId(query.serverId);
        if (!serverId || !query.accountId) return EMPTY_OPERATIONS;
        const key = JSON.stringify([serverId, query.accountId, query.machineId, query.refId]);
        const services = new Map<string, ActionOperationProjection>();
        for (const operation of selectAll(state)) {
            const { snapshot } = operation;
            const domain = snapshot.domainRef;
            if (operation.serverId !== serverId || snapshot.scope.accountId !== query.accountId
                || (snapshot.actionId !== 'projects.service.relocate' && snapshot.actionId !== 'localServices.launcher.start')
                || (snapshot.actionId === 'projects.service.relocate' && snapshot.scope.machineId !== query.machineId)
                || domain?.kind !== 'projectService' || domain.declaration.selection.kind !== 'manifest') continue;
            const sourceMatches = domain.sourceWorkspace
                ? areServerProfileIdentifiersEquivalent(domain.sourceWorkspace.serverId, serverId) && domain.sourceWorkspace.refId === query.refId
                : areServerProfileIdentifiersEquivalent(domain.workspace.serverId, serverId) && domain.workspace.machineId === query.machineId
                    && domain.workspace.workspaceId === query.refId;
            if (!sourceMatches) continue;
            const name = domain.declaration.selection.name;
            const selected = services.get(name);
            if (!selected || compareProjectServiceActionOperations(operation, selected) < 0) services.set(name, operation);
        }
        const next = [...services.values()];
        const previous = serviceCache.get(key) ?? EMPTY_OPERATIONS;
        const result = hasSameItems(previous, next) ? previous : Object.freeze(next);
        serviceCache.set(key, result);
        return result;
    };

    const selectForManagedMachine = (state: ActionOperationStoreSnapshot, query: ActionOperationManagedMachineQuery) => {
        const serverId = normalizeActionOperationServerId(query.serverId);
        if (!serverId || !query.accountId || !query.machineId || !query.managedId) return null;
        selectAll(state);
        let selected: ActionOperationProjection | null = null;
        for (const [key, operation] of state.operationsByKey) {
            const snapshot = operation.snapshot;
            if (operation.serverId !== serverId || snapshot.scope.accountId !== query.accountId) continue;
            const attachment = snapshot.domainRef;
            const isCreation = snapshot.actionId === 'machines.managed.acquire' || snapshot.actionId === 'machines.managed.bootstrap.retry';
            const managed = snapshot.scope.machineId === query.machineId && attachment?.kind === 'managedMachine'
                && attachment.id === query.managedId;
            const setupScope = snapshot.actionId === 'machines.environment.apply' && snapshot.scope.machineId === query.enrolledMachineId
                || isCreation && snapshot.scope.machineId === query.machineId;
            const setup = Boolean(query.homeId && query.enrolledMachineId) && setupScope && attachment?.kind === 'machineEnvironment'
                && attachment.serverId === query.homeId && attachment.machineId === query.enrolledMachineId && attachment.managedId === query.managedId;
            if (!managed && !setup) continue;
            // An explicit resource detail retains its observed operation after Activity dismissal.
            if (!selected || snapshot.createdAt > selected.snapshot.createdAt
                || snapshot.createdAt === selected.snapshot.createdAt && snapshot.operationId < selected.snapshot.operationId) {
                selected = readProjection(state, key, operation);
            }
        }
        return selected;
    };

    const selectSnapshotByRequestId = (
        state: ActionOperationStoreSnapshot,
        requestId: string,
        serverId: string | null,
        accountId?: string | null,
    ): ActionOperationSnapshotV1 | null => {
        const normalizedRequestId = requestId.trim();
        const normalizedServerId = normalizeActionOperationServerId(serverId);
        const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : '';
        if (!normalizedRequestId || !normalizedServerId) return null;
        let match: ActionOperationSnapshotV1 | null = null;
        for (const operation of state.operationsByKey.values()) {
            const snapshot = operation.snapshot;
            if (operation.serverId !== normalizedServerId || snapshot.requestId !== normalizedRequestId) continue;
            if (normalizedAccountId && snapshot.scope.accountId !== normalizedAccountId) continue;
            if (match) return null;
            match = snapshot;
        }
        return match;
    };

    const selectActive = (state: ActionOperationStoreSnapshot) => {
        selectAll(state);
        return previousActive;
    };

    const selectForSession = (state: ActionOperationStoreSnapshot, address: ActionOperationSessionAddress) => {
        const normalizedServerId = normalizeActionOperationServerId(address.serverId);
        if (!normalizedServerId || address.accountId === null || address.accountId === '') return EMPTY_OPERATIONS;
        const cacheKey = actionOperationSessionAddressKey({ ...address, serverId: normalizedServerId });
        const operations = selectAll(state).filter((operation) => (
            operation.serverId === normalizedServerId && operation.snapshot.scope.sessionId === address.sessionId
            && (address.accountId === undefined || operation.snapshot.scope.accountId === address.accountId)
        ));
        const cached = sessionCache.get(cacheKey) ?? EMPTY_OPERATIONS;
        const stable = operations.length === 0
            ? EMPTY_OPERATIONS
            : hasSameItems(cached, operations) ? cached : Object.freeze(operations);
        sessionCache.set(cacheKey, stable);
        return stable;
    };

    const selectInbox = (state: ActionOperationStoreSnapshot): readonly InboxActionOperationEntry[] => {
        const next = selectAll(state).flatMap((operation): readonly InboxActionOperationEntry[] => {
            if (operation.snapshot.state === 'failed' && isUnseen(state, operation)) {
                return [{ operation, reason: 'failed' }];
            }
            if (
                operation.snapshot.state === 'succeeded'
                && operation.followUpAttention !== null
            ) {
                return [{ operation, reason: 'setup_needs_attention' }];
            }
            if (
                (operation.snapshot.state === 'accepted' || operation.snapshot.state === 'running')
                && operation.isUnavailableProjection
            ) {
                return [{ operation, reason: 'status_unavailable' }];
            }
            return [];
        });
        if (next.length === 0) {
            previousInbox = EMPTY_INBOX_OPERATIONS;
            return previousInbox;
        }
        if (
            previousInbox.length === next.length
            && previousInbox.every((entry, index) => (
                entry.operation === next[index]?.operation && entry.reason === next[index]?.reason
            ))
        ) return previousInbox;
        previousInbox = Object.freeze(next.map((entry) => Object.freeze(entry)));
        return previousInbox;
    };

    const selectHasUnseenTerminal = (state: ActionOperationStoreSnapshot) => selectAll(state).some((operation) => isUnseen(state, operation));
    const selectHasAttention = (state: ActionOperationStoreSnapshot) => (
        selectActive(state).length > 0
        || selectHasUnseenTerminal(state)
        || selectAll(state).some((operation) => operation.followUpAttention !== null)
    );

    const selectActivitySummary = (state: ActionOperationStoreSnapshot): ActionOperationActivitySummary => {
        if (state === previousActivitySummaryState) return previousActivitySummary;
        let activeCount = 0;
        let hasAttention = false;
        for (const [key, operation] of state.operationsByKey) {
            if (!shouldIncludeOperation(state, key, operation)) continue;
            const snapshot = operation.snapshot;
            if (!isActionOperationTerminal(snapshot.state)) {
                hasAttention = true;
                if (readOperationObservation(state, key, operation) === 'available') activeCount += 1;
                continue;
            }
            if (isUnseen(state, operation) || readFollowUpAttention(state, operation) !== null) {
                hasAttention = true;
            }
        }
        previousActivitySummaryState = state;
        if (
            previousActivitySummary.activeCount !== activeCount
            || previousActivitySummary.hasAttention !== hasAttention
        ) {
            previousActivitySummary = Object.freeze({ activeCount, hasAttention });
        }
        return previousActivitySummary;
    };

    const selectInboxSummary = (state: ActionOperationStoreSnapshot): InboxActionOperationSummary => {
        if (state === previousInboxSummaryState) return previousInboxSummary;
        let count = 0;
        for (const [key, operation] of state.operationsByKey) {
            if (!shouldIncludeOperation(state, key, operation)) continue;
            const snapshot = operation.snapshot;
            if (
                (snapshot.state === 'failed' && isUnseen(state, operation))
                || (snapshot.state === 'succeeded' && readFollowUpAttention(state, operation) !== null)
                || (!isActionOperationTerminal(snapshot.state) && state.unavailableOperationKeys.has(key))
            ) {
                count += 1;
            }
        }
        previousInboxSummaryState = state;
        if (previousInboxSummary.count !== count) {
            previousInboxSummary = Object.freeze({ count, hasAttention: count > 0 });
        }
        return previousInboxSummary;
    };

    return {
        selectAll,
        selectById,
        selectSnapshotByRequestId,
        selectActive,
        selectMachineReboots,
        selectForSession,
        selectForProjectScript,
        selectForProjectSetup,
        selectHeldProjectSetupReview,
        selectForManagedMachine,
        selectForProjectServices,
        selectInbox,
        selectActivitySummary,
        selectInboxSummary,
        selectHasUnseenTerminal,
        selectHasAttention,
    };
}

export const actionOperationSelectors = createActionOperationSelectors();
