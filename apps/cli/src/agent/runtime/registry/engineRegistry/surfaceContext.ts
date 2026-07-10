import {
    type BackendSurfaceDiagnosticV1,
    type ExternalSessionRuntimeContextV1,
    type PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { configuration } from '@/configuration';
import {
    createAcpSessionOperations,
    createContributionScopedAcpCatalogLookupResolver,
} from '@/agent/acp/createCatalogAcpBackend';
import { createExternalSessionCandidateHostService } from '@/session/external/candidates/host';
import { createExternalSessionTranscriptStoreService } from '@/session/external/transcripts/store';
import { resolveExternalSessionRuntimeHostAdapters } from '@/session/external/hostAdapters';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolveBackendExecutionSurfacesFromEngine } from '../backendEngineSurfaceBindings';
import { readPluginContextV1Binder } from './pluginContext/binder';
import { readTrimmedString } from './pluginContext/values';

export function createEngineSurfaceContextResolvers(
    pluginContext: PluginContextV1,
    options?: Readonly<{
        contributions?: ResolvedContributionRegistry;
    }>,
): Pick<
    Parameters<typeof resolveBackendExecutionSurfacesFromEngine>[0],
    | 'resolveTerminalRuntimeLaunchServices'
    | 'resolveTerminalRuntimeLaunchSignal'
    | 'resolveTerminalRuntimeHostOrchestration'
    | 'resolveExternalSessionRuntimeContext'
    | 'grantExternalSessionTranscriptPath'
    | 'runExternalSessionFollowWithLinkedSession'
    | 'resolveAcpSessionOperations'
> {
    const acp = createAcpSessionOperations(
        options?.contributions
            ? {
                resolveCatalogLookup: createContributionScopedAcpCatalogLookupResolver(options.contributions),
            }
            : undefined,
    );
    let externalSessionHostServices: Promise<{
        transcripts: ReturnType<typeof createExternalSessionTranscriptStoreService>;
        candidates: ReturnType<typeof createExternalSessionCandidateHostService>;
    }> | null = null;
    const resolveExternalSessionHostServices = () => {
        externalSessionHostServices ??= (async () => {
            const adapters = await resolveExternalSessionRuntimeHostAdapters({
                activeServerDir: configuration.activeServerDir,
                env: process.env,
            });
            return Object.freeze({
                transcripts: createExternalSessionTranscriptStoreService({
                    adapters: adapters.transcriptStores ?? [],
                }),
                candidates: createExternalSessionCandidateHostService({
                    adapters: adapters.candidateHosts ?? [],
                }),
            });
        })();
        return externalSessionHostServices;
    };
    const binder = readPluginContextV1Binder(pluginContext);
    const issueRuntimeDiagnostic = (diagnostic: BackendSurfaceDiagnosticV1): void => {
        const error = new Error(diagnostic.safeMessage ?? diagnostic.code);
        pluginContext.errors.report(error, {
            code: diagnostic.code,
            ...(diagnostic.severity ? { severity: diagnostic.severity } : {}),
            ...(typeof diagnostic.retryable === 'boolean' ? { retryable: diagnostic.retryable } : {}),
            ...(diagnostic.details ? { details: diagnostic.details } : {}),
        });
    };
    return {
        resolveTerminalRuntimeLaunchServices: async (request) => {
            const sessionId = readTrimmedString(request.sessionId);
            if (!sessionId) {
                return null;
            }
            return await pluginContext.sessions.get({ sessionId });
        },
        resolveTerminalRuntimeLaunchSignal: () => pluginContext.abort.signal,
        resolveTerminalRuntimeHostOrchestration: (request) => {
            const sessionId = readTrimmedString(request.sessionId);
            if (!sessionId) {
                return null;
            }
            return binder?.resolveTerminalRuntimeHostOrchestration(sessionId) ?? null;
        },
        resolveExternalSessionRuntimeContext: async (request): Promise<ExternalSessionRuntimeContextV1> => {
            const linkedSessionId = readTrimmedString(request.linkedSessionId);
            const directory = readTrimmedString(request.directory);
            const external = await resolveExternalSessionHostServices();
            return Object.freeze({
                signal: pluginContext.abort.signal,
                ...(linkedSessionId || directory
                    ? {
                        session: Object.freeze({
                            ...(linkedSessionId ? { sessionId: linkedSessionId } : {}),
                            ...(directory ? { directory } : {}),
                        }),
                    }
                    : {}),
                directories: Object.freeze({
                    activeServerDir: configuration.activeServerDir,
                    logsDir: configuration.logsDir,
                }),
                transcripts: Object.freeze({
                    fileFollow: pluginContext.agentRuntime.transcripts.fileFollow,
                }),
                external: Object.freeze({
                    transcripts: external.transcripts,
                    candidates: external.candidates,
                }),
                diagnostics: Object.freeze({
                    issue: issueRuntimeDiagnostic,
                }),
            });
        },
        grantExternalSessionTranscriptPath: async (request) => {
            const sourceId = readTrimmedString(request.sourceId) ?? readTrimmedString(request.providerSessionId);
            if (!sourceId) {
                return;
            }
            await binder?.grantExternalSessionTranscriptPath({
                path: request.path,
                sourceId,
                sessionId: request.sessionId ?? null,
            });
        },
        runExternalSessionFollowWithLinkedSession: async (sessionId, operation) => (
            binder
                ? await binder.runWithTranscriptFileFollowSession(sessionId, operation)
                : await operation()
        ),
        resolveAcpSessionOperations: () => acp,
    };
}
