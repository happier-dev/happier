import type { Metadata, PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type {
  SessionAttachMetadataIdentityPolicy,
  SessionModelSelectionIntentV1,
} from '@happier-dev/protocol';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';

import {
  mergeSessionMetadataForStartup,
  type SessionModeOverride as MergeSessionModeOverride,
  type ModelOverride as MergeModelOverride,
  type PermissionModeOverride as MergePermissionModeOverride,
  type SessionStackSkillMigration,
} from './mergeSessionMetadataForStartup';
import { readStackSkillIdsV1 } from '@happier-dev/protocol/prompts/library/skills/convertStackSkillEntriesV1';
import { SessionPromptStackV1StoredSchema, SessionDisabledInheritedEntryIdsV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { isPromptStackSystemAppendPlacementV1 } from '@happier-dev/protocol/prompts/library/promptPlacementV1';
import { withCliPromptLibraryArtifactReader, type CliPromptLibraryArtifactReaderOptions } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent,
  readAccountPromptStackSources, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveSessionProjectPromptStack } from '@/agent/prompting/coding/sessionProjectPromptStack';
import { normalizeLegacySessionModeMetadataCompat } from './startup/normalizeLegacySessionModeMetadataCompat';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { SessionMetadataMutationContext } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';

export type PermissionModeOverride = MergePermissionModeOverride | null;

export type SessionModeOverride = MergeSessionModeOverride | null;

export type ModelOverride = MergeModelOverride | null;

export type SessionStackSkillMigrationPreparation = Readonly<{ status: 'ready'; migration?: SessionStackSkillMigration }>
  | Readonly<{ status: 'unavailable' }>;

/** One classification owner for startup writes and captured Runner exclusion admission. */
export async function prepareSessionStackSkillMigration(metadata: unknown,
  options: CliPromptLibraryArtifactReaderOptions & Readonly<{
    disabledInheritedEntries?: readonly PromptStackEntryV1[];
    accountSnapshot?: ActiveAccountSettingsSnapshot | null;
    operationContext?: SavedSecretOperationContextV1;
    /** Runner identity preparation already opened this selected Project layer. */
    projectEntries?: readonly PromptStackEntryV1[];
  }>,
): Promise<SessionStackSkillMigrationPreparation> {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const work = Reflect.get(record, 'work');
  const workRecord = work && typeof work === 'object' && !Array.isArray(work) ? work : {};
  const entries = SessionPromptStackV1StoredSchema.safeParse(Reflect.get(workRecord, 'promptStack') ?? []);
  const disabled = SessionDisabledInheritedEntryIdsV1Schema.safeParse(Reflect.get(workRecord, 'disabledInheritedEntryIds') ?? []);
  if (!disabled.success) return { status: 'unavailable' };
  let inherited = [...(options.disabledInheritedEntries ?? [])];
  const disabledIds = disabled.data;
  const operation = options.operationContext;
  let inheritedScope: Readonly<{ scopeKey: string; lifetimeToken: number }> | undefined;
  const isCurrent = async () => {
    options.signal?.throwIfAborted();
    if (operation) return operation.credentials.token === options.credentials?.token && await operation.isCurrent();
    return !inheritedScope || isActiveAccountSettingsSnapshotLifetimeCurrent(inheritedScope);
  };
  if (!await isCurrent()) return { status: 'unavailable' };
  if (disabledIds.length > 0) {
    if (!options.credentials) return { status: 'unavailable' };
    const scopeKey = resolveAccountSettingsScopeKey(options.credentials);
    if (!operation) inheritedScope = { scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
    const account = operation ? operation.readSnapshot()
      : options.accountSnapshot !== undefined ? options.accountSnapshot : getActiveAccountSettingsSnapshot();
    if (account?.scopeKey !== scopeKey || !await isCurrent()) return { status: 'unavailable' };
    const profileId = Reflect.get(record, 'profileId');
    const sources = readAccountPromptStackSources(account, { surface: 'coding',
      profileId: typeof profileId === 'string' ? profileId : null, profilePurpose: 'retained_exclusions' });
    if (sources.status !== 'ready') return { status: 'unavailable' };
    inherited.push(...sources.accountEntries, ...sources.profileEntries);
    if (options.projectEntries !== undefined) inherited.push(...options.projectEntries);
    else if (Reflect.get(record, 'projectId') !== undefined || Reflect.get(record, 'workspaceId') !== undefined) {
      const machineId = Reflect.get(record, 'machineId');
      const directory = Reflect.get(record, 'path');
      try { inherited.push(...(await resolveSessionProjectPromptStack({ credentials: options.credentials, metadata,
        machineId: typeof machineId === 'string' ? machineId : '', directory: typeof directory === 'string' ? directory : undefined,
        serverId: options.serverId ?? options.credentials.requesterSessionCredentialScope?.serverId,
        operationContext: operation, signal: options.signal })).entries); }
      catch { options.signal?.throwIfAborted(); return { status: 'unavailable' }; }
    }
  }
  inherited = inherited.filter(entry => disabledIds.includes(entry.id));
  if (!await isCurrent()) return { status: 'unavailable' };
  if (![...inherited, ...(entries.success ? entries.data : [])].some(entry => entry.ref.kind === 'bundle'
    && isPromptStackSystemAppendPlacementV1(entry.placement))) return { status: 'ready' };
  const classified = await withCliPromptLibraryArtifactReader(async reader => {
    // Required exclusions must not depend on unrelated positive Session attachments.
    const exclusions = await readStackSkillIdsV1(inherited, { readArtifact: reader.readArtifact });
    if (exclusions.status !== 'ready') return { status: 'unavailable' } as const;
    const own = entries.success ? await readStackSkillIdsV1(entries.data, { readArtifact: reader.readArtifact }) : null;
    const skillIds = new Set([...exclusions.skillIds, ...(own?.status === 'ready' ? own.skillIds : [])]);
    return { status: 'ready', skillIds } as const;
  }, options);
  if (!await isCurrent() || classified.status !== 'ready') return { status: 'unavailable' };
  return classified.skillIds.size > 0 ? { status: 'ready', migration: {
    skillIds: classified.skillIds, disabledInheritedEntries: inherited,
  } } : { status: 'ready' };
}

export function buildSessionModeOverride(opts: {
  sessionModeId?: string;
  sessionModeUpdatedAt?: number;
}): SessionModeOverride {
  if (typeof opts.sessionModeId !== 'string') return null;
  const normalized = opts.sessionModeId.trim();
  if (!normalized) return null;
  return { modeId: normalized, updatedAt: opts.sessionModeUpdatedAt };
}

export function buildPermissionModeOverride(opts: {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
}): PermissionModeOverride {
  if (typeof opts.permissionMode !== 'string') {
    return null;
  }
  return { mode: opts.permissionMode, updatedAt: opts.permissionModeUpdatedAt };
}

export function buildModelOverride(opts: {
  modelSelection?: SessionModelSelection;
}): ModelOverride {
  if (!opts.modelSelection) return null;
  if (opts.modelSelection.v === 2) return opts.modelSelection;
  return {
    v: 1,
    updatedAt: opts.modelSelection.updatedAt,
    selection: opts.modelSelection.ref,
  } satisfies SessionModelSelectionIntentV1;
}

export function applyStartupMetadataUpdateToSession(opts: {
  session: { updateMetadata: (updater: (current: Metadata, context?: SessionMetadataMutationContext) => Metadata) => Promise<void> | void };
  next: Metadata;
  nowMs?: number;
  permissionModeOverride: PermissionModeOverride;
  sessionModeOverride?: SessionModeOverride;
  modelOverride?: ModelOverride;
  capturedTeamCredentialBinding?: SessionTeamCredentialBindingIntentV1 | null;
  metadataKeysToUnsetOnAttach?: readonly string[] | null;
  attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null;
  appliedCapabilitySelection?: SessionCapabilitySelectionV1 | 'preserved_process';
  stackSkillMigration?: SessionStackSkillMigration;
  mode?: 'start' | 'attach';
}): Promise<void> {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  try {
    const result = opts.session.updateMetadata((currentMetadata, context) =>
      mergeSessionMetadataForStartup({
        current: normalizeLegacySessionModeMetadataCompat(currentMetadata),
        next: normalizeLegacySessionModeMetadataCompat(opts.next),
        nowMs,
        permissionModeOverride: opts.permissionModeOverride ?? null,
        sessionModeOverride: opts.sessionModeOverride ?? null,
        modelOverride: opts.modelOverride ?? null,
        capturedTeamCredentialBinding: opts.capturedTeamCredentialBinding,
        acceptedTeamCredentialBinding: context?.acceptedTeamCredentialBinding,
        metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach ?? null,
        attachMetadataIdentityPolicy: opts.attachMetadataIdentityPolicy ?? null,
        appliedCapabilitySelection: opts.appliedCapabilitySelection,
        stackSkillMigration: opts.stackSkillMigration,
        mode: opts.mode ?? 'start',
      }),
    );
    return Promise.resolve(result).catch((error) => {
      logger.debug('[startupMetadata] Failed to update session metadata (apply_startup_metadata_update) (non-fatal)', error);
    });
  } catch (error) {
    logger.debug('[startupMetadata] Failed to update session metadata (apply_startup_metadata_update) (non-fatal)', error);
    return Promise.resolve();
  }
}
