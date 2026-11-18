import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createMachineProvisionerMaterializedFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { label } from '../ui/translations.js';

export const ACCOUNT_PURPOSE = 'cloud-api';
/** Sandboxes run inside a Vercel project; Deployments and AI Gateway do not need one. */
export const PROJECT_REQUIRED = 'vercel_project_required';
const ACCOUNT_SERVICE = { pluginId: 'happier.machine.vercel', localId: 'vercel-account' } as const;
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

/**
 * The typed refusal for an account connected without a project, shared by every
 * provisioner role; Check presents the same finding (its details) in place.
 */
function projectRequired() {
  return new PluginError({ code: PROJECT_REQUIRED, message: 'Choose a Vercel project for Sandboxes in the Vercel account.',
    remediation: { kind: 'selectAccount', service: ACCOUNT_SERVICE },
    details: { available: false, code: PROJECT_REQUIRED, status: label('projectRequired') } });
}

async function environment(context: Invocation, keys: readonly string[]) {
  const material = await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
    { kind: 'environment', keys }, { signal: context.signal });
  context.signal.throwIfAborted();
  return material.kind === 'environment' ? material.env : null;
}

/** Both IDs come from the host's exact selected Connected Account, never launch input. */
export async function readAccountScope(context: Invocation): Promise<AccountScope> {
  context.signal.throwIfAborted();
  let env: Readonly<Record<string, string>> | null = null;
  try { env = await environment(context, scopeKeys); }
  catch { context.signal.throwIfAborted(); }
  const scope = env ? configuredScope({ teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID }) : null;
  if (scope) return scope;
  // The account's configuration materializes without a vendor call; a team that
  // materializes alone means the account was connected without a project.
  let team: Readonly<Record<string, string>> | null = null;
  try { team = await environment(context, ['VERCEL_TEAM_ID']); }
  catch { context.signal.throwIfAborted(); }
  const teamId = team?.VERCEL_TEAM_ID;
  if (typeof teamId === 'string' && teamId.trim() && !/[\r\n]/u.test(teamId)) throw projectRequired();
  throw failure('credential_unavailable');
}

/** One admitted role captures its credential; its HTTP fragments share that use. */
export function nativeFetch(context: Invocation): typeof fetch {
  return createMachineProvisionerMaterializedFetch(context, {
    purpose: ACCOUNT_PURPOSE, origin, headerName: 'authorization', methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  });
}
