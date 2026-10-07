import {
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { describeEffectiveModelMode } from '@/sync/domains/models/describeEffectiveModelMode';
import { findModelOptionForEffectiveModelId, getModelOptionsForSession } from '@/sync/domains/models/modelOptions';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';
import type { Metadata } from '@happier-dev/session-core/state';
import { t } from '@/text';

type SubagentToolPresentation = Readonly<{
    title: string;
    iconAgentId: string | null;
}>;

type ManagedTargetPresentation = Readonly<{
    agentId: string | null;
    label: string | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readNonBlankString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
    for (const key of keys) {
        const value = readNonBlankString(record[key]);
        if (value) return value;
    }
    return null;
}

function humanizeAgentType(value: string): string {
    const withoutAgentSuffix = value.replace(/(?:[\s_-]+agent)$/i, '');
    return withoutAgentSuffix
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(' ');
}

function resolveAgentTitle(agentId: string): string {
    const core = getAgentCore(agentId);
    return core ? t(core.displayNameKey) : formatAgentLikeIdForDisplay(agentId);
}

function resolveManagedTarget(input: Record<string, unknown>): ManagedTargetPresentation {
    if (input.backendTarget) {
        try {
            const backendTarget = input.backendTarget as BackendTargetRefV2Input;
            const target = readBackendTargetRefV2(backendTarget);
            return {
                agentId: target.backendId,
                label: resolveExecutionRunBackendLabel(backendTarget),
            };
        } catch {
            // Tool inputs are persisted external data. An obsolete or malformed target
            // must degrade to the established generic presentation below.
        }
    }

    const legacyBackendId = readNonBlankString(input.backendId);
    return {
        agentId: legacyBackendId,
        label: legacyBackendId ? resolveAgentTitle(legacyBackendId) : null,
    };
}

function resolveModelLabel(params: {
    modelId: string | null;
    agentId: string | null;
    metadata: Metadata | null;
}): string | null {
    if (!params.modelId || params.modelId === 'default') return null;
    if (!params.agentId) return params.modelId;

    const option = findModelOptionForEffectiveModelId(
        getModelOptionsForSession(params.agentId, params.metadata),
        params.modelId,
    );
    return option?.label.trim() || params.modelId;
}

function resolveNativeSessionModelId(agentId: string | null, metadata: Metadata | null): string | null {
    if (!agentId) return null;
    const appliedModelId = describeEffectiveModelMode({
        agentType: agentId,
        selectedModelId: null,
        metadata,
    }).appliedModelId;
    if (appliedModelId) return readNonBlankString(appliedModelId);

    const models = readSessionModelsState(metadata);
    return models?.agentId === agentId ? readNonBlankString(models.currentModelId) : null;
}

function resolveManagedIntent(input: Record<string, unknown>): string | null {
    const intent = readNonBlankString(input.intent);
    if (!intent) return null;
    if (intent === 'review' || intent === 'plan' || intent === 'delegate') {
        return t(`session.subagents.intent.${intent}`);
    }
    return humanizeAgentType(intent);
}

function resolveNativeAgentType(input: Record<string, unknown>): string | null {
    const raw = readFirstString(input, ['subagent_type', 'agent_type', 'role', 'nickname']);
    return raw ? humanizeAgentType(raw) : null;
}

export function resolveSubagentToolPresentation(params: {
    tool: ToolCall;
    metadata: Metadata | null;
}): SubagentToolPresentation {
    const input = asRecord(params.tool.input) ?? {};
    const isManagedRun = params.tool.name === 'SubAgentRun';
    const managedTarget = isManagedRun ? resolveManagedTarget(input) : null;
    const agentId = managedTarget?.agentId ?? resolveAgentIdFromFlavor(params.metadata?.flavor);

    const explicitModelId = isManagedRun
        ? readNonBlankString(asRecord(input.requestedConfiguration)?.modelId)
        : readFirstString(input, ['model', 'modelId', 'model_id']);
    const modelId = explicitModelId ?? (isManagedRun ? null : resolveNativeSessionModelId(agentId, params.metadata));
    const modelLabel = resolveModelLabel({ modelId, agentId, metadata: params.metadata });

    const identity = modelLabel ?? managedTarget?.label ?? (agentId ? resolveAgentTitle(agentId) : null);
    const agentType = isManagedRun ? resolveManagedIntent(input) : resolveNativeAgentType(input);
    const label = [identity, agentType].filter((part): part is string => Boolean(part)).join(' ');

    return {
        title: label ? t('tools.subAgentTitle', { label }) : t('tools.names.subAgent'),
        iconAgentId: agentId,
    };
}
