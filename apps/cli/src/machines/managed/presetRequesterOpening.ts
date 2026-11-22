import type { ActionExecutorContext } from '@happier-dev/protocol';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import type {
  ManagedMachinePresetOpenedContentV1,
  ManagedMachinePresetV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';

import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { createManagedPresetHydrator } from './presetHydration';

/**
 * Open the requester's own E2EE presets from an Action read with this host's Account
 * custody. Only the key holder's own request opens: an external execution runs under
 * another person's bearer, and a preset owned by another Account or a Team stays sealed
 * even when this Account holds one of its envelopes.
 */
export async function openCliMachinePresetsForRequester(
  params: Readonly<{
    presets: readonly ManagedMachinePresetV1[];
    context: ActionExecutorContext;
    token: string;
    credentials: StoredCredentials | undefined;
    serverUrl: string;
    signal?: AbortSignal;
  }>,
): Promise<ManagedMachinePresetOpenedContentV1[]> {
  const unavailable = (
    presetId: string,
    code: 'permission_denied' | 'credential_unavailable',
  ) => ({ kind: 'unavailable' as const, presetId, code });
  if (params.context.externalActionExecutionAuthorization) {
    return params.presets.map((preset) =>
      unavailable(preset.id, 'permission_denied'),
    );
  }
  const accountId = readAccountIdFromToken(params.token);
  const credentials =
    params.credentials?.token === params.token ? params.credentials : undefined;
  if (!accountId || !credentials)
    return params.presets.map((preset) =>
      unavailable(preset.id, 'credential_unavailable'),
    );
  const own = params.presets.filter(
    (preset) =>
      preset.owner.kind === 'account' && preset.owner.accountId === accountId,
  );
  let contents: (ManagedMachinePresetOpenedContentV1 | null)[] = [];
  if (own.length > 0) {
    try {
      const opened = await createManagedPresetHydrator({
        credentials,
        serverUrl: params.serverUrl,
      }).openRecipientProjections({
        mode: 'e2ee',
        ...(params.signal ? { signal: params.signal } : {}),
        items: own.map((preset) => ({
          presetId: preset.id,
          projection: projectManagedMachinePresetForRecipientV1({
            ...preset,
            recipientAccountId: accountId,
          }),
        })),
      });
      contents = opened.map((content, index) =>
        content ? { kind: 'opened', presetId: own[index]!.id, content } : null,
      );
    } catch (error) {
      if (!(error instanceof ManagedMachineControllerError)) throw error;
    }
  }
  const byId = new Map(
    own.map((preset, index) => [
      preset.id,
      contents[index] ?? unavailable(preset.id, 'credential_unavailable'),
    ]),
  );
  return params.presets.map(
    (preset) =>
      byId.get(preset.id) ?? unavailable(preset.id, 'permission_denied'),
  );
}
