import type { DetectedMcpServerV1, McpServerBindingTargetV1, McpServerBindingV1, McpServerCatalogEntryV1, McpValueRefV1, McpServersSettingsV1 } from '@happier-dev/protocol';

import { upsertMcpServerWithBindingsV1 } from './mcpServerCrud';
import {
    createUniqueMcpServerName,
    normalizeMcpServerNameCandidate,
    toEnvToken,
} from './mcpCatalogNaming';

function buildEnvFromDetectedEnvKeys(envKeys: readonly string[]): Record<string, McpValueRefV1> {
    const out: Record<string, McpValueRefV1> = {};
    for (const key of envKeys) {
        const k = String(key ?? '').trim();
        if (!k) continue;
        out[k] = { t: 'literal', v: `\${${k}}` };
    }
    return out;
}

function buildRemoteHeadersFromDetectedHeaders(params: Readonly<{ headerNames: readonly string[]; serverName: string }>): Record<string, McpValueRefV1> {
    const out: Record<string, McpValueRefV1> = {};
    const serverEnvToken = toEnvToken(params.serverName);
    for (const headerName of params.headerNames) {
        const k = String(headerName ?? '').trim();
        if (!k) continue;
        const headerEnvToken = toEnvToken(k);
        const envVarName = `MCP_${serverEnvToken}_${headerEnvToken}`;
        out[k] = { t: 'literal', v: `\${${envVarName}}` };
    }
    return out;
}

function inferWorkspaceRootFromDetectedProjectPath(sourcePath: string): string | null {
    const normalized = String(sourcePath ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized.includes('/')) return null;

    const parts = normalized.split('/');
    if (parts.length < 2) return null;

    const parent = parts[parts.length - 2] ?? '';
    const rootParts = parent.startsWith('.') ? parts.slice(0, -2) : parts.slice(0, -1);
    if (rootParts.length === 0) return normalized.startsWith('/') ? '/' : null;

    const workspaceRoot = rootParts.join('/');
    return workspaceRoot || (normalized.startsWith('/') ? '/' : null);
}

function buildBindingTargetFromDetected(params: Readonly<{
    detected: DetectedMcpServerV1;
    machineId: string;
}>): McpServerBindingTargetV1 {
    if (params.detected.source.kind === 'project') {
        const workspaceRoot = inferWorkspaceRootFromDetectedProjectPath(params.detected.source.path);
        if (workspaceRoot) {
            return { t: 'workspace', machineId: params.machineId, workspaceRoot };
        }
    }
    return { t: 'machine', machineId: params.machineId };
}

function normalizeRecordKeys(value: Record<string, unknown> | null | undefined): string[] {
    return Object.keys(value ?? {}).sort();
}

function normalizeDetectedName(raw: string): string {
    return normalizeMcpServerNameCandidate(raw);
}

function doesEntryNameMatchDetected(entry: McpServerCatalogEntryV1, detected: DetectedMcpServerV1): boolean {
    const normalizedDetected = normalizeDetectedName(detected.name);
    if (entry.name === normalizedDetected) return true;
    const title = typeof entry.title === 'string' ? normalizeDetectedName(entry.title) : '';
    return title === normalizedDetected;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function doesExistingEntryMatchDetected(entry: McpServerCatalogEntryV1, detected: DetectedMcpServerV1): boolean {
    if (!doesEntryNameMatchDetected(entry, detected)) return false;
    if (entry.transport !== detected.transport) return false;

    const entryEnvKeys = normalizeRecordKeys(entry.env);
    const detectedEnvKeys = [...(detected.envKeys ?? [])].sort();
    if (!areStringArraysEqual(entryEnvKeys, detectedEnvKeys)) return false;

    if (detected.transport === 'stdio') {
        if (!entry.stdio || !detected.stdio) return false;
        return entry.stdio.command === detected.stdio.command && areStringArraysEqual(entry.stdio.args, detected.stdio.args);
    }

    if (!entry.remote || !detected.remote) return false;
    const entryHeaderKeys = normalizeRecordKeys(entry.remote.headers);
    const detectedHeaderKeys = [...(detected.remote.headers ?? [])].sort();
    return entry.remote.url === detected.remote.url && areStringArraysEqual(entryHeaderKeys, detectedHeaderKeys);
}

function doesBindingCoverImportTarget(binding: McpServerBindingV1, target: McpServerBindingTargetV1): boolean {
    if (binding.target.t === 'allMachines') return true;
    if (target.t === 'allMachines') return false;
    if (binding.target.t === 'machine') {
        return binding.target.machineId === target.machineId;
    }
    if (target.t === 'machine') return false;
    return binding.target.machineId === target.machineId && binding.target.workspaceRoot === target.workspaceRoot;
}

export type ResolveImportedMcpServerFromDetectedV1Result = Readonly<{
    action: 'created' | 'updated' | 'reused';
    entry: McpServerCatalogEntryV1;
    binding: McpServerBindingV1 | null;
    nextSettings: McpServersSettingsV1;
}>;

export function buildImportedMcpServerFromDetectedV1(params: Readonly<{
    existingSettings: McpServersSettingsV1;
    detected: DetectedMcpServerV1;
    machineId: string;
    nowMs: number;
    generateId: () => string;
}>): Readonly<{ entry: McpServerCatalogEntryV1; binding: McpServerBindingV1 }> {
    const baseName = normalizeMcpServerNameCandidate(params.detected.name);
    const name = createUniqueMcpServerName({ base: baseName, settings: params.existingSettings });

    const nowMs = params.nowMs;
    const id = params.generateId();

    const entryBase = {
        id,
        name,
        title: params.detected.name.trim() ? params.detected.name.trim() : undefined,
        env: buildEnvFromDetectedEnvKeys(params.detected.envKeys ?? []),
        createdAt: nowMs,
        updatedAt: nowMs,
    } satisfies Omit<McpServerCatalogEntryV1, 'transport' | 'stdio' | 'remote'>;

    const entry: McpServerCatalogEntryV1 = params.detected.transport === 'stdio'
        ? {
            ...entryBase,
            transport: 'stdio',
            stdio: params.detected.stdio!,
            remote: undefined,
        }
        : {
            ...entryBase,
            transport: params.detected.transport,
            stdio: undefined,
            remote: {
                url: params.detected.remote!.url,
                headers: buildRemoteHeadersFromDetectedHeaders({
                    headerNames: params.detected.remote!.headers ?? [],
                    serverName: name,
                }),
            },
        };

    const binding: McpServerBindingV1 = {
        id: params.generateId(),
        serverId: id,
        enabled: params.detected.enabled ?? true,
        target: buildBindingTargetFromDetected({ detected: params.detected, machineId: params.machineId }),
        createdAt: nowMs,
        updatedAt: nowMs,
    };

    return { entry, binding };
}

export function resolveImportedMcpServerFromDetectedV1(params: Readonly<{
    existingSettings: McpServersSettingsV1;
    detected: DetectedMcpServerV1;
    machineId: string;
    nowMs: number;
    generateId: () => string;
}>): ResolveImportedMcpServerFromDetectedV1Result {
    const existingEntry = params.existingSettings.servers.find((entry) => doesExistingEntryMatchDetected(entry, params.detected)) ?? null;
    if (!existingEntry) {
        const created = buildImportedMcpServerFromDetectedV1(params);
        return {
            action: 'created',
            entry: created.entry,
            binding: created.binding,
            nextSettings: upsertMcpServerWithBindingsV1(params.existingSettings, created.entry, [created.binding]),
        };
    }

    const existingBindings = params.existingSettings.bindings.filter((binding) => binding.serverId === existingEntry.id);
    const desiredBinding = buildImportedMcpServerFromDetectedV1({
        ...params,
        existingSettings: { ...params.existingSettings, servers: [] },
    }).binding;
    const coveredBinding = existingBindings.find((binding) => doesBindingCoverImportTarget(binding, desiredBinding.target)) ?? null;

    if (coveredBinding) {
        if (coveredBinding.enabled === desiredBinding.enabled) {
            return {
                action: 'reused',
                entry: existingEntry,
                binding: coveredBinding,
                nextSettings: params.existingSettings,
            };
        }

        const nextBindings = existingBindings.map((binding) => {
            if (binding.id !== coveredBinding.id) return binding;
            return { ...binding, enabled: desiredBinding.enabled, updatedAt: params.nowMs };
        });
        return {
            action: 'updated',
            entry: existingEntry,
            binding: nextBindings.find((binding) => binding.id === coveredBinding.id) ?? null,
            nextSettings: upsertMcpServerWithBindingsV1(params.existingSettings, existingEntry, nextBindings),
        };
    }

    const appendedBinding: McpServerBindingV1 = { ...desiredBinding, serverId: existingEntry.id };
    const nextBindings = [...existingBindings, appendedBinding];
    return {
        action: 'updated',
        entry: existingEntry,
        binding: appendedBinding,
        nextSettings: upsertMcpServerWithBindingsV1(params.existingSettings, existingEntry, nextBindings),
    };
}
