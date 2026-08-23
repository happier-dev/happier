import { randomUUID } from 'node:crypto';

import type {
    AgentExternalSessionSource,
    AgentExternalSessionsContribution,
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    ManagedServiceHandle,
} from '@happier-dev/plugin-sdk/managed-services';

import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';

import type { AgentExternalSessionsManagedEndpointReadHost } from './agentExternalSessionsInvocation';

/**
 * Serves an Agent External Sessions managed endpoint from a managed service the
 * daemon owns, so a read does not depend on a live Session runner happening to
 * have started the same server.
 *
 * Acquisition is host-side and active: the contribution only declares a
 * specification, and this owner performs the supervision through the ordinary
 * daemon managed-services owner. Nothing here consults a durable endpoint
 * record or a caller-supplied address, so read authority still comes from
 * owning the process rather than from passive state.
 *
 * Under daemon custody the daemon holds the handle, so a read is a direct
 * `ManagedServiceHandle.request()`; the cross-process projection apparatus
 * exists only to keep a runner-minted credential inside the runner and has no
 * subject here.
 */

const MANAGED_ENDPOINT_READ_TIMEOUT_MS = 15_000;

export type ContributionOwnedManagedServiceEndpointReadIdentity = Readonly<{
    pluginId: string;
    pluginVersion: string;
    agentId: string;
    generation: string;
}>;

/**
 * The two admissions a contribution-owned endpoint serves.
 *
 * `demand` answers an explicit user request, so the host may own the process
 * the contribution declares. `attachedOnly` answers passive following, which
 * carries no user demand for a process: it admits a server the user already
 * runs and resolves `null` for an owned spawn, leaving the caller on whatever
 * Session-runner endpoint it already had.
 */
export type ContributionOwnedManagedServiceEndpointReadHosts = Readonly<{
    demand: AgentExternalSessionsManagedEndpointReadHost;
    attachedOnly: (
        input: Parameters<AgentExternalSessionsManagedEndpointReadHost>[0],
    ) => Promise<AgentExternalSessionsManagedEndpointRead | null>;
}>;

/**
 * Returns `null` when the contribution declares no managed endpoint service, so
 * the caller keeps whatever host it already had rather than gaining an inert
 * second owner.
 */
export function createContributionOwnedManagedServiceEndpointReadHost(params: Readonly<{
    contribution: AgentExternalSessionsContribution;
    identity: ContributionOwnedManagedServiceEndpointReadIdentity;
    createAgentInvocationServices: CreateAgentInvocationServices;
    cwd: string;
    isGenerationActive(): boolean;
    retirementSignal: AbortSignal;
}>): ContributionOwnedManagedServiceEndpointReadHosts | null {
    const declare = params.contribution.resolveManagedEndpointService;
    if (typeof declare !== 'function') return null;

    // One acquisition identity for the whole generation. The managed-services
    // owner derives both the service lifetime and the credential redaction
    // correlation from this identity, so a per-read correlation would spawn a
    // server per page turn and would stop redacting the minted password the
    // moment that read finished. Reuse then comes free from the owner's
    // semantic-entry table; no refcount, lease or idle timer is involved.
    const correlationId = randomUUID();
    const acquisition = new AbortController();
    const abortAcquisition = (): void => {
        acquisition.abort(new Error(
            'Agent External Sessions managed endpoint owner belongs to a retired generation',
        ));
    };
    if (params.retirementSignal.aborted) abortAcquisition();
    else params.retirementSignal.addEventListener('abort', abortAcquisition, { once: true });

    let servicesPromise: ReturnType<CreateAgentInvocationServices> | null = null;
    const ensureServices = () => {
        if (servicesPromise) return servicesPromise;
        const pending = params.createAgentInvocationServices({
            pluginId: params.identity.pluginId,
            pluginVersion: params.identity.pluginVersion,
            agentId: params.identity.agentId,
            generation: params.identity.generation,
            correlationId,
            cwd: params.cwd,
            signal: acquisition.signal,
            isGenerationCurrent: params.isGenerationActive,
        });
        servicesPromise = pending;
        // A failed acquisition belongs to the attempt that failed, not to the
        // generation. Retaining the rejected promise would replay that one
        // failure on every later browse, so drop it and let the next browse
        // acquire again.
        pending.catch(() => {
            if (servicesPromise === pending) servicesPromise = null;
        });
        return pending;
    };

    const acquire = async (
        source: AgentExternalSessionSource,
        signal: AbortSignal,
        admit: 'ownedOrAttached' | 'attachedOnly',
    ): Promise<ManagedServiceHandle | null> => {
        const spec = await declare({ source, signal });
        if (!spec) {
            throw new Error(
                'Agent External Sessions contribution declares no managed endpoint service for this source',
            );
        }
        // Attaching to a server the user already runs starts nothing, so a
        // passive follow reaches it exactly like an explicit browse does. An
        // owned spawn is the only shape passive following must not reach.
        if (admit === 'attachedOnly' && spec.mode.kind !== 'attach') return null;
        const services = await ensureServices();
        // Supervision is bounded by the generation, not by the browse operation
        // that first needed it. A cold start can outlast one operation deadline;
        // binding establishment to that operation's signal would tear the
        // starting server down on the timeout and make every retry cold again.
        return await services.managedServices.supervise(spec, {
            signal: acquisition.signal,
        });
    };

    const read = async (
        input: Parameters<AgentExternalSessionsManagedEndpointReadHost>[0],
        admit: 'ownedOrAttached' | 'attachedOnly',
    ): Promise<AgentExternalSessionsManagedEndpointRead | null> => {
        if (!params.isGenerationActive() || params.retirementSignal.aborted) {
            throw new Error(
                'Agent External Sessions managed endpoint owner belongs to a retired generation',
            );
        }
        const handle = await acquire(input.source, input.signal, admit);
        if (!handle) return null;
        await handle.waitUntilHealthy({ signal: input.signal });
        return Object.freeze(async (request) => {
            const response = await handle.request({
                pathAndQuery: request.pathAndQuery,
                method: 'GET',
                ...(request.headers ? { headers: request.headers } : {}),
                timeoutMs: MANAGED_ENDPOINT_READ_TIMEOUT_MS,
                signal: input.signal,
            });
            return Object.freeze({
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
            });
        });
    };

    return Object.freeze({
        async demand(input) {
            const reader = await read(input, 'ownedOrAttached');
            if (!reader) {
                throw new Error(
                    'Agent External Sessions contribution declares no managed endpoint service for this source',
                );
            }
            return reader;
        },
        attachedOnly: (input) => read(input, 'attachedOnly'),
    });
}
