import type { AgentExternalSessionSource, AgentExternalSessionsResolveSourceResult } from '@happier-dev/plugin-sdk/sessions/external';
import type { NativeUsageCaptureSource } from './nativeUsageCaptureState';
import {
    materializeConfiguredExternalSessionSourceCandidates,
    resolveConfiguredExternalSessionSourceAtAdmission,
    type ConfiguredExternalSessionSourceAgentContribution,
    type ConfiguredExternalSessionSourceAccountProjection,
} from '@/session/external/configuredSourceMaterializer';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import type { BoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import type { AgentCatalogEntry } from '@/agent/catalog/types';

export type NativeUsageSourceDescriptor = Pick<NativeUsageCaptureSource, 'agent' | 'source' | 'sourceKey' | 'root' | 'supported' | 'accountingSources' | 'rootKind'> & Readonly<{
    /** Declared configured identity, independent of a runtime-resolved root. */
    configuredSourceKey?: string;
    error?: string;
    /** Count only the paths the source already enumerated; no native-record read is admitted. */
    discoveredFileCount?: number;
}>;
export type NativeUsageSourceBoundary = Readonly<{
    catalogEntry: AgentCatalogEntry | null;
    externalSessions: BoundedAgentExternalSessionsContribution;
    occurrenceId: string;
    retirementSignal: AbortSignal;
    isCurrent(): boolean;
}>;

export async function resolveNativeUsageSourceMetadata(input: Readonly<{
    agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
    agentId: string;
    source: AgentExternalSessionSource;
    activeServerDir: string;
    boundary: NativeUsageSourceBoundary;
    signal: AbortSignal;
    /** A retained capture may resolve metadata, but may not adopt a different source identity. */
    admittedSourceKey?: string;
    includeAccountingSource?: boolean;
}>, admittedSource?: Extract<Awaited<ReturnType<typeof resolveConfiguredExternalSessionSourceAtAdmission>>, { ok: true }>): Promise<Readonly<{ descriptor: NativeUsageSourceDescriptor; metadata: AgentExternalSessionsResolveSourceResult }> | null> {
    const agent = input.agents.find(candidate => candidate.id === input.agentId);
    if (!agent?.identity || !input.boundary.isCurrent() || input.signal.aborted) return null;
    const admitted = admittedSource ?? await resolveConfiguredExternalSessionSourceAtAdmission({ ...input, catalogEntry: input.boundary.catalogEntry });
    if (!admitted.ok) return null;
    const resolved = await input.boundary.externalSessions.resolveSource({ source: admitted.source, signal: input.signal,
        ...(input.includeAccountingSource === false ? { includeAccountingSource: false } : {}) });
    if (!resolved.ok || input.signal.aborted) return null;
    const canonical = resolveExternalSessionSourceFromAgentProjection({ agents: input.agents }, input.agentId, resolved.value.source);
    if (!canonical.ok) return null;
    if (input.admittedSourceKey !== undefined && canonical.sourceKey !== input.admittedSourceKey) return null;
    const rootField = resolved.value.accountingSource?.rootField;
    if (rootField && !canonical.declaration.schema.fields.some(field => field.name === rootField && field.kind === 'string')) {
        throw new TypeError('Accounting root field is not declared by this source');
    }
    return {
        descriptor: {
            agent: agent.identity,
            source: canonical.source,
            sourceKey: canonical.sourceKey,
            root: resolved.value.accountingSource?.rootPath ?? resolved.value.transcriptMediaReadRoots?.[0] ?? null,
            supported: input.boundary.externalSessions.supportsAccounting,
            ...(resolved.value.accountingSource?.accountingSources ? { accountingSources: [...resolved.value.accountingSource.accountingSources] } : {}),
            ...(resolved.value.accountingSource?.discoveredFileCount !== undefined ? {
                discoveredFileCount: resolved.value.accountingSource.discoveredFileCount,
            } : {}),
            rootKind: 'default',
        },
        metadata: resolved.value,
    };
}

/** Enumerates declared metadata only; candidate/transcript/accounting readers are never invoked. */
export async function discoverNativeUsageSourceMetadata(input: Readonly<{
    agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
    account: ConfiguredExternalSessionSourceAccountProjection;
    agentSettings?: unknown;
    activeServerId: string;
    activeServerDir: string;
    resolveBoundary(agentId: string): Promise<NativeUsageSourceBoundary | null>;
    signal: AbortSignal;
    includeAccountingSource?: boolean;
}>): Promise<readonly NativeUsageSourceDescriptor[]> {
    const candidates = materializeConfiguredExternalSessionSourceCandidates(input);
    const sources: NativeUsageSourceDescriptor[] = [];
    for (const candidate of candidates) {
        if (input.signal.aborted) break;
        if (candidate.refusal) continue;
        let boundary: NativeUsageSourceBoundary | null;
        try { boundary = await input.resolveBoundary(candidate.agentId); }
        catch { boundary = null; }
        const admitted = await resolveConfiguredExternalSessionSourceAtAdmission({ ...input, agentId: candidate.agentId,
            source: candidate.source, catalogEntry: boundary?.catalogEntry ?? null });
        if (!admitted.ok) continue;
        const hasConnectedProfile = admitted.declaration.instances?.some(instance => instance.kind === 'connectedServiceProfiles'
            && Object.entries(instance.constants).every(([field, value]) => admitted.source[field] === value));
        const configured = admitted.declaration.instances?.some(instance => (instance.kind === 'agentSetting' || instance.kind === 'agentSettingOverride')
            && typeof admitted.source[instance.field] === 'string');
        const rootKind = hasConnectedProfile ? 'materialized' : configured ? 'configured' : 'default';
        const resolved = boundary
            ? await resolveNativeUsageSourceMetadata({ ...input, agentId: candidate.agentId, source: admitted.source, boundary }, admitted)
            : null;
        if (!resolved) {
            if (input.signal.aborted || boundary?.retirementSignal.aborted) continue;
            const agent = input.agents.find(agent => agent.id === candidate.agentId)?.identity;
            if (agent) sources.push({ agent, source: admitted.source, sourceKey: admitted.sourceKey, root: null,
                rootKind, configuredSourceKey: admitted.sourceKey, supported: false, error: boundary ? 'source_unavailable' : 'agent_unavailable' });
            continue;
        }
        sources.push({ ...resolved.descriptor, rootKind, configuredSourceKey: admitted.sourceKey });
    }
    return sources;
}
