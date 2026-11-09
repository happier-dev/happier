import * as React from 'react';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { resolveRoleRunsAsKindV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { ActionApprovalRequestCreatedResultSchema, isActionApprovalDeclinedErrorCode,
  type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
  ResolvedRoleV1,
  RoleInstructionsOverrideV1} from '@happier-dev/protocol/prompts/roles/rolesV1';
import type {
  RoleArtifactV1,
  RoleEngineV1,
  RoleRunsAsV1,
} from '@happier-dev/protocol/prompts/roles/roleArtifactV1';

import {
  invalidateRoleCatalog,
  useRoleCatalogEntry,
  useRoleCatalogPromptPreview,
} from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { useRoleSessionCount } from '@/components/roles/catalog/useRoleSessionCount';
import { useRoleMark } from '@/components/roles/catalog/useRoleMark';
import { describeRoleRunsAs, describeRoleSource } from '@/components/roles/catalog/rolePresentation';
import { resolvedRoleToArtifact, roleDisplayName } from '@/sync/domains/roles/roleCatalog';
import { HAPPIER_PAGE_METRICS, HappierFieldTextBox, HappierPressable, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import {
  PageHeaderMenu,
  type PageHeaderMenuAction,
} from '@/components/ui/layout/PageHeaderEntityParts';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAiLaunchProfilesForLegacyUi } from '@/sync/store/useAiLaunchProfiles';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { RoleEngineField } from '@/components/roles/engine/RoleEngineField';
import { readRoleInstructionsMarkdown } from './roleInstructionsMarkdown';
import {
  ROLES_COLLECTION_ROOT,
  recordRoleCollectionVisit,
  roleRoute,
} from './roleCollectionRoutes';

export type RoleDetailTarget =
  | Readonly<{ kind: 'role'; roleId: string }>
  | Readonly<{ kind: 'draft' }>;

/** A user role's fields a page edits, or the override fields of a built-in, plugin or shared role. */
type RolePatch = Partial<
  Pick<
    RoleArtifactV1,
    | 'name'
    | 'instructions'
    | 'engine'
    | 'runsAs'
    | 'profileId'
    | 'workspaceWrites'
    | 'secondOpinion'
    | 'canDelegateToOtherRoles'
    | 'enabled'
  >
>;


/** The id `roles.create` answers with, for opening the role it made. */
function readCreatedRoleId(created: unknown): string | null {
  return created && typeof created === 'object' && 'roleId' in created && typeof created.roleId === 'string'
    ? created.roleId : null;
}

function leave(
  router: ReturnType<typeof useRouter>,
  href: string,
  tag: string,
) {
  const result = runGuardedNavigation(() => router.replace(href as never));
  if (result !== true) fireAndForget(result, { tag });
}

/**
 * "Send a copy instead": the role as its portable `role.v1` document — the same body its Artifact
 * holds — handed to the platform's file save or share sheet. No grant is made.
 */
async function sendRoleCopy(role: ResolvedRoleV1, scope: ServerAccountScope): Promise<void> {
  const artifact = resolvedRoleToArtifact(role);
  try {
    const result = await executePortableExport('artifact.export', { portable: { kind: 'role', document: artifact } },
      { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId });
    if (!result.ok && isActionApprovalDeclinedErrorCode(result.errorCode)) return;
    if (result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return;
    if (!result.ok) throw new Error(result.error);
  } catch {
    Modal.alert(t('roles.settings.sendCopyFailed'));
  }
}

const executePortableExport = createFrontDoorActionExecute();

async function reportFailure(
  result: ActionExecuteResult,
): Promise<boolean> {
  if (result.ok) {
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return false;
    invalidateRoleCatalog();
    return true;
  }
  if (isActionApprovalDeclinedErrorCode(result.errorCode)) return false;
  await Modal.alertAsync(t('roles.settings.saveFailed'), result.error ?? '');
  return false;
}

/**
 * One role in Settings › Roles: its identity, its instructions, how it runs and its Launch profile.
 * Built-in, plugin and view-only shared roles save the reader's changes in the prompt-library
 * role-overrides row (Reset removes the override); editable user/shared roles save to their Artifact
 * under its revision.
 */
export const RoleDetailScreen = React.memo(function RoleDetailScreen(
  props: Readonly<{ target: RoleDetailTarget }>,
) {
  const catalog = useRoleCatalogEntry(
    props.target.kind === 'role' ? props.target.roleId : null,
  );
  if (props.target.kind === 'draft') return <RoleDraft />;
  const entry = catalog.entry;
  if (!entry) {
    return (
      <ItemList>
        {catalog.status === 'ready' ? null : <PageHeader title={t('roles.rail.label')} alwaysShowTitle />}
        <SurfaceStateCard
          testID="settings.roles.detail.unavailable"
          kind={
            catalog.status === 'failed'
              ? 'error'
              : catalog.status === 'loading'
                ? 'loading'
                : 'unavailable'
          }
          title={
            catalog.status === 'failed'
              ? t('roles.settings.loadFailed')
              : t('roles.settings.emptyDetailTitle')
          }
          reason={
            catalog.status === 'failed'
              ? undefined
              : t('roles.settings.emptyDetailBody')
          }
          action={
            catalog.status === 'failed'
              ? { label: t('common.retry'), onPress: catalog.refresh }
              : undefined
          }
        />
      </ItemList>
    );
  }
  return <RoleDetail key={entry.roleId} entry={entry} />;
});

const RoleDetail = React.memo(function RoleDetail(
  props: Readonly<{ entry: RoleCatalogEntry }>,
) {
  const { entry } = props;
  const { role } = entry;
  const router = useRouter();
  const presentEngine = useRoleEnginePresentation();
  const engine = presentEngine(role.engine);
  const roleMark = useRoleMark();
  const sessionCount = useRoleSessionCount(entry.roleId);
  // The page title is the name, edited in place: a renamed own role commits when focus leaves it.
  const [nameDraft, setNameDraft] = React.useState(role.name);
  const lastNameRef = React.useRef(role.name);
  if (lastNameRef.current !== role.name) {
    lastNameRef.current = role.name;
    setNameDraft(role.name);
  }
  // Your own roles and roles shared with you to edit save to their Artifact; everything else is an override.
  const ownRole =
    (entry.source === 'user' || entry.source === 'shared') &&
    !entry.viewOnly &&
    entry.revision !== undefined;

  React.useEffect(() => {
    recordRoleCollectionVisit(entry.roleId);
  }, [entry.roleId]);

  const commit = React.useCallback(
    async (patch: RolePatch) => {
      if (ownRole && entry.revision) {
        const base = resolvedRoleToArtifact(role);
        return reportFailure(
          await roleActions.update(
            entry.roleId,
            { ...base, ...patch },
            entry.revision,
          ),
        );
      }
      const { instructions, name: _name, enabled: _enabled, ...fields } = patch;
      const next: RoleInstructionsOverrideV1 = {
        ...(entry.override ?? { roleId: entry.roleId }),
        ...fields,
        ...(instructions !== undefined
          ? { instructionsOverride: instructions }
          : {}),
        roleId: entry.roleId,
      };
      return reportFailure(await roleActions.setOverride(next));
    },
    [entry.override, entry.revision, entry.roleId, ownRole, role],
  );

  // A user/shared role's id is its Artifact id; the sheet owns grant permissions. Share is the
  // header's visible action (lab `settings-R`); the rare operations stay in ⋯.
  const share = React.useMemo(
    () => (entry.source === 'user' || entry.source === 'shared') && entry.roleId
      ? (event?: unknown) => {
          const scope = getActiveServerAccountScope();
          if (!scope) return;
          showDocumentShareSheet({
            anchor: resolvePressTriggerAnchor(event),
            kind: 'role.v1',
            artifactId: entry.roleId,
            name: role.name,
            subtitle: joinHappierFacts(
              engine.pending ? null : engine.label ?? t('roles.rail.defaultEngine'),
              describeRoleRunsAs(role.runsAs.kind),
            ),
            linkPath: roleRoute(entry.roleId),
            onSendCopy: () => {
              void sendRoleCopy(role, scope);
            },
          });
        }
      : null,
    [engine.label, entry.roleId, entry.source, role],
  );
  const resetToDefault = React.useCallback(async () => {
    await reportFailure(await roleActions.resetOverride(entry.roleId));
  }, [entry.roleId]);

  const menuActions = React.useMemo(
    (): readonly PageHeaderMenuAction[] => [
      // Any role can start one of the reader's own: the copy is theirs to change and share.
      {
        id: 'duplicate',
        title: t('roles.settings.duplicate'),
        testID: 'settings.roles.detail.duplicate',
        onSelect: async () => {
          const result = await roleActions.create({
            ...resolvedRoleToArtifact(role),
            name: t('roles.settings.duplicateName', { name: role.name }),
          });
          if (!(await reportFailure(result)) || !result.ok) return;
          const createdRoleId = readCreatedRoleId(result.result);
          if (createdRoleId) leave(router, roleRoute(createdRoleId), 'RoleDetail.duplicated');
        },
      },
      ...(ownRole && entry.source === 'user' && entry.revision
        ? [
            {
              id: 'delete',
              title: t('roles.settings.deleteRole'),
              destructive: true,
              testID: 'settings.roles.detail.delete',
              onSelect: async () => {
                if (!entry.revision) return;
                if (
                  await reportFailure(
                    await roleActions.remove(entry.roleId, entry.revision),
                  )
                ) {
                  leave(router, ROLES_COLLECTION_ROOT, 'RoleDetail.deleted');
                }
              },
            },
          ]
        : []),
    ],
    [entry.revision, entry.roleId, entry.source, ownRole, role, router],
  );

  const meta: PageHeaderMetaFact[] = [
    { key: 'source', text: describeRoleSource(entry) },
    ...(sessionCount > 0
      ? [{ key: 'usedBy', text: t('roles.settings.usedBySessions', { count: sessionCount }) }]
      : []),
    ...(entry.viewOnly
      ? [{ key: 'readOnly', text: t('roles.settings.readOnly') }]
      : []),
    ...(entry.migratedFromV0_2
      ? [{ key: 'migrated', text: t('roles.settings.migrated') }]
      : []),
  ];

  return (
    <ItemList testID={`settings.roles.detail.${entry.roleId}`}>
      <PageHeader
        title={roleDisplayName(role)}
        titleEditor={ownRole ? {
          value: nameDraft,
          placeholder: t('roles.settings.newRoleName'),
          accessibilityLabel: t('roles.settings.nameTitle'),
          testID: 'settings.roles.detail.title',
          onChangeText: setNameDraft,
          onCommit: () => {
            const name = nameDraft.trim();
            if (name && name !== role.name) void commit({ name });
            else setNameDraft(role.name);
          },
        } : undefined}
        meta={meta}
        leading={<PageHeaderMarkSlot>{roleMark(role, 28, entry.roleId)}</PageHeaderMarkSlot>}
        actions={
          <View style={styles.headerActions}>
            {share ? (
              <SectionActionButton
                testID="settings.roles.detail.share"
                title={t('roles.settings.share')}
                icon="users"
                onPress={share}
              />
            ) : null}
            <PageHeaderMenu
              actions={menuActions}
              testID="settings.roles.detail.menu"
            />
          </View>
        }
        alwaysShowTitle
      />
      <ItemGroup
        title={t('roles.settings.instructionsTitle')}
        description={
          entry.viewOnly
            ? t('roles.settings.readOnlyNote')
            : t('roles.settings.instructionsDescription')
        }
        // The field is the section's own surface: no sheet around a bordered box.
        surface="none"
        action={
          entry.override ? (
            <View style={styles.instructionsState}>
              <Text style={styles.instructionsStateText}>{t('roles.settings.edited')}</Text>
              <Text style={styles.instructionsStateSeparator}>·</Text>
              <HappierPressable
                testID="settings.roles.detail.instructions.reset"
                accessibilityRole="button"
                accessibilityLabel={t('roles.settings.resetToDefault')}
                onPress={resetToDefault}
              >
                <Text style={styles.instructionsStateLink}>{t('roles.settings.resetToDefault')}</Text>
              </HappierPressable>
            </View>
          ) : entry.source === 'built_in' ? (
            <Text testID="settings.roles.detail.instructions.platformDefault" style={styles.instructionsStateQuiet}>
              {t('roles.settings.platformDefault')}
            </Text>
          ) : undefined
        }
      >
        <RoleInstructionsField
          value={role.instructions}
          onCommit={(instructions) => {
            void commit({ instructions });
          }}
        />
      </ItemGroup>
      <ItemGroup title={t('roles.settings.howItRunsTitle')}>
        <Item
          testID="settings.roles.detail.engine"
          title={t('roles.settings.engineTitle')}
          subtitle={
            engine.unavailable && role.engine
              ? t('roles.settings.engineUnavailable')
              : role.engine
                ? t('roles.settings.engineDescription')
                : entry.migratedFromV0_2
                  ? t('roles.settings.engineChooseMigrated')
                  : t('roles.settings.engineFollowsDefault')
          }
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={
            <RoleEngineField
              testID="settings.roles.detail.engine.field"
              engine={role.engine}
              label={engine.label}
              leading={engine.icon}
              pending={engine.pending}
              onChange={(next: RoleEngineV1) => {
                void commit({ engine: next });
              }}
            />
          }
        />
        {entry.roleId === 'orchestrator' ? (
          // An orchestrator is the session it is switched on in: there is no runs-as to choose.
          <Item
            testID="settings.roles.detail.runsAs"
            title={t('roles.settings.runsAsTitle')}
            subtitle={t('roles.settings.runsAsOrchestratorDescription')}
            detail={t('roles.settings.runsAsThisSession')}
            detailTestID="settings.roles.detail.runsAs.thisSession"
            showChevron={false}
          />
        ) : <SegmentedChoiceItem<'session' | 'background_run'>
          testIDPrefix="settings.roles.detail.runsAs"
          title={t('roles.settings.runsAsTitle')}
          value={role.runsAs.kind}
          options={[
            {
              id: 'session',
              label: describeRoleRunsAs('session'),
              description: t('roles.settings.runsAsSessionDescription'),
            },
            {
              id: 'background_run',
              label: describeRoleRunsAs('background_run'),
              description: t('roles.settings.runsAsBackgroundDescription'),
            },
          ]}
          onChange={(kind) => {
            const runsAs: RoleRunsAsV1 =
              resolveRoleRunsAsKindV1(kind, role.runsAs);
            void commit({ runsAs });
          }}
        />}
        <Item
          testID="settings.roles.detail.handsOff"
          title={t('roles.settings.handsOffTitle')}
          subtitle={t('roles.settings.handsOffDescription')}
          showChevron={false}
          rightElement={
            <Switch
              value={role.workspaceWrites === 'deny'}
              onValueChange={(on) => {
                void commit({ workspaceWrites: on ? 'deny' : 'allow' });
              }}
            />
          }
        />
        <SegmentedChoiceItem<'off' | 'encouraged'>
          testIDPrefix="settings.roles.detail.secondOpinion"
          title={t('roles.settings.secondOpinionTitle')}
          subtitle={t('roles.settings.secondOpinionDescription')}
          value={role.secondOpinion}
          options={[
            { id: 'off', label: t('roles.settings.secondOpinionOff') },
            {
              id: 'encouraged',
              label: t('roles.settings.secondOpinionEncouraged'),
            },
          ]}
          onChange={(secondOpinion) => {
            void commit({ secondOpinion });
          }}
        />
        <Item
          testID="settings.roles.detail.canDelegateToOtherRoles"
          title={t('roles.settings.canDelegateToOtherRolesTitle')}
          subtitle={t('roles.settings.canDelegateToOtherRolesDescription')}
          showChevron={false}
          rightElement={
            <Switch
              value={role.canDelegateToOtherRoles === true}
              onValueChange={(canDelegateToOtherRoles) => {
                void commit({ canDelegateToOtherRoles });
              }}
            />
          }
        />
        {ownRole ? (
          <Item
            testID="settings.roles.detail.enabled"
            title={t('roles.settings.enabledTitle')}
            subtitle={t('roles.settings.enabledDescription')}
            showChevron={false}
            rightElement={
              <Switch
                value={role.enabled}
                onValueChange={(enabled) => {
                  void commit({ enabled });
                }}
              />
            }
          />
        ) : null}
      </ItemGroup>
      <ItemGroup title={t('roles.settings.advancedTitle')}>
        <RoleLaunchProfileRow
          profileId={role.profileId ?? null}
          unavailable={role.profileUnavailable === true}
          onChange={(profileId) => {
            void commit({ profileId: profileId ?? undefined });
          }}
        />
        <RolePreviewDisclosure entry={entry} />
      </ItemGroup>
    </ItemList>
  );
});

/** Keep one selectable preview mounted while the resolved trait changes its catalog demand. */
function RolePreview(props: Readonly<{ entry: RoleCatalogEntry }>) {
  const block = useRoleCatalogPromptPreview(props.entry.role);
  return <RolePreviewBlock block={block} />;
}

/**
 * "What agents read": rare, read-only detail, so it opens in place under Advanced. The block (and,
 * for a delegating role, the cross-role facts it names) is resolved only while it is open.
 */
function RolePreviewDisclosure(props: Readonly<{ entry: RoleCatalogEntry }>) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <ExpandableItem
      testID="settings.roles.detail.preview.disclosure"
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={({ headerProps }) => (
        <Item
          {...(headerProps as Readonly<Record<string, unknown>>)}
          testID="settings.roles.detail.preview"
          title={t('roles.settings.previewTitle')}
          subtitle={t('roles.settings.previewDescription')}
        />
      )}
    >
      {expanded ? <RolePreview entry={props.entry} /> : null}
    </ExpandableItem>
  );
}

/** The whole block, read-only and selectable, in the canonical code block (it grows with the block). */
function RolePreviewBlock(props: Readonly<{ block: string }>) {
  return (
    <View testID="settings.roles.detail.preview.block" style={styles.previewBody}>
      <CodeBlockView code={props.block} wrap showCopyButton />
    </View>
  );
}


const NO_PROFILE_ID = '__none__';

/** Advanced › Launch profile: a field select over the reader's profiles; a missing one says so. */
function RoleLaunchProfileRow(
  props: Readonly<{
    profileId: string | null;
    unavailable: boolean;
    onChange: (profileId: string | null) => void;
  }>,
) {
  const profiles = useAiLaunchProfilesForLegacyUi();
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo(
    () => [
      { id: NO_PROFILE_ID, title: t('roles.settings.launchProfileNone') },
      ...profiles.map((profile) => ({ id: profile.id, title: profile.name })),
    ],
    [profiles],
  );
  const known =
    props.profileId !== null &&
    profiles.some((profile) => profile.id === props.profileId);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={
        props.profileId === null
          ? NO_PROFILE_ID
          : known
            ? props.profileId
            : null
      }
      onSelect={(id) => props.onChange(id === NO_PROFILE_ID ? null : id)}
      itemTrigger={{
        title: t('roles.settings.launchProfileTitle'),
        subtitle:
          props.profileId !== null && (props.unavailable || !known)
            ? t('roles.settings.profileUnavailable')
            : t('roles.settings.launchProfileDescription'),
      }}
    />
  );
}

/** A page text field whose draft commits when focus leaves it. */
function CommitOnBlurField(
  props: Readonly<{
    value: string;
    onCommit: (value: string) => void;
    accessibilityLabel: string;
    multiline?: boolean;
    minLines?: number;
    editable?: boolean;
    placeholder?: string;
    testID?: string;
    onDraftChange?: (value: string) => void;
    presentation?: 'field' | 'document';
    autoFocus?: boolean;
    /** Focus left the field, after any changed draft was committed. */
    onBlurred?: () => void;
  }>,
) {
  const [draft, setDraft] = React.useState(props.value);
  const lastValueRef = React.useRef(props.value);
  if (lastValueRef.current !== props.value) {
    lastValueRef.current = props.value;
    setDraft(props.value);
  }
  return (
    <FieldTextInput
      testID={props.testID}
      value={draft}
      onChangeText={(next) => {
        setDraft(next);
        props.onDraftChange?.(next);
      }}
      onBlur={() => {
        if (draft !== props.value) props.onCommit(draft);
        props.onBlurred?.();
      }}
      autoFocus={props.autoFocus}
      accessibilityLabel={props.accessibilityLabel}
      multiline={props.multiline}
      minLines={props.minLines}
      editable={props.editable}
      placeholder={props.placeholder}
      presentation={props.presentation}
    />
  );
}

/**
 * A role's instructions: read as a list, one rule per line (lab `settings-R`), and edited in place by
 * pressing them. The stored text is exactly what the field holds; only the reading is structured.
 */
function RoleInstructionsField(
  props: Readonly<{ value: string; onCommit: (value: string) => void }>,
) {
  const { theme } = useUnistyles();
  const [editing, setEditing] = React.useState(false);
  const markdown = React.useMemo(() => readRoleInstructionsMarkdown(props.value), [props.value]);
  const startEditing = React.useCallback(() => setEditing(true), []);
  const stopEditing = React.useCallback(() => setEditing(false), []);
  if (editing || props.value.trim().length === 0) {
    return (
      <CommitOnBlurField
        testID="settings.roles.detail.instructions"
        value={props.value}
        multiline
        presentation="document"
        minLines={4}
        autoFocus={editing}
        accessibilityLabel={t('roles.settings.instructionsTitle')}
        onCommit={props.onCommit}
        onBlurred={stopEditing}
      />
    );
  }
  return (
    <Pressable
      testID="settings.roles.detail.instructions.read"
      accessibilityRole="button"
      accessibilityLabel={t('roles.settings.instructionsTitle')}
      accessibilityHint={t('common.edit')}
      onPress={startEditing}
    >
      <HappierFieldTextBox
        presentation="document"
        multiline
        colors={resolveFieldBoxColors(theme, 'idle', 'document')}
      >
        {/* The field box centres what it holds; the reading fills its width, left-aligned. */}
        <View style={styles.instructionsRead}>
          <MarkdownView markdown={markdown} textStyle={styles.instructionsBody} />
        </View>
      </HappierFieldTextBox>
    </Pressable>
  );
}

/** A new role: its name and instructions, created as your own role. */
const RoleDraft = React.memo(function RoleDraft() {
  const roleDraftTitle = useCollectionDraftTitle();
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [instructions, setInstructions] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  React.useEffect(
    () => () => {
      roleDraftTitle.publish('');
    },
    [roleDraftTitle],
  );
  const create = async () => {
    setSaving(true);
    const result = await roleActions.create({
      name: name.trim() || t('roles.settings.newRoleName'),
      instructions,
      runsAs: { kind: 'session' },
      workspaceWrites: 'allow',
      secondOpinion: 'off',
      enabled: true,
    });
    setSaving(false);
    if (!(await reportFailure(result)) || !result.ok) return;
    // The new role is what the reader goes on with: open it, not the role visited before the draft.
    const createdRoleId = readCreatedRoleId(result.result);
    leave(router, createdRoleId ? roleRoute(createdRoleId) : ROLES_COLLECTION_ROOT, 'RoleDraft.created');
  };
  return (
    <ItemList testID="settings.roles.draft">
      <PageHeader
        title={name.trim() || t('roles.settings.newRoleName')}
        alwaysShowTitle
        primaryAction={{
          title: t('roles.settings.newRole'),
          onPress: create,
          loading: saving,
          testID: 'settings.roles.draft.create',
        }}
        cancelAction={{
          title: t('common.cancel'),
          onPress: () =>
            leave(router, ROLES_COLLECTION_ROOT, 'RoleDraft.cancel'),
        }}
      />
      <ItemGroup title={t('roles.settings.nameTitle')} surface="none">
        <FieldTextInput
          testID="settings.roles.draft.name"
          value={name}
          onChangeText={(next) => {
            setName(next);
            roleDraftTitle.publish(next);
          }}
          accessibilityLabel={t('roles.settings.nameTitle')}
          placeholder={t('roles.settings.newRoleName')}
          autoFocus
        />
      </ItemGroup>
      <ItemGroup
        title={t('roles.settings.instructionsTitle')}
        description={t('roles.settings.instructionsDescription')}
        surface="none"
      >
        <FieldTextInput
          testID="settings.roles.draft.instructions"
          value={instructions}
          onChangeText={setInstructions}
          accessibilityLabel={t('roles.settings.instructionsTitle')}
          multiline
          presentation="document"
          minLines={4}
        />
      </ItemGroup>
    </ItemList>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The block sits on the row inset, under its header, inside the Advanced sheet.
  previewBody: {
    paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
    paddingBottom: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  instructionsRead: {
    alignSelf: 'stretch',
    // The press target is a <button> on web, which centres its text; the reading is left-aligned.
    textAlign: 'left',
  },
  instructionsBody: {
    ...Typography.variant('body'),
    color: theme.colors.text.primary,
    textAlign: 'left',
  },
  instructionsState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  instructionsStateText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  instructionsStateSeparator: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  instructionsStateLink: {
    ...Typography.variant('meta'),
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  instructionsStateQuiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
