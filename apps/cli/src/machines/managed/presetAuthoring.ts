import { randomBytes } from 'node:crypto';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { prepareManagedMachinePresetAuthoringV1, projectAccountManagedProvisioners } from '@happier-dev/cli-common/machines/managed';
import { readCurrentAccountPluginExecutionDeclarations } from '@/plugins/runtime/accountPluginActivationSource';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { createManagedPresetHydrator } from './presetHydration';

/** Native and headless Save share the same captured Account custody as preset reads. */
export async function prepareCliManagedMachinePresetAuthoring(
  request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
  input: Readonly<{ credentials?: StoredCredentials; serverUrl: string }>,
) {
  if (request.actionId !== 'machines.presets.create' && request.actionId !== 'machines.presets.update') return null;
  const credentials = input.credentials;
  const accountId = credentials && readAccountIdFromToken(credentials.token);
  if (!credentials || !accountId) return { ok: false as const, errorCode: 'credential_unavailable', error: 'credential_unavailable' };
  const hydrator = createManagedPresetHydrator({ credentials, serverUrl: input.serverUrl });
  return prepareManagedMachinePresetAuthoringV1(request, {
    custody: { accountId,
      open: params => hydrator.openRecipientProjection({ ...params, signal: request.context.signal }),
      withE2eeAccountKey: operation => hydrator.withE2eeAccountKey(operation, request.context.signal),
      readRecipientCensus: async census => {
        try { return await hydrator.readRecipientCensus(census, request.context.signal); } catch {
          request.context.signal?.throwIfAborted();
          return null;
        }
      },
    },
    readSelectedProvisioners: async pluginId => {
      const selected = await readCurrentAccountPluginExecutionDeclarations({ credentials, serverUrl: input.serverUrl,
        family: 'machineProvisioners', pluginId, signal: request.context.signal });
      return selected.kind === 'available' ? projectAccountManagedProvisioners(selected.declarations) : null;
    }, randomBytes,
  });
}
