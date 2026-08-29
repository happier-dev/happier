import {
    AgentSessionConfigurationSnapshotV1Schema,
} from '@happier-dev/protocol/runtime';
import {
    ProviderBoundModelRefSchema,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV2Input,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import type {
    AgentSessionConfigurationSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';
import { areExecutionRunBackendTargetsEqual } from '../backendTargets';

export function buildExecutionRunConfiguration(input: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    permissionMode: string;
    updatedAtMs: number;
}>): Readonly<{
    modelSelection?: ProviderBoundModelRef;
    configuration: AgentSessionConfigurationSnapshot;
}> {
    const modelSelection = input.modelSelection
        ? ProviderBoundModelRefSchema.parse(input.modelSelection)
        : undefined;
    if (
        modelSelection
        && !areExecutionRunBackendTargetsEqual(modelSelection.agentTargetKey, input.backendTarget)
    ) {
        throw new Error('Execution-run model selection does not target its backend');
    }
    const legacyModelId = input.modelId?.trim() || undefined;
    if (
        modelSelection
        && legacyModelId !== undefined
        && legacyModelId !== modelSelection.modelId
    ) {
        throw new Error('Execution-run model selection does not match modelId');
    }
    const selectedModelId = modelSelection?.modelId ?? legacyModelId ?? null;
    const configuration = AgentSessionConfigurationSnapshotV1Schema.parse({
        mode: { value: null, updatedAtMs: 0 },
        model: {
            value: selectedModelId,
            updatedAtMs: selectedModelId === null ? 0 : input.updatedAtMs,
        },
        permissionIntent: {
            value: permissionMode(input.permissionMode),
            updatedAtMs: input.updatedAtMs,
        },
        options: Object.fromEntries(
            Object.entries(
                input.sessionConfigOptionOverrides?.overrides ?? {},
            ).map(([id, option]) => [
                id,
                { value: option.value, updatedAtMs: option.updatedAt },
            ]),
        ),
    });
    return Object.freeze({
        ...(modelSelection ? { modelSelection } : {}),
        configuration,
    });
}
