import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountActionFormSelectionV1, ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  parseGithubRepositorySpecifier,
  readGithubCredentialRef,
} from './githubProviderContracts.js';

type JsonRecord = Readonly<Record<string, unknown>>;

export type GithubRepositorySetupInputV1 = Readonly<{
  credentialRef: ConnectedAccountActionFormSelectionV1;
  repository: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One exact-account repository setup boundary shared by Channels and
 * Automation. It validates user input before either caller materializes a
 * Connected Account or contacts GitHub.
 */
export function parseGithubRepositorySetupInput(
  value: unknown,
  pluginId: string,
): GithubRepositorySetupInputV1;
export function parseGithubRepositorySetupInput(
  value: unknown, pluginId: string, mode: 'channels',
): Readonly<{ repository: string; credentialRef: ConnectedAccountRef | null }>;
export function parseGithubRepositorySetupInput(
  value: unknown, pluginId: string, mode: 'deployment',
): Readonly<{ repository: string; credentialRef: ConnectedAccountActionFormSelectionV1 | null }>;
export function parseGithubRepositorySetupInput(
  value: unknown, pluginId: string, mode?: 'channels' | 'deployment',
): Readonly<{ repository: string; credentialRef: ConnectedAccountActionFormSelectionV1 | null }> {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new PluginError({
      code: 'github_setup_input_invalid',
      message: 'GitHub setup requires a repository and exact Connected Account.',
    });
  }
  const credentialRef = mode && value.credentialRef === null ? null : readGithubCredentialRef(value.credentialRef, pluginId);
  if (credentialRef === undefined || (mode === 'channels' && credentialRef !== null && 'teamId' in credentialRef)) {
    throw new PluginError({
      code: 'github_setup_credential_invalid',
      message: 'GitHub setup requires this plugin’s exact Connected Account.',
    });
  }
  const repository = value.repository;
  if (typeof repository !== 'string') {
    throw new PluginError({
      code: 'github_setup_repository_invalid',
      message: 'GitHub setup requires an owner/repository identifier.',
    });
  }
  try {
    parseGithubRepositorySpecifier(repository);
  } catch {
    throw new PluginError({
      code: 'github_setup_repository_invalid',
      message: 'GitHub setup requires an owner/repository identifier.',
    });
  }
  return Object.freeze({
    credentialRef,
    repository,
  });
}
