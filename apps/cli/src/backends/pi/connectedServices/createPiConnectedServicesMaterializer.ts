import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import {
  createRetainedConnectedServicesMaterialization,
  type ConnectedServiceResolvedSelection,
} from '@/daemon/connectedServices/materialization/materializer';
import {
  resolveConnectedServiceGroupHomeDir,
  resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import {
  importConnectedServiceSessionFiles,
  type ConnectedServiceSessionFileImportRoot,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';
import { formatPiSessionDirectoryForCwd } from '@happier-dev/plugins-pi/agent/sessionFiles';

import { materializePiConnectedServiceAuth } from './materializePiConnectedServiceAuth';

function resolvePiStateSharingMode(settingsLike: unknown): 'isolated' | 'shared' {
  const record = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? settingsLike as Readonly<Record<string, unknown>>
    : null;
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    record?.connectedServicesProviderStateSharingSettingsV1,
    'pi',
  ).stateMode;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildPiSessionImportRoots(params: Readonly<{
  rootDir: string;
  sourceEnv: Readonly<Record<string, string | undefined>>;
  encodedCwdDir: string;
  targetSessionsRoot: string;
  targetEncodedSessionsRoot: string;
}>): readonly ConnectedServiceSessionFileImportRoot[] {
  const legacySessionsEnv = asNonEmptyString(params.sourceEnv.PI_CODING_AGENT_SESSION_DIR);
  const sourceAgentDir = asNonEmptyString(params.sourceEnv.PI_CODING_AGENT_DIR);
  const legacySessionsRoot = join(params.rootDir, 'pi-sessions');

  const roots: ConnectedServiceSessionFileImportRoot[] = [
    ...(legacySessionsEnv ? [{
      sourceRoot: join(legacySessionsEnv, '--workdir--'),
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
    }, {
      sourceRoot: legacySessionsEnv,
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl') && !relativePath.includes('/'),
    }] : []),
    ...(sourceAgentDir ? [{
      sourceRoot: join(sourceAgentDir, 'sessions'),
      destinationRoot: params.targetSessionsRoot,
      includeFile: (relativePath: string) =>
        relativePath.toLowerCase().endsWith('.jsonl') && relativePath.startsWith(`${params.encodedCwdDir}/`),
    }] : []),
    {
      sourceRoot: join(homedir(), '.pi', 'agent', 'sessions'),
      destinationRoot: params.targetSessionsRoot,
      includeFile: (relativePath: string) =>
        relativePath.toLowerCase().endsWith('.jsonl') && relativePath.startsWith(`${params.encodedCwdDir}/`),
    },
    {
      sourceRoot: join(legacySessionsRoot, '--workdir--'),
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
    },
    {
      sourceRoot: legacySessionsRoot,
      destinationRoot: params.targetEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl') && !relativePath.includes('/'),
    },
  ];

  return Array.from(new Map(
    roots.map((root) => [`${root.sourceRoot}:::${root.destinationRoot}`, root]),
  ).values());
}

export const createPiConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
  return async ({ activeServerDir, recordsByServiceId, selectionsByServiceId, accountSettings, processEnv, sessionDirectory }) => {
    const readRecord = (serviceId: 'openai-codex' | 'openai' | 'claude-subscription' | 'anthropic') =>
      selectionsByServiceId?.get(serviceId)?.record ?? recordsByServiceId.get(serviceId) ?? null;
    const openaiCodex = readRecord('openai-codex');
    const openai = readRecord('openai');
    const claudeSubscription = readRecord('claude-subscription');
    const anthropic = readRecord('anthropic');
    if (!openaiCodex && !openai && !anthropic && !claudeSubscription) return null;

    const primary = openaiCodex ?? openai ?? claudeSubscription ?? anthropic;
    if (!primary) return null;
    const primarySelection: ConnectedServiceResolvedSelection | undefined = selectionsByServiceId?.get(primary.serviceId);
    const stableRootDir = primarySelection?.kind === 'group'
      ? resolveConnectedServiceGroupHomeDir({
          activeServerDir,
          serviceId: primarySelection.serviceId,
          groupId: primarySelection.groupId,
          agentId: 'pi',
        })
      : resolveConnectedServiceHomeDir({
          activeServerDir,
          serviceId: primary.serviceId,
          profileId: primarySelection?.kind === 'profile' ? primarySelection.profileId : primary.profileId,
          agentId: 'pi',
        });

    const materialized = await materializePiConnectedServiceAuth({
      rootDir: stableRootDir,
      openaiCodex,
      openai,
      claudeSubscription,
      anthropic,
    });

    const requestedStateMode = resolvePiStateSharingMode(accountSettings);
    const cwd = asNonEmptyString(sessionDirectory);
    if (requestedStateMode === 'shared' && cwd) {
      const sourceEnv = processEnv ?? process.env;
      const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
      const targetSessionsRoot = join(materialized.env.PI_CODING_AGENT_DIR, 'sessions');
      const targetEncodedSessionsRoot = join(targetSessionsRoot, encodedCwdDir);
      await importConnectedServiceSessionFiles({
        roots: buildPiSessionImportRoots({
          rootDir: stableRootDir,
          sourceEnv,
          encodedCwdDir,
          targetSessionsRoot,
          targetEncodedSessionsRoot,
        }),
      });
    }

    return createRetainedConnectedServicesMaterialization({
      rootDir: stableRootDir,
      env: materialized.env,
    });
  };
};
