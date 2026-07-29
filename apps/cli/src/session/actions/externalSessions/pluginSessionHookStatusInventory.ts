import {
    PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
    PluginSessionHookStatusResponseV1Schema,
    type PluginContributionIdentityV1,
    type PluginSessionHookInstallationStatusV1,
    type PluginSessionHookStatusInputV1,
    type PluginSessionHookStatusResponseV1,
} from '@happier-dev/protocol';

import type {
    ExternalSessionHookInstallationInventoryPageResult,
    ExternalSessionHookInstallationInventoryRecord,
} from './hookInstallationConfiguration';

type CursorScope = Readonly<{
    intent: 'passive_inventory';
    machineId: string;
    agentKey: string | null;
}>;

type PassiveStatusInput = Extract<
    PluginSessionHookStatusInputV1,
    { intent: 'passive_inventory' }
>;

type StatusInventoryCursor =
    | Readonly<{
        v: 5;
        scope: CursorScope;
        phase: 'filtered';
        cursor?: string;
        emitted: boolean;
    }>
    | Readonly<{
        v: 5;
        scope: CursorScope;
        phase: 'custody';
        cursor?: string;
    }>
    | Readonly<{
        v: 5;
        scope: CursorScope;
        phase: 'current';
        afterAgentKey: string | null;
        currentAgentKey?: string;
        cursor?: string;
        hasCustody: boolean;
    }>;

const MAX_CUSTODY_PAGES_PER_RESPONSE = 100;

export type PluginSessionHookStatusInventoryDependencies = Readonly<{
    listCurrentAgents(): readonly PluginContributionIdentityV1[];
    readCustodyPage(input: Readonly<{
        qualifiedAgent?: PluginContributionIdentityV1;
        cursor?: string;
        limit: number;
    }>): Promise<ExternalSessionHookInstallationInventoryPageResult>;
    resolveCurrentStatus(input: Readonly<{
        agent: PluginContributionIdentityV1;
        custody: ExternalSessionHookInstallationInventoryRecord | null;
    }>): Promise<PluginSessionHookInstallationStatusV1>;
}>;

type InventoryRow = Readonly<{
    agent: PluginContributionIdentityV1;
    status: PluginSessionHookInstallationStatusV1;
}>;

type InventoryDiagnostic = Readonly<{
    code:
        | 'installation_record_invalid'
        | 'installation_record_read_failed';
    retryable: boolean;
}>;

function agentKey(agent: PluginContributionIdentityV1): string {
    return JSON.stringify([agent.pluginId, agent.localId]);
}

function compareAgentKeys(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function scopeFor(input: PassiveStatusInput): CursorScope {
    return {
        intent: input.intent,
        machineId: input.machineId,
        agentKey: input.agent ? agentKey(input.agent) : null,
    };
}

function scopesMatch(left: CursorScope, right: CursorScope): boolean {
    return left.intent === right.intent
        && left.machineId === right.machineId
        && left.agentKey === right.agentKey;
}

function encodeCursor(cursor: StatusInventoryCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseScope(value: unknown): CursorScope | null {
    if (
        typeof value !== 'object'
        || value === null
        || (
            (value as Record<string, unknown>).intent !== 'passive_inventory'
        )
        || typeof (value as Record<string, unknown>).machineId !== 'string'
    ) {
        return null;
    }
    const raw = value as Record<string, unknown>;
    if (raw.agentKey !== null && typeof raw.agentKey !== 'string') {
        return null;
    }
    return {
        intent: raw.intent as CursorScope['intent'],
        machineId: raw.machineId as string,
        agentKey: raw.agentKey as string | null,
    };
}

function optionalCustodyCursor(
    parsed: Record<string, unknown>,
): string | undefined | null {
    if (parsed.cursor === undefined) return undefined;
    return typeof parsed.cursor === 'string'
        && parsed.cursor.length > 0
        && parsed.cursor.length <= 4_096
        ? parsed.cursor
        : null;
}

function decodeCursor(
    value: string | undefined,
    scope: CursorScope,
): StatusInventoryCursor | null {
    if (value === undefined) {
        return scope.agentKey === null
            ? {
                v: 5,
                scope,
                phase: 'custody',
            }
            : {
                v: 5,
                scope,
                phase: 'filtered',
                emitted: false,
            };
    }
    try {
        const raw = Buffer.from(value, 'base64url');
        if (raw.toString('base64url') !== value) return null;
        const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        const parsedScope = parseScope(parsed.scope);
        const cursor = optionalCustodyCursor(parsed);
        if (
            parsed.v !== 5
            || !parsedScope
            || !scopesMatch(parsedScope, scope)
            || cursor === null
        ) {
            return null;
        }
        if (
            parsed.phase === 'filtered'
            && scope.agentKey !== null
            && typeof parsed.emitted === 'boolean'
        ) {
            return {
                v: 5,
                scope,
                phase: 'filtered',
                emitted: parsed.emitted,
                ...(cursor ? { cursor } : {}),
            };
        }
        if (
            parsed.phase === 'custody'
            && scope.agentKey === null
        ) {
            return {
                v: 5,
                scope,
                phase: 'custody',
                ...(cursor ? { cursor } : {}),
            };
        }
        if (
            parsed.phase === 'current'
            && scope.agentKey === null
            && (
                parsed.afterAgentKey === null
                || typeof parsed.afterAgentKey === 'string'
            )
            && (
                parsed.currentAgentKey === undefined
                || typeof parsed.currentAgentKey === 'string'
            )
            && typeof parsed.hasCustody === 'boolean'
        ) {
            return {
                v: 5,
                scope,
                phase: 'current',
                afterAgentKey: parsed.afterAgentKey as string | null,
                ...(typeof parsed.currentAgentKey === 'string'
                    ? { currentAgentKey: parsed.currentAgentKey }
                    : {}),
                hasCustody: parsed.hasCustody,
                ...(cursor ? { cursor } : {}),
            };
        }
        return null;
    } catch {
        return null;
    }
}

function mapCustodyStatus(
    record: ExternalSessionHookInstallationInventoryRecord,
    current: boolean,
): PluginSessionHookInstallationStatusV1 {
    if (!current) {
        return {
            state: 'unavailable',
            installationId: record.installationId,
        };
    }
    if (record.state === 'active') {
        return {
            state: 'installed_enabled',
            installationId: record.installationId,
        };
    }
    if (record.state === 'disabled') {
        return {
            state: 'installed_disabled',
            installationId: record.installationId,
        };
    }
    return {
        state: 'needs_attention',
        installationId: record.installationId,
        diagnostic: {
            code: 'hook_installation_reconciliation_required',
            severity: 'error',
        },
    };
}

function mapDiagnostics(
    result: Extract<ExternalSessionHookInstallationInventoryPageResult, { ok: true }>,
): readonly InventoryDiagnostic[] {
    return result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code === 'invalid_record'
            ? 'installation_record_invalid' as const
            : 'installation_record_read_failed' as const,
        retryable: diagnostic.code === 'record_read_failed',
    }));
}

function operationFailure(): PluginSessionHookStatusResponseV1 {
    return {
        ok: false,
        diagnostic: {
            code: 'operation_failed',
            retryable: true,
        },
    };
}

function success(input: Readonly<{
    rows: readonly InventoryRow[];
    nextCursor: StatusInventoryCursor | null;
    diagnostics: readonly InventoryDiagnostic[];
}>): PluginSessionHookStatusResponseV1 {
    const parsed = PluginSessionHookStatusResponseV1Schema.safeParse({
        ok: true,
        rows: input.rows,
        nextCursor: input.nextCursor
            ? encodeCursor(input.nextCursor)
            : null,
        diagnostics: input.diagnostics.slice(0, 32),
    });
    return parsed.success ? parsed.data : operationFailure();
}

async function projectFilteredInventory(
    input: PassiveStatusInput & Readonly<{
        agent: PluginContributionIdentityV1;
    }>,
    current: boolean,
    cursor: Extract<StatusInventoryCursor, { phase: 'filtered' }>,
    dependencies: PluginSessionHookStatusInventoryDependencies,
): Promise<PluginSessionHookStatusResponseV1> {
    const limit = input.limit
        ?? PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT;
    const rows: InventoryRow[] = [];
    const diagnostics: InventoryDiagnostic[] = [];
    let custodyCursor = cursor.cursor;
    let emitted = cursor.emitted;
    const seenCursors = new Set<string>();

    for (
        let pageIndex = 0;
        pageIndex < MAX_CUSTODY_PAGES_PER_RESPONSE;
        pageIndex += 1
    ) {
        const page = await dependencies.readCustodyPage({
            qualifiedAgent: input.agent,
            ...(custodyCursor ? { cursor: custodyCursor } : {}),
            limit: Math.max(1, limit - rows.length),
        });
        if (!page.ok) return operationFailure();
        diagnostics.push(...mapDiagnostics(page));
        for (const record of page.records) {
            if (record.machineId !== input.machineId) continue;
            rows.push({
                agent: input.agent,
                status: current
                    ? await dependencies.resolveCurrentStatus({
                        agent: input.agent,
                        custody: record,
                    })
                    : mapCustodyStatus(record, false),
            });
        }
        emitted ||= rows.length > 0;
        const next = page.nextCursor;
        if (!next) {
            if (!emitted && current) {
                rows.push({
                    agent: input.agent,
                    status: await dependencies.resolveCurrentStatus({
                        agent: input.agent,
                        custody: null,
                    }),
                });
            }
            return success({ rows, nextCursor: null, diagnostics });
        }
        if (seenCursors.has(next)) return operationFailure();
        seenCursors.add(next);
        custodyCursor = next;
        if (rows.length >= limit) {
            return success({
                rows,
                nextCursor: {
                    v: 5,
                    scope: cursor.scope,
                    phase: 'filtered',
                    cursor: next,
                    emitted,
                },
                diagnostics,
            });
        }
        if (pageIndex + 1 === MAX_CUSTODY_PAGES_PER_RESPONSE) {
            return success({
                rows,
                nextCursor: {
                    v: 5,
                    scope: cursor.scope,
                    phase: 'filtered',
                    cursor: next,
                    emitted,
                },
                diagnostics,
            });
        }
    }
    return operationFailure();
}

export async function projectPluginSessionHookStatusInventory(
    input: PassiveStatusInput,
    dependencies: PluginSessionHookStatusInventoryDependencies,
): Promise<PluginSessionHookStatusResponseV1> {
    const limit = input.limit
        ?? PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT;
    const currentAgents = [...new Map(
        dependencies.listCurrentAgents()
            .map((agent) => [agentKey(agent), agent] as const),
    ).values()].sort((left, right) =>
        compareAgentKeys(agentKey(left), agentKey(right)));
    const currentAgentsByKey = new Map(
        currentAgents.map((agent) => [agentKey(agent), agent] as const),
    );
    const scope = scopeFor(input);
    const decoded = decodeCursor(input.cursor, scope);
    if (!decoded) return operationFailure();

    if (input.agent) {
        if (decoded.phase !== 'filtered') return operationFailure();
        return await projectFilteredInventory(
            { ...input, agent: input.agent },
            currentAgentsByKey.has(agentKey(input.agent)),
            decoded,
            dependencies,
        );
    }
    if (decoded.phase === 'filtered') return operationFailure();

    const rows: InventoryRow[] = [];
    const diagnostics: InventoryDiagnostic[] = [];
    let phase: 'custody' | 'current' = decoded.phase;
    let custodyCursor = decoded.cursor;
    let afterAgentKey = decoded.phase === 'current'
        ? decoded.afterAgentKey
        : null;
    let currentAgentKey = decoded.phase === 'current'
        ? decoded.currentAgentKey
        : undefined;
    let hasCustodyForCurrentAgent = decoded.phase === 'current'
        ? decoded.hasCustody
        : false;
    const seenCursors = new Set<string>();
    let pagesRead = 0;

    while (
        phase === 'custody'
        && pagesRead < MAX_CUSTODY_PAGES_PER_RESPONSE
    ) {
        const page = await dependencies.readCustodyPage({
            ...(custodyCursor ? { cursor: custodyCursor } : {}),
            limit: Math.max(1, limit - rows.length),
        });
        pagesRead += 1;
        if (!page.ok) return operationFailure();
        diagnostics.push(...mapDiagnostics(page));
        for (const record of page.records) {
            if (record.machineId !== input.machineId) continue;
            const currentAgent = currentAgentsByKey.get(
                agentKey(record.qualifiedAgent),
            );
            rows.push({
                agent: record.qualifiedAgent,
                status: currentAgent
                    ? await dependencies.resolveCurrentStatus({
                        agent: currentAgent,
                        custody: record,
                    })
                    : mapCustodyStatus(record, false),
            });
        }
        const next = page.nextCursor;
        if (next) {
            if (seenCursors.has(next)) return operationFailure();
            seenCursors.add(next);
            custodyCursor = next;
            if (rows.length >= limit) {
                return success({
                    rows,
                    nextCursor: {
                        v: 5,
                        scope,
                        phase: 'custody',
                        cursor: next,
                    },
                    diagnostics,
                });
            }
            continue;
        }
        phase = 'current';
        custodyCursor = undefined;
        seenCursors.clear();
    }
    if (phase === 'custody') {
        if (!custodyCursor) return operationFailure();
        return success({
            rows,
            nextCursor: {
                v: 5,
                scope,
                phase: 'custody',
                cursor: custodyCursor,
            },
            diagnostics,
        });
    }
    if (rows.length >= limit) {
        return success({
            rows,
            nextCursor: {
                v: 5,
                scope,
                phase: 'current',
                afterAgentKey,
                hasCustody: false,
            },
            diagnostics,
        });
    }

    while (pagesRead < MAX_CUSTODY_PAGES_PER_RESPONSE) {
        let agent = currentAgentKey
            ? currentAgents.find(
                (candidate) => agentKey(candidate) === currentAgentKey,
            )
            : currentAgents.find(
                (candidate) => (
                    afterAgentKey === null
                    || compareAgentKeys(
                        agentKey(candidate),
                        afterAgentKey,
                    ) > 0
                ),
            );
        if (!agent && currentAgentKey) {
            afterAgentKey = currentAgentKey;
            currentAgentKey = undefined;
            custodyCursor = undefined;
            hasCustodyForCurrentAgent = false;
            seenCursors.clear();
            agent = currentAgents.find(
                (candidate) =>
                    compareAgentKeys(
                        agentKey(candidate),
                        afterAgentKey!,
                    ) > 0,
            );
        }
        if (!agent) {
            return success({ rows, nextCursor: null, diagnostics });
        }
        const selectedAgentKey = agentKey(agent);
        const page = await dependencies.readCustodyPage({
            qualifiedAgent: agent,
            ...(custodyCursor ? { cursor: custodyCursor } : {}),
            limit: 1,
        });
        pagesRead += 1;
        if (!page.ok) return operationFailure();
        for (const record of page.records) {
            if (record.machineId === input.machineId) {
                hasCustodyForCurrentAgent = true;
            }
        }
        const next = page.nextCursor;
        if (next) {
            if (seenCursors.has(next)) return operationFailure();
            seenCursors.add(next);
            custodyCursor = next;
            if (pagesRead === MAX_CUSTODY_PAGES_PER_RESPONSE) {
                return success({
                    rows,
                    nextCursor: {
                        v: 5,
                        scope,
                        phase: 'current',
                        afterAgentKey,
                        currentAgentKey: selectedAgentKey,
                        cursor: next,
                        hasCustody: hasCustodyForCurrentAgent,
                    },
                    diagnostics,
                });
            }
            continue;
        }
        if (!hasCustodyForCurrentAgent) {
            rows.push({
                agent,
                status: await dependencies.resolveCurrentStatus({
                    agent,
                    custody: null,
                }),
            });
        }
        afterAgentKey = selectedAgentKey;
        currentAgentKey = undefined;
        custodyCursor = undefined;
        hasCustodyForCurrentAgent = false;
        seenCursors.clear();
        if (rows.length >= limit) {
            return success({
                rows,
                nextCursor: {
                    v: 5,
                    scope,
                    phase: 'current',
                    afterAgentKey,
                    hasCustody: false,
                },
                diagnostics,
            });
        }
    }
    return success({
        rows,
        nextCursor: {
            v: 5,
            scope,
            phase: 'current',
            afterAgentKey,
            ...(currentAgentKey ? { currentAgentKey } : {}),
            ...(custodyCursor ? { cursor: custodyCursor } : {}),
            hasCustody: hasCustodyForCurrentAgent,
        },
        diagnostics,
    });
}
