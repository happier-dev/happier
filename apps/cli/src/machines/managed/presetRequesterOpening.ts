import type { ActionExecutorContext } from '@happier-dev/protocol';
import { openAdmittedManagedMachinePresetRecipientProjectionV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import {
  MACHINE_PRESET_TEAM_KEY_PENDING,
  selectAdmittedMachinePresetReadProjectionV1,
  type ManagedMachinePresetOpenedContentV1,
  type ManagedMachinePresetV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedOpaquePresetReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';

import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { createManagedPresetHydrator } from './presetHydration';

/**
 * Open Home-admitted preset reads using the requester's own Account custody.
 * A Session agent carries its requester's bearer even when it runs for the host owner.
 */
export async function openCliMachinePresetsForRequester(
  params: Readonly<{
    presets: readonly (ManagedMachinePresetV1 | ManagedOpaquePresetReadV1)[];
    context: ActionExecutorContext;
    token: string;
    credentials: StoredCredentials | undefined;
    serverUrl: string;
    signal?: AbortSignal;
  }>,
): Promise<ManagedMachinePresetOpenedContentV1[]> {
  const unavailable = (presetId: string, code: Extract<ManagedMachinePresetOpenedContentV1, { kind: 'unavailable' }>['code']) =>
    ({ kind: 'unavailable' as const, presetId, code });
  const presetId = (preset: ManagedMachinePresetV1 | ManagedOpaquePresetReadV1) =>
    'machine' in preset ? preset.machine.preset.id : preset.id;
  const accountId = readAccountIdFromToken(params.token);
  const carrier = params.context.externalActionExecutionAuthorization;
  if (carrier && readAccountIdFromToken(carrier.token) !== accountId) {
    return params.presets.map((preset) =>
      unavailable(presetId(preset), 'permission_denied'),
    );
  }
  const credentials =
    params.credentials?.token === params.token ? params.credentials : undefined;
  if (!accountId || !credentials)
    return params.presets.map((preset) =>
      unavailable(presetId(preset), 'credential_unavailable'),
    );
  const mayOpen = (preset: ManagedMachinePresetV1 | ManagedOpaquePresetReadV1) =>
    'machine' in preset || preset.owner.kind === 'team' || preset.owner.accountId === accountId;
  if (!params.presets.some(mayOpen)) {
    return params.presets.map(preset => unavailable(presetId(preset), 'permission_denied'));
  }
  try {
    return await createManagedPresetHydrator({ credentials, serverUrl: params.serverUrl }).withE2eeAccountKey(account =>
      params.presets.map<ManagedMachinePresetOpenedContentV1>(preset => {
        const id = presetId(preset);
        if (!mayOpen(preset)) return unavailable(id, 'permission_denied');
        const projection = 'machine' in preset ? preset.presetContent
          : selectAdmittedMachinePresetReadProjectionV1(preset, account.accountId);
        if (projection === MACHINE_PRESET_TEAM_KEY_PENDING) return unavailable(id, projection);
        const content = openAdmittedManagedMachinePresetRecipientProjectionV1({
          presetId: id, mode: 'e2ee', projection, ...account,
        });
        return content ? { kind: 'opened', presetId: id, content } : unavailable(id, 'credential_unavailable');
      }), params.signal);
  } catch (error) {
    params.signal?.throwIfAborted();
    if (!(error instanceof ManagedMachineControllerError) || error.code !== 'credential_unavailable') throw error;
    return params.presets.map(preset => unavailable(presetId(preset), mayOpen(preset) ? 'credential_unavailable' : 'permission_denied'));
  }
}
