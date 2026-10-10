import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';
import { Tree, type TreeItem } from '@happier-dev/plugin-ui';
import {
  createHappierCollectionDraftTitleStore,
  type HappierCollectionDraftTitleStore,
} from '@happier-dev/plugin-ui/presentation';
import { isArtifactFolderActionIdV1 } from '@happier-dev/protocol/prompts/library/artifactFolderActionIdsV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import type { PromptFolderEntryV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';
import type {
  EntityDragScopeV1,
  EntityDropOutcomeV1,
} from '@happier-dev/protocol/plugins/ui';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import {
  useEntityDragDropSnapshot,
  useEntityDragSourceState,
} from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type {
  EntityDragDropRuntime,
  EntityDropDestination,
} from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { readWindowBounds } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';
import type {
  TreeContainerDropZone,
  TreeRow,
} from '@/components/ui/treeDragDrop/treeDragDropTypes';
import { TreeDropOutline } from '@/components/ui/treeDragDrop/ui/TreeDropOutline';
import {
  useEntityDragDomBinding,
  useEntityDropDomBinding,
} from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifacts } from '@/sync/domains/state/storage';
import { refreshPromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import {
  findPromptFolderByName,
  normalizePromptFolderName,
} from '@/sync/ops/promptLibrary/promptFolders';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { isHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  projectArtifactBrowserRows,
  type ArtifactBrowserFilter,
  type ArtifactBrowserTreeNode,
} from './artifactBrowserModel';
import {
  ARTIFACT_KIND_ICONS,
  artifactKindLabel,
} from './artifactKindPresentation';
import {
  useArtifactBrowserDragSource,
  useArtifactBrowserDropTarget,
} from './useArtifactBrowserDragDrop';
import {
  useArtifactBrowserTree,
  useArtifactFolderActions,
} from './useArtifactBrowserTree';
import { useArtifactOperations } from './useArtifactOperations';

type Node = ArtifactBrowserTreeNode<DecryptedArtifact>;
type FolderActions = ReturnType<typeof useArtifactFolderActions>;

/** A signed-out tree registers nothing current; the runtime never admits a carry for it. */
const NO_SCOPE: EntityDragScopeV1 = { serverId: 'none', accountId: 'none' };
const ROOT_ZONE_ID = 'artifact-folders-root';
const KIND_COLUMN_PX = 132;
const AGE_COLUMN_PX = 56;
const MENU_COLUMN_PX = 32;

function refusalMessage(code: string): string {
  if (code === 'catalog-unavailable')
    return t('artifacts.browser.folders.refusedUnavailable');
  if (
    code === 'descendant-cycle' ||
    code === 'folder_cycle' ||
    code === 'same-position'
  )
    return t('artifacts.browser.folders.refusedCycle');
  return t('artifacts.browser.folders.refusedOther');
}

/**
 * The folder operations of the one personal Artifact tree: each is one `artifact.folders.*` Action at the reviewed
 * catalog revision (`useArtifactFolderActions`). Editors retain drafts and render refusals; delete confirms.
 */
export function useArtifactFolderCommands(): Readonly<{
  canWrite: boolean;
  create: (input: Readonly<{
    id: string;
    parentId: string | null;
    name: string;
  }>) => Promise<string>;
  rename: (folder: PromptFolderEntryV1, rawName: string) => Promise<void>;
  remove: (folder: PromptFolderEntryV1) => Promise<void>;
  execute: FolderActions['execute'];
  catalog: FolderActions['catalog'];
}> {
  const { catalog, canWrite, execute } = useArtifactFolderActions();
  const settle = React.useCallback(
    async (run: () => Promise<unknown>): Promise<boolean> => {
      try {
        await run();
        return true;
      } catch {
        Modal.alert(
          t('common.error'),
          t('artifacts.browser.folders.saveFailed'),
        );
        return false;
      }
    },
    [],
  );
  const create = React.useCallback(
    async (input: Readonly<{ id: string; parentId: string | null; name: string }>) => {
      const name = normalizePromptFolderName(input.name);
      // A name that already exists is that folder; asking twice never makes a second one.
      const existing = findPromptFolderByName(catalog.value, name);
      if (existing) return existing.id;
      await execute('artifact.folders.create', { ...input, name });
      return input.id;
    },
    [catalog.value, execute],
  );
  const rename = React.useCallback(
    async (folder: PromptFolderEntryV1, rawName: string) => {
      const name = normalizePromptFolderName(rawName);
      if (!name || name === folder.name) return;
      await execute('artifact.folders.rename', { folderId: folder.id, name });
    },
    [execute],
  );
  const remove = React.useCallback(
    async (folder: PromptFolderEntryV1) => {
      const confirmed = await Modal.confirm(
        t('artifacts.browser.folders.deleteTitle', { name: folder.name }),
        t('artifacts.browser.folders.deleteBody'),
        { confirmText: t('common.delete'), destructive: true },
      );
      if (confirmed)
        await settle(() =>
          execute('artifact.folders.delete', { folderId: folder.id }),
        );
    },
    [execute, settle],
  );
  return React.useMemo(
    () => ({ canWrite, create, rename, remove, execute, catalog }),
    [canWrite, create, rename, remove, execute, catalog],
  );
}

type FolderEdit = Readonly<{
  scopeKey: string;
  titles: HappierCollectionDraftTitleStore;
}> & (
  | Readonly<{ kind: 'create'; id: string; parentId: string | null }>
  | Readonly<{ kind: 'rename'; folder: PromptFolderEntryV1 }>
);

export type ArtifactFolderTreeHandle = Readonly<{
  createFolder: (parentId: string | null) => void;
}>;

type TreeContextValue = Readonly<{
  runtime: EntityDragDropRuntime;
  targetId: string;
  scope: EntityDragScopeV1;
  canWrite: boolean;
  commands: ReturnType<typeof useArtifactFolderCommands>;
  orderedFolders: readonly Readonly<{
    folder: PromptFolderEntryV1;
    depth: number;
  }>[];
  counts: ReadonlyMap<string, number>;
  wide: boolean;
  testID: string;
  registerRow: (key: string, node: unknown) => void;
  onOpenArtifact: (artifactId: string) => void;
  onArtifactDeleted: (artifactId: string) => void;
  createFolder: (parentId: string | null) => void;
  renameFolder: (folder: PromptFolderEntryV1) => void;
}>;
const TreeContext = React.createContext<TreeContextValue | null>(null);
const RowRevealContext = React.createContext(false);

function useTreeContext(): TreeContextValue {
  const value = React.useContext(TreeContext);
  if (!value)
    throw new Error('ArtifactFolderTree row rendered outside its tree');
  return value;
}

/**
 * The Artifacts library as one personal folder tree (EC D49, lab `lane12-final/c-art`): every listed kind under
 * the viewer's own folders, drawn by the shared `Tree` and moved through the shared entity drag-and-drop runtime.
 * The hierarchy, its filter and its admission live in D14's owners (`useArtifactBrowserTree`,
 * `artifactBrowserDragDrop`); this component only draws them. The Artifacts browser shows every kind; the Prompt
 * Library passes the prompt kind. Filing is personal: no operation here touches an Artifact, its grants or what
 * other people see.
 */
export const ArtifactFolderTree = React.forwardRef(function ArtifactFolderTree(
  props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    filter: ArtifactBrowserFilter;
    /** A surface that already holds its Artifacts (the fixture browser); the store is the default. */
    artifacts?: readonly DecryptedArtifact[];
    selectedArtifactId?: string | null;
    onOpenArtifact: (artifactId: string) => void;
    onArtifactDeleted?: (artifactId: string) => void;
  }>,
  ref: React.ForwardedRef<ArtifactFolderTreeHandle>,
): React.ReactElement {
  const styles = stylesheet;
  const wide = useDeviceType() !== 'phone';
  const settingsScope = useAccountSettingsScope();
  const scope = React.useMemo<EntityDragScopeV1 | null>(
    () =>
      settingsScope
        ? {
            serverId: settingsScope.serverId,
            accountId: settingsScope.accountId,
          }
        : null,
    [settingsScope?.accountId, settingsScope?.serverId],
  );
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const { tree, catalog, canWrite } = useArtifactBrowserTree(
    props.filter,
    collapsed,
    props.artifacts,
  );
  const commands = useArtifactFolderCommands();
  const folders = catalog.value;
  const scopeKey = JSON.stringify([
    settingsScope?.serverId,
    settingsScope?.accountId,
  ]);
  const [edit, setEdit] = React.useState<FolderEdit | null>(null);
  const currentEdit =
    edit?.scopeKey === scopeKey &&
    (edit.kind === 'create'
      ? edit.parentId === null || folders?.folders.some(folder => folder.id === edit.parentId)
      : folders?.folders.some(folder => folder.id === edit.folder.id))
      ? edit
      : null;
  React.useEffect(() => {
    if (edit && !currentEdit && catalog.status !== 'loading') setEdit(null);
  }, [catalog.status, currentEdit, edit]);
  const revealFolder = React.useCallback((folderId: string | null) => {
    if (folderId === null) return;
    setCollapsed(current => {
      const next = new Set(current);
      const seen = new Set<string>();
      let id: string | null = folderId;
      while (id && !seen.has(id)) {
        seen.add(id);
        next.delete(id);
        id = folders?.folders.find(folder => folder.id === id)?.parentId ?? null;
      }
      return next;
    });
  }, [folders]);
  const createFolder = React.useCallback((parentId: string | null) => {
    if (!commands.canWrite) return;
    revealFolder(parentId);
    setEdit(current =>
      current?.scopeKey === scopeKey && current.kind === 'create' && current.parentId === parentId
        ? current
        : {
            kind: 'create',
            id: randomUUID(),
            parentId,
            scopeKey,
            titles: createHappierCollectionDraftTitleStore(),
          },
    );
  }, [commands.canWrite, revealFolder, scopeKey]);
  const renameFolder = React.useCallback((folder: PromptFolderEntryV1) => {
    if (!commands.canWrite) return;
    revealFolder(folder.parentId ?? null);
    setEdit(current => {
      if (current?.scopeKey === scopeKey && current.kind === 'rename' && current.folder.id === folder.id) return current;
      const titles = createHappierCollectionDraftTitleStore();
      titles.publish(folder.name);
      return { kind: 'rename', folder, scopeKey, titles };
    });
  }, [commands.canWrite, revealFolder, scopeKey]);
  React.useImperativeHandle(ref, () => ({ createFolder }), [createFolder]);
  const finishEdit = React.useCallback((finished: FolderEdit) => {
    setEdit(current => current === finished ? null : current);
  }, []);

  const orderedFolders = React.useMemo(() => {
    const children = new Map<string | null, PromptFolderEntryV1[]>();
    const known = new Set((folders?.folders ?? []).map((folder) => folder.id));
    for (const folder of folders?.folders ?? []) {
      const parent =
        folder.parentId && known.has(folder.parentId) ? folder.parentId : null;
      children.set(parent, [...(children.get(parent) ?? []), folder]);
    }
    const ordered: { folder: PromptFolderEntryV1; depth: number }[] = [];
    const seen = new Set<string>();
    const append = (parentId: string | null, depth: number) => {
      const siblings = (children.get(parentId) ?? [])
        .slice()
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
      for (const folder of siblings) {
        if (seen.has(folder.id)) continue;
        seen.add(folder.id);
        ordered.push({ folder, depth });
        append(folder.id, depth + 1);
      }
    };
    append(null, 0);
    return ordered;
  }, [folders]);

  // What each folder holds, its folders' items included, under the current filter.
  const stored = useArtifacts();
  const listed = props.artifacts ?? stored;
  const counts = React.useMemo(() => {
    const result = new Map<string, number>();
    const parents = new Map(
      (folders?.folders ?? []).map((folder) => [
        folder.id,
        folder.parentId ?? null,
      ]),
    );
    const rows = folders
      ? projectArtifactBrowserRows(listed, props.filter, { folders })
      : [];
    for (const row of rows) {
      const visited = new Set<string>();
      let id = row.folderId;
      while (id && parents.has(id) && !visited.has(id)) {
        visited.add(id);
        result.set(id, (result.get(id) ?? 0) + 1);
        id = parents.get(id) ?? null;
      }
    }
    return result;
  }, [folders, listed, props.filter]);

  const hostNode = React.useRef<unknown>(null);
  const rootZoneNode = React.useRef<unknown>(null);
  const rowNodes = React.useRef(new Map<string, unknown>());
  const registerRow = React.useCallback((key: string, node: unknown) => {
    if (node) rowNodes.current.set(key, node);
    else rowNodes.current.delete(key);
  }, []);
  const targetId = `artifact-folder-tree:${React.useId()}`;
  const { runtime } = useArtifactBrowserDropTarget({
    id: targetId,
    scope: scope ?? NO_SCOPE,
    isCurrent: () => scope !== null,
    getCatalog: () => ({ folders, revision: catalog.revision, canWrite }),
    getBounds: () => readWindowBounds(hostNode.current),
    getRows: () =>
      tree.flatMap((node): TreeRow[] => {
        const bounds = readWindowBounds(rowNodes.current.get(node.key));
        return bounds
          ? [
              {
                id: node.key,
                parentId: node.parentKey,
                containerId: node.parentKey ?? ROOT_ZONE_ID,
                depth: node.depth,
                kind: node.kind === 'branch' ? 'container' : 'leaf',
                bounds,
              },
            ]
          : [];
      }),
    getDropZones: (): TreeContainerDropZone[] => {
      const bounds = readWindowBounds(rootZoneNode.current);
      return bounds
        ? [
            {
              containerId: ROOT_ZONE_ID,
              rootId: ROOT_ZONE_ID,
              parentId: null,
              depth: 0,
              bounds,
              role: 'root-after-last',
            },
          ]
        : [];
    },
    describeFolder: (folder) =>
      folder?.name ?? t('artifacts.browser.folders.topLevel'),
    describeMove: () => t('artifacts.browser.folders.moveVerb'),
    describeRefusal: refusalMessage,
    execute: async (effect): Promise<EntityDropOutcomeV1> => {
      const input = effect.input;
      if (
        !isArtifactFolderActionIdV1(effect.actionId) ||
        !isRecord(input)
      ) {
        return {
          status: 'refused',
          reason: {
            code: 'kind-not-accepted',
            message: refusalMessage('kind-not-accepted'),
          },
        };
      }
      try {
        await commands.execute(effect.actionId, input);
        return { status: 'applied' };
      } catch (error) {
        const code =
          error instanceof Error && error.message ? error.message : 'unknown';
        return {
          status: 'refused',
          reason: { code, message: t('artifacts.browser.folders.saveFailed') },
        };
      }
    },
  });
  const dropDom = useEntityDropDomBinding(scope ? runtime : undefined);
  const hostRef = React.useCallback(
    (node: unknown) => {
      hostNode.current = node;
      dropDom(node);
    },
    [dropDom],
  );

  const { onOpenArtifact, onArtifactDeleted } = props;
  const context = React.useMemo<TreeContextValue>(
    () => ({
      runtime,
      targetId,
      scope: scope ?? NO_SCOPE,
      canWrite: canWrite && scope !== null,
      commands,
      orderedFolders,
      counts,
      wide,
      testID: props.testID,
      registerRow,
      onOpenArtifact,
      onArtifactDeleted: onArtifactDeleted ?? noop,
      createFolder,
      renameFolder,
    }),
    [
      canWrite,
      commands,
      counts,
      onArtifactDeleted,
      createFolder,
      renameFolder,
      onOpenArtifact,
      orderedFolders,
      props.testID,
      registerRow,
      runtime,
      scope,
      targetId,
      wide,
    ],
  );

  const nodesByKey = React.useMemo(
    () => new Map(tree.map((node) => [node.key, node])),
    [tree],
  );
  const items = React.useMemo(
    (): TreeItem[] =>
      tree.map((node) => ({
        key: node.key,
        parentKey: node.parentKey,
        depth: node.depth,
        kind: node.kind,
        expanded: node.expanded,
        title:
          node.kind === 'leaf' && node.row.artifact.isDecrypted === false
            ? t('settingsAccount.restoreRequiredTitle')
            : node.title || t('artifacts.untitled'),
        mark: <NodeMark node={node} />,
      })),
    [tree],
  );
  const editKey = currentEdit
    ? currentEdit.kind === 'rename'
      ? `folder:${currentEdit.folder.id}`
      : `draft:${currentEdit.id}`
    : null;
  const editingItems = React.useMemo(() => {
    if (currentEdit?.kind !== 'create') return items;
    const parentKey = currentEdit.parentId === null ? null : `folder:${currentEdit.parentId}`;
    const parentIndex = items.findIndex(item => item.key === parentKey);
    const parent = items[parentIndex];
    const draft: TreeItem = {
      key: `draft:${currentEdit.id}`,
      parentKey,
      depth: parent ? parent.depth + 1 : 0,
      kind: 'leaf',
      expanded: false,
      title: t('artifacts.browser.folders.newFolder'),
      mark: <Icon name="folder" />,
    };
    return [...items.slice(0, parentIndex + 1), draft, ...items.slice(parentIndex + 1)];
  }, [currentEdit, items]);
  const renderInlineEdit = React.useCallback(
    (item: TreeItem) => currentEdit && item.key === editKey ? (
      <FolderInlineEditor
        key={`${scopeKey}:${editKey}`}
        edit={currentEdit}
        commands={commands}
        canWrite={context.canWrite}
        testID={props.testID}
        onFinish={finishEdit}
      />
    ) : null,
    [commands, context.canWrite, currentEdit, editKey, finishEdit, props.testID, scopeKey],
  );

  const onExpandedChange = React.useCallback(
    (key: string, expanded: boolean) => {
      const folderId = key.slice('folder:'.length);
      setCollapsed((current) => {
        const next = new Set(current);
        if (expanded) next.delete(folderId);
        else next.add(folderId);
        return next;
      });
    },
    [],
  );
  const onActivate = React.useCallback(
    (key: string) => {
      const node = nodesByKey.get(key);
      if (!node) return;
      if (node.kind === 'branch') onExpandedChange(key, !node.expanded);
      else onOpenArtifact(node.row.key);
    },
    [nodesByKey, onExpandedChange, onOpenArtifact],
  );
  const renderTrailing = React.useCallback(
    (item: TreeItem) => {
      const node = nodesByKey.get(item.key);
      return node ? <RowTrailing node={node} title={item.title} /> : null;
    },
    [nodesByKey],
  );
  const wrapRow = React.useCallback(
    (item: TreeItem, row: React.ReactElement) => {
      const node = nodesByKey.get(item.key);
      return node ? (
        <RowHost node={node} title={item.title}>
          {row}
        </RowHost>
      ) : (
        row
      );
    },
    [nodesByKey],
  );

  const unavailable =
    scope !== null && catalog.status !== 'loading' && !canWrite;
  const noFolders = canWrite && (folders?.folders.length ?? 0) === 0;
  const retry = React.useCallback(() => {
    if (settingsScope)
      fireAndForget(refreshPromptLibraryCatalog(settingsScope), {
        tag: 'ArtifactFolderTree.retry',
      });
  }, [settingsScope]);

  return (
    <TreeContext.Provider value={context}>
      {unavailable ? (
        <View style={styles.freshness}>
          <SurfaceFreshnessLine
            testID={`${props.testID}:unavailable`}
            tone="warning"
            reason={t('artifacts.browser.folders.unavailable')}
            action={{ label: t('common.retry'), onPress: retry }}
          />
        </View>
      ) : null}
      <View ref={hostRef} style={styles.sheet} testID={`${props.testID}:sheet`}>
        {wide ? (
          <View style={styles.columns} aria-hidden>
            <Text style={[styles.columnTitle, styles.columnName]}>
              {t('artifacts.browser.folders.columnName')}
            </Text>
            <Text style={[styles.columnTitle, styles.kindColumn]}>
              {t('artifacts.browser.kindLabel')}
            </Text>
            <Text style={[styles.columnTitle, styles.ageColumn]}>
              {t('artifacts.browser.folders.columnEdited')}
            </Text>
            <View style={styles.menuColumn} />
          </View>
        ) : null}
        <Tree
          testID={props.testID}
          accessibilityLabel={props.accessibilityLabel}
          items={editingItems}
          presentation="table"
          selectedKey={
            props.selectedArtifactId
              ? `artifact:${props.selectedArtifactId}`
              : null
          }
          onExpandedChange={onExpandedChange}
          onActivate={onActivate}
          expandLabel={(item) =>
            t('artifacts.browser.folders.expand', { name: item.title })
          }
          collapseLabel={(item) =>
            t('artifacts.browser.folders.collapse', { name: item.title })
          }
          renderTrailing={renderTrailing}
          renderInlineEdit={renderInlineEdit}
          wrapRow={wrapRow}
        />
        <RootDropZone nodeRef={rootZoneNode} />
      </View>
      {noFolders && !currentEdit ? (
        <View style={styles.invite} testID={`${props.testID}:invite`}>
          <Text style={styles.inviteText}>
            {t('artifacts.browser.folders.emptyInvite')}
          </Text>
          <RoundButton
            testID={`${props.testID}:invite:new`}
            size="small"
            display="secondary"
            title={t('artifacts.browser.folders.newFolder')}
            onPress={() => createFolder(null)}
          />
        </View>
      ) : null}
    </TreeContext.Provider>
  );
});

/** Only the editing row subscribes to draft keystrokes; the draft survives a hidden/collapsed row. */
function FolderInlineEditor(props: Readonly<{
  edit: FolderEdit;
  commands: ReturnType<typeof useArtifactFolderCommands>;
  canWrite: boolean;
  testID: string;
  onFinish: (edit: FolderEdit) => void;
}>) {
  const name = props.edit.titles.useTitle();
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const inFlight = React.useRef(false);
  const save = async () => {
    if (inFlight.current || !props.canWrite || !normalizePromptFolderName(name)) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      if (props.edit.kind === 'create') {
        await props.commands.create({
          id: props.edit.id,
          parentId: props.edit.parentId,
          name,
        });
      } else {
        await props.commands.rename(props.edit.folder, name);
      }
      props.onFinish(props.edit);
    } catch {
      setError(t('artifacts.browser.folders.saveFailed'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const submit = () => {
    fireAndForget(save(), { tag: 'ArtifactFolderTree.save' });
  };
  const label = t('artifacts.browser.folders.columnName');
  return (
    <View style={stylesheet.editor}>
      <FieldItem label={label} labelNativeID={`${props.testID}:edit:label`}>
        <FieldTextInput
          testID={`${props.testID}:edit:name`}
          accessibilityLabel={label}
          accessibilityLabelledBy={`${props.testID}:edit:label`}
          value={name}
          onChangeText={props.edit.titles.publish}
          error={error}
          autoFocus
          selectTextOnFocus
          editable={!saving}
          placeholder={t('artifacts.browser.folders.namePlaceholder')}
          returnKeyType="done"
          onSubmitEditing={submit}
          onKeyPress={event => {
            if (event.nativeEvent.key === 'Escape' && !saving) props.onFinish(props.edit);
          }}
        />
      </FieldItem>
      {props.edit.kind === 'create' ? (
        // Said where a folder is made: a folder is personal filing, never sharing (lab `c-art TN`).
        <Text style={stylesheet.editorHelp} testID={`${props.testID}:edit:help`}>
          {t('artifacts.browser.folders.nameHelp')}
        </Text>
      ) : null}
      <View style={stylesheet.editorActions}>
        <RoundButton
          testID={`${props.testID}:edit:save`}
          title={props.edit.kind === 'create' ? t('artifacts.browser.folders.create') : t('common.save')}
          size="small"
          disabled={!props.canWrite || !normalizePromptFolderName(name)}
          loading={saving}
          onPress={submit}
        />
        <RoundButton
          testID={`${props.testID}:edit:cancel`}
          title={t('common.cancel')}
          size="small"
          display="secondary"
          disabled={saving}
          onPress={() => props.onFinish(props.edit)}
        />
      </View>
    </View>
  );
}

function noop(): void {}

function NodeMark(props: Readonly<{ node: Node }>) {
  const { theme } = useUnistyles();
  const { node } = props;
  const name =
    node.kind === 'branch'
      ? node.expanded
        ? 'folder-open'
        : 'folder'
      : node.row.artifact.isDecrypted === false
        ? 'lock'
        : ARTIFACT_KIND_ICONS[node.row.kind];
  return <Icon name={name} size={17} color={theme.colors.text.secondary} />;
}

/** Which place of this tree the carried item would land in: a folder id, `null` for the top level, else nothing. */
function useAdmittedDropFolder(
  runtime: EntityDragDropRuntime,
  targetId: string,
): string | null | undefined {
  const snapshot = useEntityDragDropSnapshot(runtime);
  if (
    snapshot.phase !== 'carrying' ||
    snapshot.targetId !== targetId ||
    snapshot.admission?.status !== 'allowed'
  )
    return undefined;
  const input = snapshot.admission.effect.input;
  if (!isRecord(input))
    return undefined;
  const place =
    snapshot.item?.kind === 'artifact-folder' ? input.parentId : input.folderId;
  return typeof place === 'string' ? place : place === null ? null : undefined;
}

/**
 * A tree row's host: the drag source (pointer), the measured box the drop target hit-tests, the lifted look
 * while it is carried and the outline when a carry would land in this folder.
 */
function RowHost(
  props: Readonly<{ node: Node; title: string; children: React.ReactElement }>,
) {
  const styles = stylesheet;
  const { node } = props;
  const tree = useTreeContext();
  const own = React.useRef<unknown>(null);
  const [hovered, setHovered] = React.useState(false);
  const { runtime, sourceId } = useArtifactBrowserDragSource({
    scope: tree.scope,
    entity:
      node.kind === 'branch'
        ? { kind: 'artifact-folder', folderId: node.folder.id }
        : { kind: 'artifact', artifactId: node.row.key },
    isCurrent: () => tree.canWrite,
    getBounds: () => readWindowBounds(own.current),
    describe: () => ({ title: props.title }),
  });
  const dragDom = useEntityDragDomBinding({
    runtime,
    sourceId,
    enabled: tree.canWrite && isHoverCapablePrimaryPointer(),
    describe: () => props.title,
    canStart: (event) => {
      const element =
        typeof Element !== 'undefined' && event.target instanceof Element
          ? event.target
          : null;
      return !element?.closest(
        'button,input,[role="button"],[role="menuitem"]',
      );
    },
  });
  const { registerRow } = tree;
  const ref = React.useCallback(
    (value: unknown) => {
      own.current = value;
      registerRow(node.key, value);
      dragDom(value);
    },
    [dragDom, node.key, registerRow],
  );
  const carried = useEntityDragSourceState(runtime, sourceId).active;
  const landing = useAdmittedDropFolder(runtime, tree.targetId);
  const lands = node.kind === 'branch' && landing === node.folder.id;
  return (
    <RowRevealContext.Provider value={hovered}>
      <View
        ref={ref}
        style={[styles.rowHost, carried ? styles.carried : null]}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {props.children}
        {lands ? (
          <TreeDropOutline
            testID={`${tree.testID}:dropOutline:${node.key}`}
            visual={{ kind: 'outline', targetId: node.key }}
            radius={8}
            style={styles.outline}
          />
        ) : null}
      </View>
    </RowRevealContext.Provider>
  );
}

/** The top-level place, shown only while something of this tree is carried. */
function RootDropZone(
  props: Readonly<{ nodeRef: React.MutableRefObject<unknown> }>,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const tree = useTreeContext();
  const snapshot = useEntityDragDropSnapshot(tree.runtime);
  const landing = useAdmittedDropFolder(tree.runtime, tree.targetId);
  const kind = snapshot.item?.kind;
  const carrying =
    snapshot.phase === 'carrying' &&
    (kind === 'artifact' || kind === 'artifact-folder') &&
    tree.runtime.getPointer() !== null;
  if (!carrying) return null;
  return (
    <View
      ref={(node) => {
        props.nodeRef.current = node;
      }}
      style={[styles.rootZone, landing === null ? styles.rootZoneOn : null]}
      testID={`${tree.testID}:rootZone`}
    >
      <Icon name="arrow-up" size={14} color={theme.colors.text.tertiary} />
      <Text style={styles.rootZoneText}>
        {t('artifacts.browser.folders.moveToTopLevel')}
      </Text>
    </View>
  );
}

/** The row's columns (kind, age or item count) and its ⋯, at fixed widths so every row lines up. */
function RowTrailing(props: Readonly<{ node: Node; title: string }>) {
  const styles = stylesheet;
  const { node } = props;
  const tree = useTreeContext();
  const count =
    node.kind === 'branch' ? (tree.counts.get(node.folder.id) ?? 0) : 0;
  return (
    <View style={styles.trailing}>
      {tree.wide ? (
        <Text style={[styles.kind, styles.kindColumn]} numberOfLines={1}>
          {node.kind === 'leaf' ? artifactKindLabel(node.row.kind) : ''}
        </Text>
      ) : null}
      <Text style={[styles.age, styles.ageColumn]} numberOfLines={1}>
        {node.kind === 'leaf'
          ? formatRelativeTimeShort(node.row.artifact.updatedAt, Date.now())
          : count > 0
            ? String(count)
            : ''}
      </Text>
      <View style={styles.menuColumn}>
        {node.kind === 'branch' ? (
          <FolderRowMenu node={node} title={props.title} />
        ) : (
          <ArtifactRowMenu node={node} title={props.title} />
        )}
      </View>
    </View>
  );
}

const MOVE_PREFIX = 'move:';
const MOVE_NEW_FOLDER_ID = `${MOVE_PREFIX}new`;

/**
 * "Move to folder…": the places of the shared entity chooser (`runtime.getDestinations`), in tree order. The
 * current place is checked, a refused place says why, and choosing one performs the same semantic move a
 * pointer drop does.
 */
function useMoveMenu(
  node: Node,
  open: boolean,
  title: string,
): Readonly<{
  item: DropdownMenuItem | null;
  select: (id: string) => boolean;
}> {
  const tree = useTreeContext();
  const { theme } = useUnistyles();
  const sourceId = node.key;
  const current =
    node.kind === 'branch' ? (node.folder.parentId ?? null) : node.row.folderId;
  const destinations = React.useMemo((): readonly EntityDropDestination[] => {
    if (!open || !tree.canWrite) return [];
    const available = tree.runtime
      .getDestinations(sourceId)
      .filter((destination) => destination.targetId === tree.targetId);
    const byFolder = new Map<string | null, EntityDropDestination>();
    for (const destination of available) {
      const place = destination.destination;
      if (
        isRecord(place) &&
        (typeof place.folderId === 'string' || place.folderId === null)
      ) {
        byFolder.set(place.folderId, destination);
      }
    }
    return [
      null,
      ...tree.orderedFolders.map((entry) => entry.folder.id),
    ].flatMap((id) => {
      const destination = byFolder.get(id);
      return destination ? [destination] : [];
    });
  }, [
    open,
    sourceId,
    tree.canWrite,
    tree.orderedFolders,
    tree.runtime,
    tree.targetId,
  ]);
  const depths = React.useMemo(
    () =>
      new Map(
        tree.orderedFolders.map((entry) => [entry.folder.id, entry.depth]),
      ),
    [tree.orderedFolders],
  );
  const chooserTitle = t('artifacts.browser.folders.moveItemTo', { name: title });
  const item = React.useMemo(
    (): DropdownMenuItem | null =>
      !tree.canWrite
        ? null
        : {
            id: 'move',
            testID: `${tree.testID}:menu:${node.key}:move`,
            title: t('artifacts.browser.folders.moveTo'),
            icon: (
              <Icon
                name="folder"
                size={16}
                color={theme.colors.text.secondary}
              />
            ),
            submenu: {
              showCategoryTitles: true,
              items: [...destinations.map(
                (destination, index): DropdownMenuItem => {
                  const place = destination.destination;
                  const folderId =
                    isRecord(place) &&
                    typeof place.folderId === 'string'
                      ? place.folderId
                      : null;
                  const here = folderId === current;
                  const refused =
                    destination.admission.status === 'refused'
                      ? destination.admission.reason.message
                      : null;
                  return {
                    id: `${MOVE_PREFIX}${index}`,
                    // The chooser's title: what is being moved (lab `c-art TA`).
                    category: chooserTitle,
                    title:
                      destination.label ??
                      t('artifacts.browser.folders.topLevel'),
                    subtitle: !here && refused ? refused : undefined,
                    icon: (
                      <Icon
                        name={folderId === null ? 'arrow-up' : 'folder'}
                        size={16}
                        color={theme.colors.text.secondary}
                      />
                    ),
                    disabled: here || refused !== null,
                    checked: here,
                    rowContainerStyle: {
                      paddingLeft:
                        12 +
                        (folderId === null ? 0 : (depths.get(folderId) ?? 0)) *
                          14,
                    },
                  };
                },
              ), {
                // At the foot: a place that does not exist yet. It opens the tree's own name editor.
                id: MOVE_NEW_FOLDER_ID,
                testID: `${tree.testID}:menu:${node.key}:move:new`,
                category: '',
                title: t('artifacts.browser.folders.newFolderEllipsis'),
                icon: (
                  <Icon
                    name="folder-plus"
                    size={16}
                    color={theme.colors.text.secondary}
                  />
                ),
              }],
            },
          },
    [
      chooserTitle,
      current,
      depths,
      destinations,
      node.key,
      theme.colors.text.secondary,
      tree.canWrite,
      tree.testID,
    ],
  );
  const select = React.useCallback(
    (id: string): boolean => {
      if (!id.startsWith(MOVE_PREFIX)) return false;
      if (id === MOVE_NEW_FOLDER_ID) {
        tree.createFolder(null);
        return true;
      }
      const destination = destinations[Number(id.slice(MOVE_PREFIX.length))];
      if (!destination) return true;
      fireAndForget(
        (async () => {
          const outcome = await tree.runtime.perform(
            sourceId,
            destination.targetId,
            destination.destination,
            'chooser',
          );
          if (outcome && outcome.status !== 'applied')
            Modal.alert(t('common.error'), outcome.reason.message);
        })(),
        { tag: 'ArtifactFolderTree.move' },
      );
      return true;
    },
    [destinations, sourceId, tree.createFolder, tree.runtime],
  );
  return { item, select };
}

function RowMenu(
  props: Readonly<{
    node: Node;
    title: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    items: readonly DropdownMenuItem[];
    onSelect: (id: string) => void;
  }>,
) {
  const tree = useTreeContext();
  const hovered = React.useContext(RowRevealContext);
  // A pointer sees the ⋯ on the row it is over; a finger has no hover, so it stays.
  const revealed = hovered || props.open || !isHoverCapablePrimaryPointer();
  if (props.items.length === 0) return null;
  return (
    <DropdownMenu
      testID={`${tree.testID}:menu:${props.node.key}`}
      open={props.open}
      onOpenChange={props.onOpenChange}
      items={props.items}
      onSelect={props.onSelect}
      selectedId={null}
      trigger={({ toggle }) => (
        <View style={revealed ? null : stylesheet.concealed}>
          <IconButton
            testID={`${tree.testID}:menu:${props.node.key}:trigger`}
            iconName="dots-three"
            variant="plain"
            accessibilityLabel={t('artifacts.browser.folders.options', {
              name: props.title,
            })}
            onPress={toggle}
          />
        </View>
      )}
    />
  );
}

function FolderRowMenu(
  props: Readonly<{ node: Extract<Node, { kind: 'branch' }>; title: string }>,
) {
  const { theme } = useUnistyles();
  const tree = useTreeContext();
  const [open, setOpen] = React.useState(false);
  const move = useMoveMenu(props.node, open, props.title);
  const folder = props.node.folder;
  const { commands, createFolder, renameFolder } = tree;
  const items = React.useMemo(
    (): DropdownMenuItem[] =>
      !tree.canWrite
        ? []
        : [
            {
              id: 'newInside',
              title: t('artifacts.browser.folders.newFolderInside'),
              icon: (
                <Icon
                  name="folder-plus"
                  size={16}
                  color={theme.colors.text.secondary}
                />
              ),
            },
            {
              id: 'rename',
              title: t('artifacts.browser.folders.rename'),
              icon: (
                <Icon
                  name="pencil-simple"
                  size={16}
                  color={theme.colors.text.secondary}
                />
              ),
            },
            ...(move.item ? [move.item] : []),
            {
              id: 'delete',
              title: t('artifacts.browser.folders.deleteFolder'),
              destructive: true,
              icon: (
                <Icon
                  name="trash"
                  size={16}
                  color={theme.colors.text.destructive}
                />
              ),
            },
          ],
    [
      move.item,
      theme.colors.text.destructive,
      theme.colors.text.secondary,
      tree.canWrite,
    ],
  );
  const onSelect = (id: string) => {
    if (move.select(id)) return;
    if (id === 'newInside') {
      createFolder(folder.id);
    } else if (id === 'rename')
      renameFolder(folder);
    else if (id === 'delete')
      fireAndForget(commands.remove(folder), {
        tag: 'ArtifactFolderTree.delete',
      });
  };
  return (
    <RowMenu
      node={props.node}
      title={props.title}
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={onSelect}
    />
  );
}

function ArtifactRowMenu(
  props: Readonly<{ node: Extract<Node, { kind: 'leaf' }>; title: string }>,
) {
  const { theme } = useUnistyles();
  const tree = useTreeContext();
  const [open, setOpen] = React.useState(false);
  const move = useMoveMenu(props.node, open, props.title);
  const artifactId = props.node.row.key;
  const { onArtifactDeleted, onOpenArtifact } = tree;
  const operations = useArtifactOperations(props.node.row.artifact, () =>
    onArtifactDeleted(artifactId),
  );
  const tint = theme.colors.text.secondary;
  const items: DropdownMenuItem[] = !operations.canRead
    ? []
    : [
        {
          id: 'open',
          title: t('common.open'),
          icon: <Icon name="arrow-square-out" size={16} color={tint} />,
        },
        ...(move.item ? [move.item] : []),
        ...(operations.canShare
          ? [
              {
                id: 'share',
                title: t('artifacts.browser.actions.share'),
                icon: <Icon name="share" size={16} color={tint} />,
              },
            ]
          : []),
        {
          id: 'history',
          title: t('artifacts.browser.actions.history'),
          icon: <Icon name="clock-counter-clockwise" size={16} color={tint} />,
        },
        ...(operations.canManage
          ? [
              {
                id: 'delete',
                title: t('artifacts.delete'),
                destructive: true,
                disabled: operations.deleting,
                icon: (
                  <Icon
                    name="trash"
                    size={16}
                    color={theme.colors.text.destructive}
                  />
                ),
              },
            ]
          : []),
      ];
  const onSelect = (id: string) => {
    if (move.select(id)) return;
    if (id === 'open') onOpenArtifact(artifactId);
    else if (id === 'share') operations.share();
    else if (id === 'history') operations.history();
    else if (id === 'delete')
      fireAndForget(operations.remove(), {
        tag: 'ArtifactFolderTree.deleteArtifact',
      });
  };
  return (
    <RowMenu
      node={props.node}
      title={props.title}
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={onSelect}
    />
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  editor: { minWidth: 0, paddingVertical: 8, gap: 8 },
  editorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editorHelp: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  freshness: {
    marginBottom: 12,
  },
  sheet: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
    paddingBottom: 6,
  },
  columns: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
    paddingLeft: 62,
    paddingRight: 10,
    marginBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  columnTitle: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  columnName: {
    flex: 1,
  },
  rowHost: {
    position: 'relative',
  },
  carried: {
    opacity: 0.38,
  },
  outline: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 6,
    right: 6,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  kindColumn: {
    width: KIND_COLUMN_PX,
  },
  ageColumn: {
    width: AGE_COLUMN_PX,
    textAlign: 'right',
  },
  menuColumn: {
    width: MENU_COLUMN_PX,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  kind: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  age: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  concealed: {
    opacity: 0,
  },
  rootZone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 36,
    marginTop: 6,
    marginHorizontal: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border.default,
  },
  rootZoneOn: {
    borderStyle: 'solid',
    borderColor: theme.colors.state.active.border,
    backgroundColor: theme.colors.state.active.background,
  },
  rootZoneText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  invite: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 14,
    paddingHorizontal: 4,
  },
  inviteText: {
    flex: 1,
    minWidth: 200,
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
}));
