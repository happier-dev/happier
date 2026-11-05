import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { computeSessionModelConfigOptionControls } from '@/sync/domains/models/modelOptions';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { computeSessionConfigOptionControls } from '@/sync/domains/sessionControl/configOptionsControl';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiSessionConfigOptionAction(account: LazyActionAccountContext | undefined): NonNullable<ActionExecutorDeps['sessionConfigOptionSet']> {
    return async ({ sessionId, configId, valueId }) => {
        const session = storage.getState().sessions[sessionId] ?? null;
        const metadata = session ? readSessionOwnerMetadataView(session) : null;
        const agentId = resolveAgentIdForPermissionUi({
          metadata,
          flavor: metadata?.flavor ?? undefined,
          toolName: '',
        });
        const target = session ? resolveSessionActionDefaultTarget(resolveSessionActionDefaultBackend({ session })) : null;
        const selection = session && target ? getModelOverrideForSpawn(session, buildBackendTargetKeyV2(target))?.modelSelection.ref : null;
        const modelControls = agentId === null || selection?.providerConnectionId ? null : computeSessionModelConfigOptionControls({
          agentId,
          metadata: session?.composerOptionsInput === undefined ? metadata : session.composerOptionsInput,
          modelId: selection?.modelId ?? 'default',
        });
        const sessionControl = agentId === null ? undefined : computeSessionConfigOptionControls({ agentId, metadata })
          ?.find((candidate) => candidate.option.id === configId);
        const control = modelControls?.find((candidate) => candidate.option.id === configId) ?? sessionControl;
        const choiceIds = control?.option.options?.map((choice) => choice.value)
          ?? control?.option.groups?.flatMap((group) => group.options.map((choice) => choice.value))
          ?? [];
        if (!control || control.disabled || sessionControl?.disabled || !choiceIds.includes(valueId)) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        await sync.publishSessionAcpConfigOptionOverrideToMetadata({
          sessionId,
          configId,
          value: valueId,
          updatedAt: Date.now(),
          ...(account ? { serverId: account.serverId, accountLifetime: account.accountLifetime } : {}),
        });
        return { ok: true, sessionId, configId, valueId };
    };
}
