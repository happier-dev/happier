import type { CodexBackendMode } from './providerSettings/definitions/codex.js';
import type { OpenCodeBackendMode } from './providerSettings/definitions/opencode.js';
import { AGENTS_CORE } from './manifest.js';
import type { AgentCore, AgentCoreRuntimeControlSurface, AgentId } from './types.js';

type PartialDeepLeaf = string | number | boolean | bigint | symbol | null | undefined | Date | RegExp | Function;

export type PartialDeep<T> =
    T extends PartialDeepLeaf ? T
        : T extends ReadonlyArray<infer U> ? ReadonlyArray<PartialDeep<U>>
            : T extends Array<infer U> ? Array<PartialDeep<U>>
                : T extends object ? { readonly [K in keyof T]?: PartialDeep<T[K]> }
                    : T;

export type AgentRuntimeKindsByAgentId = Readonly<{
    codex: CodexBackendMode;
    opencode: OpenCodeBackendMode;
}>;

export type AgentRuntimeKindCapableAgentId = keyof AgentRuntimeKindsByAgentId;
export type AgentRuntimeKind = AgentRuntimeKindsByAgentId[AgentRuntimeKindCapableAgentId];
export type AgentRuntimeKindFor<TAgentId extends AgentId> = TAgentId extends AgentRuntimeKindCapableAgentId
    ? AgentRuntimeKindsByAgentId[TAgentId]
    : never;

export type AgentRuntimeKindOverrideSurface = AgentCoreRuntimeControlSurface;
export type AgentRuntimeKindOverrides = Readonly<PartialDeep<AgentRuntimeKindOverrideSurface>>;

export type AgentRuntimeKindDefinition<TKind extends string = string> = Readonly<{
    kind: TKind;
    overrides?: AgentRuntimeKindOverrides;
}>;

export type AgentRuntimeKindsManifest<TKind extends string = string> = Readonly<{
    defaultKind: TKind;
    byKind: Readonly<Record<TKind, AgentRuntimeKindDefinition<TKind>>>;
}>;

export type AnyAgentRuntimeKindsManifest = AgentRuntimeKindsManifest<string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeRuntimeOverrides<T>(base: T, overrides: PartialDeep<T> | undefined): T {
    if (overrides === undefined) return base;
    if (Array.isArray(base) || Array.isArray(overrides)) {
        return overrides as T;
    }
    if (isPlainObject(base) && isPlainObject(overrides)) {
        const merged: Record<string, unknown> = { ...base };
        for (const key of Object.keys(overrides)) {
            const overrideValue = overrides[key];
            if (overrideValue === undefined) continue;
            merged[key] = key in merged
                ? mergeRuntimeOverrides(merged[key], overrideValue as never)
                : overrideValue;
        }
        return merged as T;
    }
    return overrides as T;
}

function readAgentRuntimeControlSurface(agentId: AgentId): AgentCoreRuntimeControlSurface {
    const entry = AGENTS_CORE[agentId] as AgentCore;
    return {
        sessionStorage: entry.sessionStorage,
        sessionCapabilities: entry.sessionCapabilities,
        resume: entry.resume,
        handoff: entry.handoff,
        localControl: entry.localControl ?? null,
        tools: entry.tools,
    };
}

export function getAgentRuntimeKindsManifest<TAgentId extends AgentId>(agentId: TAgentId): AgentCore['runtimeKinds'] | null {
    return (AGENTS_CORE[agentId] as AgentCore).runtimeKinds ?? null;
}

export function resolveDefaultAgentRuntimeKind<TAgentId extends AgentId>(agentId: TAgentId): AgentRuntimeKindFor<TAgentId> | null {
    const manifest = getAgentRuntimeKindsManifest(agentId);
    return (manifest?.defaultKind as AgentRuntimeKindFor<TAgentId> | undefined) ?? null;
}

export function resolveAgentRuntimeControlSurface<TAgentId extends AgentId>(
    agentId: TAgentId,
    runtimeKind: AgentRuntimeKindFor<TAgentId> | null | undefined,
): AgentCoreRuntimeControlSurface {
    const base = readAgentRuntimeControlSurface(agentId);
    const manifest = getAgentRuntimeKindsManifest(agentId);
    if (!manifest || !runtimeKind) return base;
    const overrideDefinition = manifest.byKind[runtimeKind as keyof typeof manifest.byKind];
    return mergeRuntimeOverrides(base, overrideDefinition?.overrides) as AgentCoreRuntimeControlSurface;
}
