import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { parseBackendTargetKey } from '@happier-dev/protocol';

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function maybeRedact(text: string, shareFilePaths: boolean): string {
    return shareFilePaths ? text : redactVoicePathLikeString(text);
}

function humanizeIdentifier(value: string | null): string | null {
    const normalized = normalizeText(value);
    if (!normalized) return null;
    const collapsed = normalized.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!collapsed) return null;
    return collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
}

function resolveAgentModelsSummaryLabel(input: Record<string, unknown> | null, result: Record<string, unknown> | null): string | null {
    const backendTargetKey = normalizeText(input?.backendTargetKey);
    if (backendTargetKey) {
        try {
            const target = parseBackendTargetKey(backendTargetKey);
            if (target.kind === 'configuredAcpBackend') {
                return humanizeIdentifier(target.backendId);
            }
            return humanizeIdentifier(target.agentId);
        } catch {
            // Fall back to legacy agent-id labeling when the input is malformed.
        }
    }

    return humanizeIdentifier(normalizeText(input?.agentId) ?? normalizeText(result?.agentId));
}

function collectLabels(
    collection: unknown,
    shareFilePaths: boolean,
    fallbackKeys: readonly string[] = ['label', 'title', 'name', 'text'],
): string[] {
    if (!Array.isArray(collection)) return [];
    const labels: string[] = [];
    const seen = new Set<string>();

    for (const rawItem of collection) {
        const item = asObject(rawItem);
        if (!item) continue;
        let label: string | null = null;
        for (const key of fallbackKeys) {
            label = normalizeText(item[key]);
            if (label) break;
        }
        if (!label) continue;
        const safeLabel = maybeRedact(label, shareFilePaths);
        if (seen.has(safeLabel)) continue;
        seen.add(safeLabel);
        labels.push(safeLabel);
    }

    return labels;
}

function collectSessionLabels(collection: unknown, shareFilePaths: boolean): string[] {
    if (!Array.isArray(collection)) return [];

    const records = collection
        .map((rawItem) => asObject(rawItem))
        .filter(Boolean) as Array<Record<string, unknown>>;

    const titleCounts = new Map<string, number>();
    for (const record of records) {
        const title = normalizeText(record.title) ?? normalizeText(record.label) ?? normalizeText(record.name);
        if (!title) continue;
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }

    const labels: string[] = [];
    const seen = new Set<string>();
    for (const record of records) {
        const title = normalizeText(record.title) ?? normalizeText(record.label) ?? normalizeText(record.name);
        if (!title) continue;

        const safeTitle = maybeRedact(title, shareFilePaths);
        const safeServerName = normalizeText(record.serverName)
            ? maybeRedact(normalizeText(record.serverName)!, shareFilePaths)
            : null;
        const safeLocationLabel = normalizeText(record.locationLabel)
            ? maybeRedact(normalizeText(record.locationLabel)!, shareFilePaths)
            : null;

        let label = safeTitle;
        if ((titleCounts.get(title) ?? 0) > 1) {
            if (safeServerName && safeLocationLabel) {
                label = `${safeTitle} on ${safeServerName} in ${safeLocationLabel}`;
            } else if (safeServerName) {
                label = `${safeTitle} on ${safeServerName}`;
            } else if (safeLocationLabel) {
                label = `${safeTitle} in ${safeLocationLabel}`;
            }
        }

        if (seen.has(label)) continue;
        seen.add(label);
        labels.push(label);
    }

    return labels;
}

function summarizeLabelList(
    prefix: string,
    labels: readonly string[],
    options?: Readonly<{ hasMore?: boolean }>,
): string | null {
    if (labels.length === 0) return null;
    const shown = labels.slice(0, 3);
    const remainder = labels.length - shown.length;
    if (remainder > 0) {
        return `${prefix}: ${shown.join(', ')}${shown.length > 0 ? ',' : ''} and ${remainder} more.`;
    }
    if (options?.hasMore === true) {
        return `${prefix}: ${shown.join(', ')}. There are more sessions available if you keep going.`;
    }
    return `${prefix}: ${shown.join(', ')}.`;
}

function summarizeSessionReference(session: unknown, shareFilePaths: boolean): string | null {
    const record = asObject(session);
    if (!record) return null;
    const title = normalizeText(record.title) ?? normalizeText(record.label) ?? normalizeText(record.name);
    const serverName = normalizeText(record.serverName);
    const locationLabel = normalizeText(record.locationLabel);
    if (!title) return null;
    const safeTitle = maybeRedact(title, shareFilePaths);
    const safeServerName = serverName ? maybeRedact(serverName, shareFilePaths) : null;
    const safeLocationLabel = locationLabel ? maybeRedact(locationLabel, shareFilePaths) : null;
    if (safeServerName && safeLocationLabel) {
        return `${safeTitle} on ${safeServerName} in ${safeLocationLabel}`;
    }
    if (safeServerName) {
        return `${safeTitle} on ${safeServerName}`;
    }
    if (safeLocationLabel) {
        return `${safeTitle} in ${safeLocationLabel}`;
    }
    return safeTitle;
}

export function resolveVoiceToolResultHumanSummary(params: Readonly<{
    toolName: string;
    toolInput: unknown;
    toolResult: unknown;
    shareFilePaths: boolean;
}>): string | null {
    const result = asObject(params.toolResult);
    if (!result) return null;

    const explicitSummary = normalizeText(result.summary)
        ?? normalizeText(asObject(result.error)?.message);
    if (explicitSummary) {
        return maybeRedact(explicitSummary, params.shareFilePaths);
    }

    switch (params.toolName) {
        case 'listSessions': {
            return summarizeLabelList(
                'Available sessions',
                collectSessionLabels(result.sessions, params.shareFilePaths),
                { hasMore: normalizeText(result.nextCursor) !== null },
            );
        }
        case 'openSession': {
            const sessionSummary = summarizeSessionReference(result.session, params.shareFilePaths);
            return sessionSummary ? `Opened ${sessionSummary}.` : null;
        }
        case 'listRecentPaths': {
            return summarizeLabelList('Recent paths', collectLabels(result.items, params.shareFilePaths));
        }
        case 'listMachines': {
            return summarizeLabelList('Available machines', collectLabels(result.items, params.shareFilePaths));
        }
        case 'listServers': {
            return summarizeLabelList('Available servers', collectLabels(result.items, params.shareFilePaths));
        }
        case 'listAgentBackends': {
            return summarizeLabelList('Available backends', collectLabels(result.items, params.shareFilePaths));
        }
        case 'listAgentModels': {
            const labels = collectLabels(result.items, params.shareFilePaths);
            const input = asObject(params.toolInput);
            const agentLabel = resolveAgentModelsSummaryLabel(input, result);
            const prefix = agentLabel ? `Available ${agentLabel} models` : 'Available models';
            return summarizeLabelList(prefix, labels);
        }
        case 'setPrimaryActionSession': {
            const sessionSummary = summarizeSessionReference(result.session, params.shareFilePaths);
            return sessionSummary ? `Using ${sessionSummary}.` : null;
        }
        case 'setTrackedSessions': {
            return summarizeLabelList('Tracking sessions', collectSessionLabels(result.sessions, params.shareFilePaths));
        }
        case 'spawnSession': {
            const sessionSummary = summarizeSessionReference(result.session, params.shareFilePaths);
            if (sessionSummary) {
                return `Created ${sessionSummary}.`;
            }
            const targetLabels = collectLabels(result.target ? [result.target] : [], params.shareFilePaths);
            return summarizeLabelList('Created a session in', targetLabels);
        }
        default:
            return null;
    }
}
