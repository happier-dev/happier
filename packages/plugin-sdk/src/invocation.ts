/** @moduleRealm daemon */
import {
    PluginMachineMaterializationRefV1Schema as canonicalPluginMachineMaterializationRefV1Schema,
} from '@happier-dev/protocol';
import type { PluginServices } from './services/index.js';
import type { PresentationService } from './interactions.js';
import type {
    PluginIdentity,
    PluginInvocationContributionIdentity,
} from './identity.js';
import type {
    PluginMachineExecutionOriginV1,
    PluginMachineMaterializationRefV1,
} from './executionOrigin.js';

/**
 * Runtime Protocol parser projected through the SDK's portable materialization
 * DTO. The structural annotation deliberately keeps the author declaration
 * free of Protocol and Zod implementation types.
 */
export const PluginMachineMaterializationRefV1Schema: Readonly<{
    parse(value: unknown): PluginMachineMaterializationRefV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: PluginMachineMaterializationRefV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginMachineMaterializationRefV1Schema;
export type {
    PluginMachineExecutionOriginV1,
    PluginMachineMaterializationRefV1,
};

/** Least-disclosure snapshot made available to a whole-message Action. */
export type MessageActionAvailableSnapshotV1 = Readonly<{
    sessionId: string;
    messageId: string;
    observedRevision: string;
    role: 'user' | 'agent' | 'event' | 'unknown';
    contentCategory: 'text' | 'structured';
    seq: number;
    visibleText: string | null;
    structuredPresentationSummary: string | null;
    provenanceCategory:
        | 'owner'
        | 'collaborator'
        | 'plugin'
        | 'external_human'
        | 'automation'
        | 'voice'
        | 'terminal'
        | 'recovered_history'
        | 'unknown';
}>;

/**
 * The surface executing the current invocation. Plugin-to-plugin calls always
 * receive the target `plugin` surface; an origin is diagnostic caller data,
 * never a way to inherit the caller's authority.
 */
export type PluginInvocationSurface = 'cli' | 'mcp' | 'agent' | 'ui' | 'voice' | 'background' | 'plugin';

export type PluginInvocationOriginSurface = Exclude<PluginInvocationSurface, 'plugin'>;

/**
 * Host-stamped provenance for an invocation. Plugins receive this data but do
 * not supply it, so a nested call gets a fresh caller for its immediate edge.
 */
export type PluginInvocationCaller =
    | Readonly<{
        kind: 'plugin';
        pluginId: string;
        contribution: PluginInvocationContributionIdentity;
        /** Current host-stamped materialization for the immediate caller. */
        materialization: PluginMachineMaterializationRefV1;
        originSurface?: PluginInvocationOriginSurface;
    }>
    | Readonly<{
        kind: 'host';
        domain: 'ingress';
        originSurface: 'http' | 'webhook';
        contribution: PluginInvocationContributionIdentity;
    }>
    | Readonly<{
        kind: 'automationRun';
        runId: string;
        automationId: string;
        origin: 'schedule' | 'manual' | 'event' | 'conversation';
    }>;

export interface PluginInvocationContext {
    readonly plugin: PluginIdentity;
    readonly contribution: PluginInvocationContributionIdentity;
    readonly surface: PluginInvocationSurface;
    readonly caller?: PluginInvocationCaller;
    readonly session?: Readonly<{ id: string }>;
    /**
     * A bounded, host-stamped snapshot resolved immediately before a
     * whole-message Action dispatch. It is never Action input and absent for
     * ordinary invocations.
    */
    readonly messageAction?: MessageActionAvailableSnapshotV1;
    readonly signal: AbortSignal;
    /**
     * Operation-scoped capabilities for this invocation. They do not own or
     * mirror native Agent-session custody; that exact-session surface is
     * available only through `AgentSessionRuntimeContext.session.services`.
     */
    readonly services: PluginServices;
    readonly ui?: PresentationService;
}

export interface AgentRuntimeFactoryContext {
    readonly plugin: PluginIdentity;
    readonly agent: Readonly<{ id: string }>;
    readonly signal: AbortSignal;
}
