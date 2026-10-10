import { PromptStackPreparationError, type PromptStackSystemAppendInputV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { resolvePromptStackSystemAppendBlocksV1 } from '@/sync/ops/promptLibrary/resolvePromptStackSystemAppendBlocksV1';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readPromptLibraryCatalogProjectionInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { readProfileCatalogProjectionInContext } from '@/sync/api/account/apiProfileCatalog';
import { readAuthoringMemoryLastUsedProfileInContext } from '@/sync/api/account/apiAuthoringMemory';
import { readUiVisibleProfileCatalogSnapshot, readUiSelectedProfileCatalogProfile } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { readUiSessionProjectPromptStack } from '@/sync/ops/actions/readUiMemoryInheritedContext';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { migrateRetainedSessionWorkContextV1, SessionPromptStackV1Schema, SessionDisabledInheritedEntryIdsV1Schema,
  readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { renderSessionRoleBlockV1 } from '@happier-dev/protocol/prompts/roles/renderSessionRoleBlockV1';
import { createRoleSourceReaderV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { readUiPluginRoleSources } from '@/sync/ops/roles/roleSources';

export type UiVoicePromptStackInput = Omit<PromptStackSystemAppendInputV1, 'surface' | 'readArtifact'>
& Partial<Pick<PromptStackSystemAppendInputV1, 'readArtifact'>> & Readonly<{
  serverId?: string | null;
  accountContext?: LazyActionAccountContext;
  targetSessionAddress?: SessionAddress | null;
}>;

export async function resolveUiVoicePromptStackBlocks(args?: UiVoicePromptStackInput): Promise<string[]> {
  const explicitSources = args?.accountEntries !== undefined || args?.profileEntries !== undefined
    || args?.promptStacksV1 !== undefined;
  const resolve = async (input: UiVoicePromptStackInput, accountContext?: LazyActionAccountContext,
    assertCurrent: () => void = () => accountContext?.assertCurrent()) => {
    try {
      input.signal?.throwIfAborted();
      assertCurrent();
      const result = input.readArtifact
        ? await resolvePromptStackSystemAppendBlocksV1({ ...input, surface: 'voice', readArtifact: input.readArtifact })
        : await withUiPromptLibraryArtifactReader(reader => resolvePromptStackSystemAppendBlocksV1({ ...input,
          surface: 'voice', ...reader }), { serverId: input.serverId, signal: input.signal, accountContext });
      input.signal?.throwIfAborted();
      assertCurrent();
      return result;
    } catch (error) {
      input.signal?.throwIfAborted();
      try { assertCurrent(); }
      catch { throw new PromptStackPreparationError('unavailable'); }
      throw error;
    }
  };
  if (args && explicitSources && !args.targetSessionAddress) return (await resolve(args, args.accountContext)).blocks;
  // A global unbound Voice call does not borrow the focused Account or Session.
  const target = args?.targetSessionAddress;
  const serverId = target?.serverId || args?.serverId?.trim() || args?.accountContext?.serverId;
  if (!serverId) return [];
  let owned: LazyActionAccountContext | undefined;
  try {
    const borrowed = args?.accountContext;
    if (borrowed && !areServerProfileIdentifiersEquivalent(serverId, borrowed.serverId))
      throw new PromptStackPreparationError('unavailable');
    const context = borrowed ?? (owned = await captureLazyActionAccountContext(serverId, args?.signal));
    const metadata = target ? readVoiceSessionOwnerMetadataFromState(storage.getState(), target) : null;
    if (target && !metadata) throw new PromptStackPreparationError('unavailable');
    const assertCurrent = () => {
      args?.signal?.throwIfAborted();
      context.assertCurrent();
      if (target && !readVoiceSessionOwnerMetadataFromState(storage.getState(), target)) throw new PromptStackPreparationError('unavailable');
    };
    assertCurrent();
    const projection = await readPromptLibraryCatalogProjectionInContext(context, args?.signal);
    const source = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key: 'voice', rawSettings: projection.rawSettings });
    if (source.status !== 'ready' || source.record.key !== 'voice') throw new PromptStackPreparationError('unavailable');
    let profileEntries: NonNullable<PromptStackSystemAppendInputV1['profileEntries']> = [];
    const profileId = target ? metadata?.profileId : args?.profileId;
    if (profileId) {
      const profile = await readProfileCatalogProjectionInContext(context, args?.signal);
      assertCurrent();
      let rawSettings = await context.readRawSettings();
      assertCurrent();
      let admitted = readUiVisibleProfileCatalogSnapshot(profile, rawSettings, { lastUsedProfile: null });
      if (!admitted.available || admitted.unreadableCount > 0) throw new PromptStackPreparationError('unavailable');
      let selected = readUiSelectedProfileCatalogProfile(admitted, rawSettings, profileId);
      // Entity, favorite, enablement and binding evidence already suffice. Read memory only for an otherwise hidden selection.
      if (!selected && !admitted.profiles.some(candidate => candidate.id === profileId)) {
        const lastUsedProfile = await readAuthoringMemoryLastUsedProfileInContext(context, args?.signal);
        rawSettings = await context.readRawSettings();
        assertCurrent();
        admitted = readUiVisibleProfileCatalogSnapshot(profile, rawSettings, { lastUsedProfile });
        selected = readUiSelectedProfileCatalogProfile(admitted, rawSettings, profileId);
      }
      if (!selected) throw new PromptStackPreparationError('unavailable');
      profileEntries = selected.promptStack ?? [];
    }
    const work = target ? migrateRetainedSessionWorkContextV1(metadata?.work) : null;
    const projectEntries = metadata ? await readUiSessionProjectPromptStack(context, { metadata, revision: 0 },
      { surface: 'voice', signal: args?.signal }) : args?.projectEntries;
    assertCurrent();
    const result = await resolve({ ...args, serverId: context.serverId, profileId,
      scope: { serverId: context.serverId, accountId: context.accountId,
        ...(target ? { sessionId: target.sessionId } : {}),
        ...(typeof metadata?.projectId === 'string' ? { projectKey: metadata.projectId } : {}),
        ...(profileId ? { profileId } : {}),
      },
      accountEntries: args?.accountEntries ?? source.record.value.entries, profileEntries: args?.profileEntries ?? profileEntries,
      ...(work ? { projectEntries,
        sessionEntries: createStoredReadSchema(SessionPromptStackV1Schema).parse(work.promptStack ?? []),
        disabledInheritedEntryIds: createStoredReadSchema(SessionDisabledInheritedEntryIdsV1Schema).parse(work.disabledInheritedEntryIds ?? []),
        memoryEnabled: readSessionMemoryEnabledV1(metadata) } : {}),
    }, context, assertCurrent);
    assertCurrent();
    const roles = readSessionRolesV1(metadata);
    if (roles) {
      const inherited = roles.roleId ? roles.sessionRoles[roles.roleId] : undefined;
      const overrides = inherited || !roles.roleId ? undefined : readPromptLibraryCatalogRecordV1({ catalog: projection.catalog,
        key: 'role-overrides', rawSettings: projection.rawSettings });
      if (overrides && (overrides.status !== 'ready' || overrides.record.key !== 'role-overrides')) throw new PromptStackPreparationError('unavailable');
      const inventory = inherited || !roles.roleId ? undefined : await createRoleSourceReaderV1({
        accountId: context.accountId, artifactStore: context.workflowArtifacts, readRawAccountSettings: context.readRawSettings,
        readPluginRoles: signal => readUiPluginRoleSources(context, signal),
      })(args?.signal);
      assertCurrent();
      const selected = roles.roleId ? resolveRoleSelectionV1({ roleId: roles.roleId, sessionRoles: roles,
        roleSourceInventory: inventory,
        ...(overrides?.status === 'ready' && overrides.record.key === 'role-overrides' ? { settingsOverrides: overrides.record.value.overrides } : {}),
      }) : null;
      if (selected && !selected.ok) throw new PromptStackPreparationError('unavailable');
      const block = renderSessionRoleBlockV1({ modality: 'voice', ...(selected?.ok ? { role: selected.selection } : {}), notes: roles.notes });
      if (block) result.blocks.push(block);
    }
    assertCurrent();
    return result.blocks;
  } catch (error) {
    args?.signal?.throwIfAborted();
    if (error instanceof PromptStackPreparationError) throw error;
    throw new PromptStackPreparationError('unavailable');
  } finally { owned?.dispose(); }
}
