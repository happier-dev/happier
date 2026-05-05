import type { ProviderMessageMetaEnricher } from '@happier-dev/agents';

import { normalizeStartingMode } from '@/agent/runtime/session/loop/resolveStartingMode';
import type { Credentials } from '@/persistence';

import type { StartOptions } from './claudeSessionRuntimeOptions';

type ClaudeRuntimeSessionLeafBase = Readonly<{
  credentials: Credentials;
  startOptions: StartOptions;
}>;

export type ClaudeTerminalRuntimeSessionLeaf = ClaudeRuntimeSessionLeafBase & Readonly<{
  kind: 'claudeTerminalSessionRuntimeLeaf';
}>;

export type ClaudeRemoteRuntimeSessionLeaf = ClaudeRuntimeSessionLeafBase & Readonly<{
  kind: 'claudeRemoteSessionRuntimeLeaf';
}>;

export type ClaudeRuntimeSessionLeaf =
  | ClaudeTerminalRuntimeSessionLeaf
  | ClaudeRemoteRuntimeSessionLeaf;

export function resolveClaudeRuntimeSessionLeaf(sessionParams: unknown): ClaudeRuntimeSessionLeaf {
  const opts = sessionParams as {
    credentials?: unknown;
    accountSettingsContext?: unknown;
    providerMessageMetaEnricher?: ProviderMessageMetaEnricher | null;
  } & Record<string, unknown>;

  const credentials = opts?.credentials as Credentials;
  const accountSettingsContext = opts?.accountSettingsContext as { settings?: unknown } | null | undefined;
  const settings = accountSettingsContext?.settings as Readonly<Record<string, unknown>> | null | undefined;

  const {
    credentials: _ignoredCredentials,
    accountSettingsContext: _ignoredContext,
    providerMessageMetaEnricher: _ignoredProviderMessageMetaEnricher,
    ...startOptionsRaw
  } = opts;
  const startingMode = normalizeStartingMode(startOptionsRaw.startingMode) ?? 'terminal';
  const startOptions: StartOptions = {
    ...(startOptionsRaw as StartOptions),
    startingMode,
  };

  if (settings) {
    startOptions.accountSettings = settings as never;
    const enricher = opts.providerMessageMetaEnricher ?? null;
    if (enricher?.buildOutgoingMessageMetaExtras) {
      startOptions.claudeRemoteMetaDefaults = enricher.buildOutgoingMessageMetaExtras(settings);
    }
  }

  return Object.freeze({
    kind: startingMode === 'remote'
      ? 'claudeRemoteSessionRuntimeLeaf'
      : 'claudeTerminalSessionRuntimeLeaf',
    credentials,
    startOptions,
  });
}
