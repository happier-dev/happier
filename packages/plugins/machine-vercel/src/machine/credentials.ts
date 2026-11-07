import { createMachineProvisionerMaterializedFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';

export const ACCOUNT_PURPOSE = 'cloud-api';
const origin = 'https://api.vercel.com';
const scopeKeys = ['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] as const;
type AccountScope = { teamId: string; projectId: string };
type Invocation = Readonly<{
  signal: AbortSignal;
  services: Readonly<{
    connectedAccounts: Pick<PluginAccountActionContext['services']['connectedAccounts'], 'materialize'>;
    http: Pick<PluginAccountActionContext['services']['http'], 'request'>;
  }>;
}>;

function failure(code: 'credential_unavailable' | 'provider_unavailable' | 'invalid_request') {
  return Object.assign(new Error(code), { code });
}

function configuredScope(values: Readonly<Record<string, unknown>>): AccountScope | null {
  const { teamId, projectId } = values;
  if (typeof teamId !== 'string' || !teamId.trim() || /[\r\n]/u.test(teamId)
    || typeof projectId !== 'string' || !projectId.trim() || /[\r\n]/u.test(projectId)) return null;
  return { teamId: teamId.trim(), projectId: projectId.trim() };
}

/** Both IDs come from the host's exact selected Connected Account, never launch input. */
export async function readAccountScope(context: Invocation): Promise<AccountScope> {
  context.signal.throwIfAborted();
  try {
    const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
      { kind: 'environment', keys: scopeKeys }, { signal: context.signal });
    context.signal.throwIfAborted();
    const scope = material.kind === 'environment'
      ? configuredScope({ teamId: material.env.VERCEL_TEAM_ID, projectId: material.env.VERCEL_PROJECT_ID }) : null;
    if (!scope) throw failure('credential_unavailable');
    return scope;
  } catch {
    context.signal.throwIfAborted();
    throw failure('credential_unavailable');
  }
}

/** One admitted role captures its credential; its HTTP fragments share that use. */
export function nativeFetch(context: Invocation): typeof fetch {
  return createMachineProvisionerMaterializedFetch(context, {
    purpose: ACCOUNT_PURPOSE, origin, headerName: 'authorization', methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  });
}
