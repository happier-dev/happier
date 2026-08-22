import chalk from 'chalk';
import { errorFrame } from '@happier-dev/cli-common/output';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { createSessionAttachFile } from '@/daemon/sessionAttachFile';
import { requireCatalogEntry } from '@/agent/catalog/registry';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { configuration } from '@/configuration';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import {
  resolveSessionEncryptionContextFromCredentials,
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { encodeBase64 } from '@/api/encryption';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  AccountEncryptionCurrentnessResponse,
  AccountSettings,
  ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
  ConnectedServiceBindingsV1Schema,
  readAcpConfiguredBackendV1FromMetadata,
  serializeSessionModelSelectionV1,
} from '@happier-dev/protocol';
import {
  PersistedProviderResumeBindingError,
  readPersistedProviderResumeState,
} from '@/providers/lifecycle/readPersistedResumeSelection';
import { presentProviderCliRefusal } from '@/providers/lifecycle/presentProviderCliRefusal';
import { canUseInkSelector, runSessionActionSelector } from '@/ui/ink/runSessionActionSelector';
import { buildCliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { handleConfiguredAcpCatalogCliCommand } from '@/agent/acp/catalog/configured/handleCatalogCliCommand';
import { buildResumeSelectionModel, formatResumeSelectionFooter } from './resumeInteractiveSelection';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';

import type { CommandContext, CommandHandler } from '@/cli/commandRegistry';

type FetchSessionByIdFn = (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;
type FetchSessionsPageFn = (params: { token: string; cursor?: string; limit?: number; activeOnly?: boolean; archivedOnly?: boolean }) => Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

type ReadAccountSettingsFn = (params: { credentials: StoredCredentials }) => Promise<AccountSettings>;
type ResumeContributionRegistry = Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>;
type ResolveResumeContributionRegistryFn = () => Promise<ResumeContributionRegistry | null>;

export type ResumeCommandDeps = Readonly<{
  terminalRuntime?: CommandContext['terminalRuntime'];
  rawArgv?: CommandContext['rawArgv'];
  readCredentialsFn?: () => Promise<StoredCredentials | null>;
  readAccountSettingsFn?: ReadAccountSettingsFn;
  fetchSessionByIdFn?: FetchSessionByIdFn;
  fetchSessionsPageFn?: FetchSessionsPageFn;
  resolveAgentHandlerFn?: (agentId: CatalogAgentId) => Promise<CommandHandler>;
  resolveConfiguredAcpCatalogHandlerFn?: () => Promise<CommandHandler>;
  resolveContributionRegistryFn?: ResolveResumeContributionRegistryFn;
  chdirFn?: (nextDir: string) => void;
  canUseInkSelectorFn?: () => boolean;
  selectResumableSessionIdFn?: typeof selectResumableSessionId;
  promptConfirmYesNoFn?: typeof promptConfirmYesNo;
  getAccountEncryptionCurrentnessFn?: () => Promise<AccountEncryptionCurrentnessResponse>;
}>;

type ResumableSessionSelection =
  | { type: 'selected'; sessionId: string }
  | { type: 'cancelled' }
  | { type: 'none'; footerHint?: string | null };

async function resolveAgentHandler(agentId: CatalogAgentId): Promise<CommandHandler> {
  const entry = requireCatalogEntry(agentId);
  if (!entry?.getCliCommandHandler) {
    throw new Error(`Agent '${agentId}' has no CLI command handler registered`);
  }
  return await entry.getCliCommandHandler();
}

async function defaultReadAccountSettings(params: { credentials: StoredCredentials }): Promise<AccountSettings> {
  const snapshot = await bootstrapAccountSettingsContext({
    credentials: params.credentials,
    mode: 'fast',
  });
  const context = await resolveSessionStartAccountSettingsContext({
    startedBy: 'terminal',
    snapshot,
  });
  return context.settings;
}

async function defaultResolveResumeContributionRegistry(): Promise<ResumeContributionRegistry | null> {
  return await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir });
}

function readOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveConfiguredAcpBackendIdFromMetadata(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const configured = readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId;
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  const flavor = readOptionalNonEmptyString(metadata.flavor);
  if (!flavor || !flavor.startsWith('acp:')) return null;
  const backendId = flavor.slice(4).trim();
  return backendId.length > 0 ? backendId : null;
}

function readConnectedServicesFromMetadata(metadata: Record<string, unknown> | null): ConnectedServiceBindingsV1 | null {
  if (!metadata) return null;
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(metadata.connectedServices);
  return parsed.success ? parsed.data : null;
}

async function selectResumableSessionId(params: Readonly<{
  credentials: StoredCredentials;
  accountSettings: AccountSettings;
  fetchSessionsPageFn: FetchSessionsPageFn;
  contributionRegistry: ResumeContributionRegistry | null;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
}>): Promise<ResumableSessionSelection> {
  const model = await buildResumeSelectionModel(params);
  const footerHint = formatResumeSelectionFooter(model.hint);
  if (model.rows.length === 0) return { type: 'none', footerHint };

  const selection = await runSessionActionSelector({
    title: 'Resume a session',
    actionVerb: 'resume',
    rows: model.rows,
    footerHint,
  });
  return selection.type === 'selected' ? selection : { type: 'cancelled' };
}

export async function handleResumeCommand(
  argv: string[],
  deps?: ResumeCommandDeps,
): Promise<void> {
  const hasHelpFlag = argv.some((arg) => {
    const trimmed = typeof arg === 'string' ? arg.trim() : '';
    return trimmed === '--help' || trimmed === '-h';
  });
  if (hasHelpFlag) {
    console.log(SESSION_HELP_LINES.resume);
    console.log('');
    console.log('Resumes an inactive session (vendor-resume) from the CLI.');
    return;
  }

  const readCredentialsFn = deps?.readCredentialsFn ?? readStoredCredentials;
  const readAccountSettingsFn = deps?.readAccountSettingsFn ?? defaultReadAccountSettings;
  const fetchSessionByIdFn = deps?.fetchSessionByIdFn ?? fetchSessionById;
  const fetchSessionsPageFn = deps?.fetchSessionsPageFn ?? fetchSessionsPage;
  const resolveAgentHandlerFn = deps?.resolveAgentHandlerFn ?? resolveAgentHandler;
  const resolveConfiguredAcpCatalogHandlerFn = deps?.resolveConfiguredAcpCatalogHandlerFn ?? (async () => handleConfiguredAcpCatalogCliCommand);
  const resolveContributionRegistryFn = deps?.resolveContributionRegistryFn ?? defaultResolveResumeContributionRegistry;
  const chdirFn = deps?.chdirFn ?? ((nextDir: string) => process.chdir(nextDir));
  const canUseInkSelectorFn = deps?.canUseInkSelectorFn ?? canUseInkSelector;
  const selectResumableSessionIdFn = deps?.selectResumableSessionIdFn ?? selectResumableSessionId;
  const promptConfirmYesNoFn = deps?.promptConfirmYesNoFn ?? promptConfirmYesNo;
  const credentials = await readCredentialsFn();
  if (!credentials) {
    console.error(chalk.yellow('⚠️  Not authenticated with Happier'));
    console.error(chalk.gray('  Please run "happier auth login" first'));
    process.exit(1);
  }
  const getAccountEncryptionCurrentnessFn = deps?.getAccountEncryptionCurrentnessFn
    ?? (async () => await fetchAccountEncryptionCurrentness({ token: credentials.token }));

  const rawInput = argv[0]?.trim() ?? '';
  const isInteractive = rawInput.length === 0;

  const accountSettings = await readAccountSettingsFn({ credentials });
  const contributionRegistry = await resolveContributionRegistryFn();
  const accountEncryptionCurrentness = await getAccountEncryptionCurrentnessFn();

  let sessionIdOrPrefix = rawInput;
  if (isInteractive) {
    if (!canUseInkSelectorFn()) {
      console.error(chalk.red('Error:'), 'Interactive resume is not available (raw TTY mode not supported).');
      console.log('');
      console.log('Hint: run `happier session list --resumable` and then `happier resume <session-id>`.');
      process.exit(1);
    }

    const selected = await selectResumableSessionIdFn({
      credentials,
      accountSettings,
      fetchSessionsPageFn,
      contributionRegistry,
      accountEncryptionMode: accountEncryptionCurrentness.mode,
    });
    if (selected.type === 'cancelled') {
      console.log(chalk.blue('Resume cancelled'));
      return;
    }
    if (selected.type === 'none') {
      console.log('No resumable sessions found.');
      if (selected.footerHint) {
        console.log(`Hint: ${selected.footerHint}`);
      }
      return;
    }
    sessionIdOrPrefix = selected.sessionId;
  }

  if (!sessionIdOrPrefix) {
    console.error(chalk.red('Error:'), 'Missing session ID.');
    console.log('');
    console.log('Usage: happier resume <sessionId>');
    process.exit(1);
  }

  let rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: sessionIdOrPrefix });
  if (!rawSession) {
    const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix: sessionIdOrPrefix });
    if (!resolved.ok) {
      if (resolved.code === 'session_id_ambiguous') {
        throw new Error(`Session id is ambiguous (${resolved.candidates?.join(', ') ?? 'multiple matches'})`);
      }
      if (resolved.code === 'session_lookup_timeout') {
        throw new Error('Session lookup timed out; try again');
      }
      throw new Error('Session not found');
    }
    rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: resolved.sessionId });
  }
  if (!rawSession) throw new Error(`Session not found: ${sessionIdOrPrefix}`);

  const rowModel = buildCliSessionRowModel({
    credentials,
    rawSession,
    accountSettings,
    contributionRegistry,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
  });

  if (rowModel.archivedAt !== null) {
    throw new Error('Session is archived and cannot be resumed.');
  }
  if (rowModel.active === true) {
    throw new Error('Session is already active and cannot be resumed.');
  }

  const directory = rowModel.path;
  if (!directory) {
    const metadata = tryDecryptSessionOwnerMetadataView({
      credentials,
      rawSession,
      accountEncryptionMode: accountEncryptionCurrentness.mode,
    });
    if (!metadata) {
      throw new Error('Failed to decrypt session metadata. Reconnect your terminal and try again.');
    }
    throw new Error('Session metadata is missing a working directory path.');
  }

  const metadata = tryDecryptSessionOwnerMetadataView({
    credentials,
    rawSession,
    accountEncryptionMode: accountEncryptionCurrentness.mode,
  });
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
  const {
    selection: providerResumeSelection,
    binding: persistedProviderBinding,
  } = readPersistedProviderResumeState(metadataRecord);
  const confirmProviderSecurityChange = persistedProviderBinding
    ? async () => await promptConfirmYesNoFn(
        `Provider settings for ${persistedProviderBinding.displaySnapshot.providerName} · ${persistedProviderBinding.displaySnapshot.connectionName} changed. Resume using the current settings?`,
        { default: 'no' },
      )
    : undefined;
  const configuredAcpBackendId = resolveConfiguredAcpBackendIdFromMetadata(metadataRecord);

  const inferredAgentId = rowModel.agentId;
  if (typeof inferredAgentId !== 'string') {
    throw new Error(`Unknown agentId: ${String(inferredAgentId)}`);
  }

  const vendorResume = rowModel.vendorResume;
  if (!vendorResume.eligible) {
    throw new Error(`Session is not vendor-resumable (${vendorResume.reasonCode}).`);
  }

  const attach = await createSessionAttachFile({
    happySessionId: rawSession.id,
    payload: rowModel.encryptionMode === 'plain'
      ? { v: 2, encryptionMode: 'plain' }
      : (() => {
        const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
        if (!ctx) {
          throw new Error('Session encryption material is unavailable.');
        }
        return {
          v: 2 as const,
          encryptionMode: 'e2ee' as const,
          encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
          encryptionVariant: ctx.encryptionVariant,
        };
      })(),
  });

  try {
    chdirFn(directory);

    if (configuredAcpBackendId) {
      const handler = await resolveConfiguredAcpCatalogHandlerFn();
      const context: CommandContext = {
        args: [
          'acp-catalog',
          '--backend',
          configuredAcpBackendId,
          '--existing-session',
          rawSession.id,
          '--resume',
          vendorResume.vendorResumeId,
          '--started-by',
          'terminal',
          ...(providerResumeSelection
            ? ['--model-selection-v1', serializeSessionModelSelectionV1(providerResumeSelection)]
            : []),
        ],
        rawArgv: deps?.rawArgv ?? ['happier', 'resume', rawSession.id],
        terminalRuntime: deps?.terminalRuntime ?? null,
        directSessionLaunch: {
          providerBinding: persistedProviderBinding,
          confirmProviderSecurityChange,
          connectedServices: readConnectedServicesFromMetadata(metadataRecord),
          sessionAttachFilePath: attach.filePath,
        },
      };
      await handler(context);
    } else {
      let agentId: CatalogAgentId;
      try {
        requireCatalogEntry(inferredAgentId as CatalogAgentId);
        agentId = inferredAgentId as CatalogAgentId;
      } catch {
        throw new Error(`Unknown agentId: ${String(inferredAgentId)}`);
      }

      const handler = await resolveAgentHandlerFn(agentId);
      const context: CommandContext = {
        args: [
          agentId,
          '--existing-session', rawSession.id,
          '--resume', vendorResume.vendorResumeId,
          '--started-by', 'terminal',
          ...(providerResumeSelection
            ? ['--model-selection-v1', serializeSessionModelSelectionV1(providerResumeSelection)]
            : []),
        ],
        rawArgv: deps?.rawArgv ?? ['happier', 'resume', rawSession.id],
        terminalRuntime: deps?.terminalRuntime ?? null,
        directSessionLaunch: {
          providerBinding: persistedProviderBinding,
          confirmProviderSecurityChange,
          connectedServices: readConnectedServicesFromMetadata(metadataRecord),
          sessionAttachFilePath: attach.filePath,
        },
      };
      await handler(context);
    }
  } finally {
    await attach.cleanup().catch(() => {});
  }
}

export async function handleResumeCliCommand(
  context: CommandContext,
  deps?: ResumeCommandDeps,
): Promise<void> {
  try {
    await handleResumeCommand(context.args.slice(1), {
      ...deps,
      terminalRuntime: context.terminalRuntime,
      rawArgv: context.rawArgv,
    });
  } catch (error) {
    if (error instanceof PersistedProviderResumeBindingError) {
      console.error(errorFrame('Error:', presentProviderCliRefusal(error.providerError)));
    } else {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    }
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
