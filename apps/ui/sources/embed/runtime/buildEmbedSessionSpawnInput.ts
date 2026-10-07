import { AccountApiTokenSelfV1Schema, type AccountApiTokenSelfV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { evaluateApiTokenGrantV1, resolveEffectiveApiTokenModelRefV1, resolveEffectiveApiTokenPermissionModeV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import type { EmbeddedNewSessionDraft } from '@/components/sessions/shell/embedded/embeddedSessionTarget';
import type { StrictSessionSpawnNewInput } from '@/sync/ops/actions/sessionSpawnNewAction';

export class EmbedSessionSpawnInputError extends Error {
    readonly code = 'create_not_granted';

    constructor() {
        super('create_not_granted');
        this.name = 'EmbedSessionSpawnInputError';
    }
}

/** The plaintext spawn relay carries creation intent, never the first message or host facts. */
export function buildEmbedSessionSpawnInput(input: Readonly<{
    draft: EmbeddedNewSessionDraft;
    attemptId: string;
    self: AccountApiTokenSelfV1;
    endpointUrl: string;
}>): StrictSessionSpawnNewInput {
    const admitted = AccountApiTokenSelfV1Schema.safeParse(input.self);
    if (!admitted.success) throw new EmbedSessionSpawnInputError();
    const { grant, embedConfig } = admitted.data;
    const binding = grant.create;
    if (binding === null || embedConfig?.newChat?.enabled !== true) throw new EmbedSessionSpawnInputError();

    const key = SessionCreationKeyV1Schema.safeParse(input.attemptId);
    if (!key.success || key.data !== input.attemptId) throw new EmbedSessionSpawnInputError();
    const qualifiedKey = BackendTargetKeyV2Schema.safeParse(binding.agentTargetKey);
    if (!qualifiedKey.success) throw new EmbedSessionSpawnInputError();
    const agentTarget = parseBackendTargetKeyV2(qualifiedKey.data);
    if (agentTarget.kind !== 'agent') throw new EmbedSessionSpawnInputError();

    let modelSelection = input.draft.modelSelection;
    const model = resolveEffectiveApiTokenModelRefV1(grant, modelSelection?.ref, binding.agentTargetKey);
    if (model === null) throw new EmbedSessionSpawnInputError();
    if (model !== 'automatic' && model !== modelSelection?.ref) {
        modelSelection = { v: 1, ref: model, updatedAt: input.draft.modelSelection?.updatedAt ?? 0 };
    }
    const permissionMode = resolveEffectiveApiTokenPermissionModeV1(grant, input.draft.permissionMode);
    if (permissionMode === null) throw new EmbedSessionSpawnInputError();

    // Deliberately select only these draft members. Even a valid incumbent
    // New Session draft may contain plaintext content and private launch facts.
    const spawn = SessionSpawnNewInputV2Schema.safeParse({
        creationKey: key.data,
        executionTarget: { serverId: input.endpointUrl, machineId: binding.machineId },
        agentTarget,
        directory: { kind: 'managed' },
        organizationPlacement: binding.placement,
        ...(modelSelection === undefined ? {} : { modelSelection }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
    });
    if (!spawn.success) throw new EmbedSessionSpawnInputError();
    if (!evaluateApiTokenGrantV1({
        grant,
        actionId: 'session.spawn_new',
        target: { kind: 'machine', machineId: binding.machineId },
        spawnInput: spawn.data,
    }).ok) throw new EmbedSessionSpawnInputError();

    return { ...spawn.data, creationKey: key.data };
}
