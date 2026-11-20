import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useAttachableRemoteWorkspaces } from '@/components/settings/machines/managed/useAttachableRemoteWorkspaces';
import type { AttachableRemoteWorkspace } from '@/components/settings/machines/managed/attachableRemoteWorkspaceActions';
import type { ManagedWorkspacePreparationOutcome } from '@/components/ui/pathBrowser/ManagedWorkspacePreparation';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

import type { ProjectsListModel } from './useProjectsListModel';

/** What the "+" needs to offer folders in attached workspaces (remote workspaces F1). */
export type ProjectsAddMenuRemote = Readonly<{
  serverId: string;
  onAdd: ProjectsListModel['addProjectFromRemoteWorkspace'];
}>;

const ITEM_PREFIX = 'remote:';
/** Where the chooser starts when the attached record names no guest home. */
const GUEST_ROOT = '/';

const STATUS_KEY = {
  running: 'projects.identity.serverFolderStatusRunning',
  stopped: 'projects.identity.serverFolderStatusStopped',
  starting: 'projects.identity.serverFolderStatusStarting',
} as const;

/**
 * "A folder on a server…" in the Projects "+" (lab add-*): one row whose submenu lists the connected account's
 * workspaces, read only while the submenu is open (or a chosen workspace is still being prepared).
 */
export function useRemoteWorkspaceAddItem(
  input: Readonly<{
    remote: ProjectsAddMenuRemote | null | undefined;
    menuOpen: boolean;
    testID: string;
  }>,
): Readonly<{
  item: DropdownMenuItem | null;
  select(itemId: string): boolean;
}> {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { remote, menuOpen, testID } = input;
  const [submenuOpened, setSubmenuOpened] = React.useState(false);
  const [preparing, setPreparing] = React.useState(false);
  const [chosenAccount, setChosenAccount] = React.useState<string>();
  const reading = Boolean(remote) && (preparing || (menuOpen && submenuOpened));
  if (!menuOpen && !preparing && (submenuOpened || chosenAccount)) {
    // A closed menu reads nothing; the next open lists again.
    setSubmenuOpened(false);
    setChosenAccount(undefined);
  }
  const state = useAttachableRemoteWorkspaces({
    serverId: remote?.serverId ?? '',
    open: reading,
    bindingId: chosenAccount,
  });
  if (
    state.kind === 'choose_account' &&
    state.accounts.length === 1 &&
    chosenAccount !== state.accounts[0]!.bindingId
  ) {
    // One connected account: its workspaces are the list, with no account step.
    setChosenAccount(state.accounts[0]!.bindingId);
  }

  const item = React.useMemo((): DropdownMenuItem | null => {
    if (!remote) return null;
    const row = (
      id: string,
      fields: Omit<DropdownMenuItem, 'id' | 'testID'>,
    ): DropdownMenuItem => ({
      id: `${ITEM_PREFIX}${id}`,
      testID: `${testID}:remote:${id}`,
      ...fields,
    });
    const connect = row('connect', {
      title: t('projects.identity.serverFolderConnect'),
      icon: <Icon name="plus" size={16} />,
      category: '',
    });
    let items: DropdownMenuItem[];
    if (!reading || state.kind === 'loading') {
      items = [
        row('loading', {
          title: t('projects.identity.serverFolderLoading'),
          disabled: true,
          loading: true,
        }),
      ];
    } else if (state.kind === 'failed') {
      const reason =
        state.message ||
        resolveActionExecutionErrorMessage(
          { code: state.code },
          t('errors.tryAgain'),
        );
      items = [
        row('retry', {
          title: t('projects.identity.serverFolderListFailed', { reason }),
          subtitle: t('common.retry'),
          icon: (
            <Icon
              name="warning-circle"
              size={16}
              color={theme.colors.state.danger.foreground}
            />
          ),
          keepMenuOpen: true,
        }),
      ];
    } else if (state.kind === 'choose_account') {
      items =
        state.accounts.length === 0
          ? [
              row('none', {
                title: t('projects.identity.serverFolderNoAccountTitle'),
                subtitle: t('projects.identity.serverFolderNoAccountBody'),
                disabled: true,
              }),
              connect,
            ]
          : [
              ...state.accounts.map((account) =>
                row(`account:${account.bindingId}`, {
                  title: account.title,
                  subtitle: t('projects.checkouts.via', {
                    machine: account.controller.name,
                  }),
                  keepMenuOpen: true,
                  icon: <Icon name="user-circle" size={16} />,
                }),
              ),
              connect,
            ];
    } else {
      const account = state.accounts[0]!;
      const category = `${account.title} · ${t('projects.checkouts.via', { machine: account.controller.name })}`;
      items =
        account.workspaces.length === 0
          ? [
              row('empty', {
                title: t('projects.identity.serverFolderNoWorkspaces', {
                  account: account.title,
                }),
                disabled: true,
                category,
              }),
            ]
          : account.workspaces.map((workspace) =>
              row(`workspace:${workspace.id}`, {
                title: workspace.name,
                // Start preparation before the parent closes, preserving the listing's demand.
                keepMenuOpen: true,
                ...(workspace.template ? { subtitle: workspace.template } : {}),
                icon: <Icon name="terminal" size={16} />,
                category,
                ...(workspace.status !== 'unknown'
                  ? {
                      rightElement: (
                        <Text
                          variant="body"
                          numberOfLines={1}
                          style={{ color: theme.colors.text.secondary }}
                        >
                          {t(STATUS_KEY[workspace.status])}
                        </Text>
                      ),
                    }
                  : {}),
              }),
            );
      // Another account is one press away, under the list (lab add-menu foot).
      items = [...items, connect];
    }
    return {
      id: 'remoteFolder',
      testID: `${testID}:remote`,
      title: t('projects.identity.addServerFolder'),
      subtitle: t('projects.identity.addServerFolderSubtitle'),
      icon: <Icon name="hard-drives" size={16} />,
      submenu: {
        items,
        search:
          state.kind === 'ready' && state.accounts[0]!.workspaces.length > 0,
        searchPlaceholder: t('projects.identity.serverFolderSearch'),
        showCategoryTitles: true,
        separateCategories: true,
        onOpen: () => setSubmenuOpened(true),
      },
    };
  }, [
    reading,
    remote,
    state,
    testID,
    theme.colors.state.danger.foreground,
    theme.colors.text.secondary,
  ]);

  const latest = React.useRef(state);
  latest.current = state;
  const readyWaiters = React.useRef(new Set<() => void>());
  React.useEffect(() => {
    if (state.kind !== 'ready' && state.kind !== 'failed') return;
    for (const wake of [...readyWaiters.current]) wake();
  }, [state]);
  const readyListing = React.useCallback(
    (signal: AbortSignal) =>
      new Promise<Extract<typeof state, { kind: 'ready' }> | null>((resolve) => {
        const settle = () => {
          const current = latest.current;
          if (signal.aborted || current.kind === 'failed') return finish(null);
          if (current.kind === 'ready') finish(current);
        };
        const finish = (value: Extract<typeof state, { kind: 'ready' }> | null) => {
          readyWaiters.current.delete(settle);
          signal.removeEventListener('abort', settle);
          resolve(value);
        };
        readyWaiters.current.add(settle);
        signal.addEventListener('abort', settle);
        settle();
      }),
    [],
  );

  const select = React.useCallback(
    (itemId: string): boolean => {
      if (!itemId.startsWith(ITEM_PREFIX) || !remote) return false;
      const id = itemId.slice(ITEM_PREFIX.length);
      if (id === 'connect') {
        router.push(SETTINGS_ROUTES.connectedServices as never);
        return true;
      }
      if (id === 'retry' && state.kind === 'failed') {
        state.retry();
        return true;
      }
      if (id.startsWith('account:')) {
        setChosenAccount(id.slice('account:'.length));
        return true;
      }
      if (!id.startsWith('workspace:') || state.kind !== 'ready') return true;
      const account = state.accounts[0]!;
      const workspace: AttachableRemoteWorkspace | undefined =
        account.workspaces.find(
          (row) => row.id === id.slice('workspace:'.length),
        );
      if (!workspace) return true;
      setPreparing(true);
      setChosenAccount(account.bindingId);
      void remote
        .onAdd({
          name: workspace.name,
          controllerMachineId: account.controller.machineId,
          onSetUpAsMachine: () => router.push(buildMachineAddHref({})),
          prepare: async ({
            signal,
            onApprovalPending,
          }): Promise<ManagedWorkspacePreparationOutcome> => {
            // Preparation uses the current listing if its controller or account changed.
            const ready = await readyListing(signal);
            if (!ready) return { kind: 'failed', code: signal.aborted ? 'aborted' : 'target_unavailable', message: null };
            const outcome = await ready.attach({
              bindingId: account.bindingId,
              workspaceId: workspace.id,
              signal,
              onApprovalPending,
            });
            return outcome.kind === 'attached'
              ? {
                  kind: 'ready',
                  workspace: {
                    serverId: remote.serverId,
                    managedId: outcome.managedId,
                    controller: outcome.controller,
                    rootPath: outcome.home ?? GUEST_ROOT,
                  },
                }
              : outcome;
          },
        })
        .finally(() => setPreparing(false));
      return true;
    },
    [readyListing, remote, router, state],
  );

  return { item, select };
}
