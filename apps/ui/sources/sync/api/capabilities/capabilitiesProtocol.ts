import type {
    CapabilityDetectRequest,
    CapabilityDetectResult,
    CapabilityDescriptor,
    CapabilityId,
    CapabilityKind,
    CapabilitiesDescribeResponse,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from '@happier-dev/protocol/capabilities';
import type { ChecklistId as ProtocolChecklistId } from '@happier-dev/protocol/checklists';

export type {
    CapabilityDetectRequest,
    CapabilityDetectResult,
    CapabilityDescriptor,
    CapabilityId,
    CapabilityKind,
    CapabilitiesDescribeResponse,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
};

export type ChecklistId = ProtocolChecklistId;

export type CapabilitiesDetectRequest = {
    checklistId?: ChecklistId | string;
    requests?: CapabilityDetectRequest[];
    overrides?: Partial<Record<CapabilityId, { params?: Record<string, unknown> }>>;
    bypassCache?: boolean;
};

export type CliAuthStatusData = {
    state: 'logged_in' | 'logged_out' | 'unknown';
    method?: 'api_key_env' | 'auth_token_env' | 'credentials_file' | 'oauth_cli' | 'config_file' | 'gcloud_adc' | 'unknown' | null;
    accountLabel?: string | null;
    reason?: 'missing_credentials' | 'expired' | 'cli_missing' | 'probe_failed' | 'timeout' | 'unsupported' | 'interactive_blocked' | 'not_configured' | null;
    source?: 'env' | 'file' | 'command' | 'mixed' | null;
    checkedAt: number;
};

export type CliCapabilityData = {
    available: boolean;
    resolvedPath?: string;
    resolvedCommand?: string;
    resolutionSource?: 'override' | 'system' | 'managed';
    version?: string;
    isLoggedIn?: boolean | null;
    authStatus?: CliAuthStatusData | null;
};

export type TmuxCapabilityData = {
    available: boolean;
    resolvedPath?: string;
    version?: string;
};

export type CodexAcpDepData = {
    installed: boolean;
    installDir: string;
    binPath: string | null;
    installedVersion: string | null;
    sourceKind: 'github_release_binary';
    lastInstallLogPath: string | null;
    lastBackgroundUpdateCheckAtMs: number | null;
    latestVersionCheck?:
      | { ok: true; latestVersion: string | null; label: string | null; checkedAt?: number }
      | { ok: false; errorMessage: string; checkedAt?: number };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCapabilityId(raw: unknown): CapabilityId | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^(cli|tool|dep)\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
        return trimmed as CapabilityId;
    }
    return null;
}

function parseDescriptor(raw: unknown): CapabilityDescriptor | null {
    if (!isPlainObject(raw)) return null;
    const id = parseCapabilityId(raw.id);
    const kind = raw.kind;
    if (!id) return null;
    if (!(kind === 'cli' || kind === 'tool' || kind === 'dep')) return null;

    const out: CapabilityDescriptor = { id, kind };
    if (typeof raw.title === 'string') out.title = raw.title;
    if (isPlainObject(raw.methods)) {
        const methods: Record<string, { title?: string }> = {};
        for (const [k, v] of Object.entries(raw.methods)) {
            if (!isPlainObject(v)) continue;
            methods[k] = typeof v.title === 'string' ? { title: v.title } : {};
        }
        out.methods = methods;
    }
    return out;
}

function parseDetectRequest(raw: unknown): CapabilityDetectRequest | null {
    if (!isPlainObject(raw)) return null;
    const id = parseCapabilityId(raw.id);
    if (!id) return null;
    const params = raw.params;
    return {
        id,
        ...(isPlainObject(params) ? { params } : {}),
    };
}

function parseDetectResult(raw: unknown): CapabilityDetectResult | null {
    if (!isPlainObject(raw)) return null;
    const ok = raw.ok;
    const checkedAt = raw.checkedAt;
    if (typeof ok !== 'boolean') return null;
    if (typeof checkedAt !== 'number') return null;
    if (ok) {
        return { ok: true, checkedAt, data: (raw as any).data };
    }
    const error = (raw as any).error;
    if (!isPlainObject(error) || typeof error.message !== 'string') return null;
    const code = (error as any).code;
    return { ok: false, checkedAt, error: { message: error.message, ...(typeof code === 'string' ? { code } : {}) } };
}

export function parseCapabilitiesDescribeResponse(raw: unknown): CapabilitiesDescribeResponse | null {
    if (!isPlainObject(raw)) return null;
    if (raw.protocolVersion !== 1) return null;

    const capabilitiesRaw = raw.capabilities;
    const checklistsRaw = raw.checklists;
    if (!Array.isArray(capabilitiesRaw)) return null;
    if (!isPlainObject(checklistsRaw)) return null;

    const capabilities: CapabilityDescriptor[] = [];
    for (const c of capabilitiesRaw) {
        const parsed = parseDescriptor(c);
        if (parsed) capabilities.push(parsed);
    }

    const checklists: Record<string, CapabilityDetectRequest[]> = {};
    for (const [k, v] of Object.entries(checklistsRaw)) {
        if (!Array.isArray(v)) continue;
        const list: CapabilityDetectRequest[] = [];
        for (const entry of v) {
            const parsed = parseDetectRequest(entry);
            if (parsed) list.push(parsed);
        }
        checklists[k] = list;
    }

    return {
        protocolVersion: 1,
        capabilities,
        checklists,
    };
}

export function parseCapabilitiesDetectResponse(raw: unknown): CapabilitiesDetectResponse | null {
    if (!isPlainObject(raw)) return null;
    if (raw.protocolVersion !== 1) return null;
    const resultsRaw = raw.results;
    if (!isPlainObject(resultsRaw)) return null;

    const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {};
    for (const [k, v] of Object.entries(resultsRaw)) {
        const id = parseCapabilityId(k);
        if (!id) continue;
        const parsed = parseDetectResult(v);
        if (parsed) results[id] = parsed;
    }

    return { protocolVersion: 1, results };
}

export function parseCapabilitiesInvokeResponse(raw: unknown): CapabilitiesInvokeResponse | null {
    if (!isPlainObject(raw)) return null;
    const ok = raw.ok;
    if (typeof ok !== 'boolean') return null;
    if (ok) {
        return { ok: true, result: (raw as any).result };
    }
    const error = (raw as any).error;
    if (!isPlainObject(error) || typeof error.message !== 'string') return null;
    const code = (error as any).code;
    const logPath = (raw as any).logPath;
    return {
        ok: false,
        error: { message: error.message, ...(typeof code === 'string' ? { code } : {}) },
        ...((typeof logPath === 'string') ? { logPath } : {}),
    };
}
