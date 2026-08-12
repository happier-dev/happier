import { join } from 'node:path';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import {
  resolveConnectedServiceGroupHomeDir,
  resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

export type ClaudeConnectedServiceId = 'claude-subscription' | 'anthropic';

/**
 * The part of a resolved selection that decides the stable directory.
 *
 * `ConnectedServiceResolvedSelection` satisfies this structurally. Callers that only know the
 * binding (e.g. the models probe, which never materializes credentials) can pass the narrow shape
 * instead of synthesizing a credential record.
 */
export type ClaudeConnectedServiceStableDirSelection =
  | Readonly<{ kind: 'profile'; profileId: string }>
  | Readonly<{ kind: 'group'; groupId: string }>;

function readClaudeConnectedServiceId(value: ConnectedServiceId): ClaudeConnectedServiceId | null {
  return value === 'claude-subscription' || value === 'anthropic' ? value : null;
}

export function resolveClaudeConnectedServiceStableRootDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  fallbackProfileId: string;
  selection: ConnectedServiceResolvedSelection | ClaudeConnectedServiceStableDirSelection | null | undefined;
}>): string | null {
  const serviceId = readClaudeConnectedServiceId(params.serviceId);
  if (!serviceId) return null;
  return params.selection?.kind === 'group'
    ? resolveConnectedServiceGroupHomeDir({
        activeServerDir: params.activeServerDir,
        serviceId,
        groupId: params.selection.groupId,
        agentId: 'claude',
      })
    : resolveConnectedServiceHomeDir({
        activeServerDir: params.activeServerDir,
        serviceId,
        profileId: params.selection?.kind === 'profile' ? params.selection.profileId : params.fallbackProfileId,
        agentId: 'claude',
      });
}

export function resolveClaudeConnectedServiceStableConfigDir(params: Readonly<{
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  fallbackProfileId: string;
  selection: ConnectedServiceResolvedSelection | ClaudeConnectedServiceStableDirSelection | null | undefined;
}>): string | null {
  const rootDir = resolveClaudeConnectedServiceStableRootDir(params);
  return rootDir ? join(rootDir, 'claude-config') : null;
}
