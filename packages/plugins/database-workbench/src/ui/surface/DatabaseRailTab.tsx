import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  Button,
  EmptyState,
  LoadingState,
  ItemGroup,
  Menu,
  ScrollArea,
  Stack,
  Text,
  defineUiSurface,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  WorkbenchProvider,
  useDatabasePicker,
  useWorkbenchInstance,
} from '../hooks.js';
import type { WorkbenchLocation, WorkbenchTarget } from '../models.js';
import type { WorkbenchPaneIdentity } from '../state.js';
import {
  DatabaseIdentity,
  WorkbenchRailList,
  type RailIntent,
} from './WorkbenchRail.js';
import { WorkbenchMain } from './WorkbenchPage.js';
import { InsightsDetailsTab, InsightsRailList } from './insights/InsightsRail.js';
import { AddTelemetrySetup } from './insights/InsightsSetup.js';
import { DatabaseConnection, DatabaseForget } from './DatabaseConnection.js';
import { CatalogueReadFailure } from './CatalogueReadFailure.js';
import {
  databaseTargetKey,
  readWorkbenchLaunchInput,
  useWorkbenchMount,
  WORKBENCH_DISPLAY_PAGE_ROWS,
  workbenchDetailsInstanceKey,
  type WorkbenchLaunchInput,
} from './mount.js';
import { decodeWorkbenchSubPath, encodeWorkbenchSubPath } from './subPath.js';

const LOCAL_ONLY = Object.freeze({ pageLocation: false });
const CONNECT_ID = 'connect';

function emptyLocation(targetKey: string): WorkbenchLocation {
  return {
    targetKey,
    mode: 'overview',
    sort: [],
    columns: [],
    page: { rows: WORKBENCH_DISPLAY_PAGE_ROWS, offset: 0 },
    fkTrail: [],
  };
}

/** Which rail tab this mount is: the Database and Insights placements share this renderer (UILOGIC placements). */
function railTabOf(context: RenderContext): WorkbenchPaneIdentity['tab'] {
  const mount = context.surface.mount;
  return mount.kind === 'destination' && mount.destination.localId.startsWith('insights-')
    ? 'insights'
    : 'database';
}

/** Session or Project, from the mount's own target; each rail tab keeps its own choice (D24 B). */
function paneIdentity(
  context: RenderContext,
): WorkbenchPaneIdentity | undefined {
  const target = context.surface.target;
  const tab = railTabOf(context);
  if (target.kind === 'session')
    return { kind: 'session', sessionId: target.sessionId, tab };
  if (target.kind === 'project')
    return { kind: 'project', projectKey: target.projectKey, tab };
  return undefined;
}

/** The details tab this rail opens beside the transcript: same renderer, details container (UILOGIC placements). */
function detailsViewId(context: RenderContext): string | null {
  const kind = context.surface.target.kind;
  return kind === 'session' || kind === 'project'
    ? `${railTabOf(context)}-${kind}-details`
    : null;
}

/** The identity header is the picker trigger: the canonical Menu, a check on the current database. */
function DatabasePicker(
  props: Readonly<{
    current: WorkbenchTarget;
    targets: readonly WorkbenchTarget[];
    onSelect: (targetKey: string) => void;
    onConnect?: () => void;
  }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const [open, setOpen] = React.useState(false);
  const label = translate('plugins.database.picker.label', 'Choose a database');
  const items = React.useMemo(
    () =>
      props.targets.map((target) => ({
        id: target.targetKey,
        kind: 'radio' as const,
        radioGroupId: 'database',
        // Each database carries its mark, as the identity it switches to does (lab dbRail-picker).
        icon: 'database' as const,
        label: target.name,
        subtitle: target.facts,
      })),
    [props.targets],
  );
  const radioGroups = React.useMemo(
    () => [
      {
        id: 'database',
        accessibilityLabel: label,
        selectedId: props.current.targetKey,
      },
    ],
    [label, props.current.targetKey],
  );
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      trigger={props.current.name}
      triggerAccessibilityLabel={label}
      triggerDisclosure
      triggerContent={
        <DatabaseIdentity
          descriptor={instance.target(props.current.targetKey)}
          accessAsText
        />
      }
      groups={[{ id: 'databases', accessibilityLabel: label, items: props.onConnect
        ? [...items, { id: CONNECT_ID, label: translate('plugins.database.connect.open', 'Connect a database') }]
        : items }]}
      radioGroups={radioGroups}
      onSelect={(id) => {
        if (id === CONNECT_ID) props.onConnect?.();
        else props.onSelect(id);
        setOpen(false);
      }}
    />
  );
}
function RailTab(
  props: Readonly<{ context: RenderContext; launch: WorkbenchLaunchInput }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const identity = paneIdentity(props.context);
  const picker = useDatabasePicker(props.launch.scope, identity);
  // Until the person picks, the tab reads the first database the project has (a display default, not a write).
  const current =
    picker.targets.find(
      (target) => target.targetKey === picker.selectedTargetKey,
    ) ?? picker.targets[0];
  const [openedKey, setOpenedKey] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const scope = props.launch.scope;
  const connectHere = identity?.tab === 'database' && scope.kind === 'worktree';
  const open = React.useCallback(
    (intent: RailIntent) => {
      const view = detailsViewId(props.context);
      if (!current || !view) return;
      const place = encodeWorkbenchSubPath(
        intent.mode === 'data' || intent.mode === 'structure'
          ? { mode: intent.mode, relation: intent.relation }
          : { mode: intent.mode },
      );
      setOpenedKey(place);
      void props.context.hostApi.openSurface(
        view,
        projectNativeJsonValueForTransport({
          scope: props.launch.scope,
          descriptor: instance.target(current.targetKey),
          place,
        }),
        { instanceKey: workbenchDetailsInstanceKey(current.targetKey, place) },
      );
    },
    [current, instance, props.context, props.launch.scope],
  );
  if (connecting && scope.kind === 'worktree') {
    // The rail has no section header of its own: the form stands under the same title the Services panel gives it.
    return <ItemGroup surface="none" title={translate('plugins.database.connect.open', 'Connect a database')}
      description={translate('plugins.database.connect.description',
        'Choose a database server’s Saved Secret or a SQLite file in this checkout. Happier tests it, then opens it.')}>
      <DatabaseConnection scope={scope} onFileOpened={() => setConnecting(false)}
        onCancel={() => { setConnecting(false); picker.refresh(); }} onConnected={descriptor => {
        picker.select(databaseTargetKey(descriptor));
        setOpenedKey(null);
        setConnecting(false);
        picker.refresh();
      }} />
    </ItemGroup>;
  }
  if (picker.status === 'loading' && picker.targets.length === 0)
    return <LoadingState layout="line" rows={6} rowShape="compact" />;
  if (picker.status === 'unavailable') return <CatalogueReadFailure error={picker.error} refresh={picker.refresh} />;
  if (!current) {
    const telemetrySetup = identity?.tab === 'insights' && scope.kind === 'worktree'
      ? <AddTelemetrySetup scope={scope} />
      : null;
    const connect = connectHere ? <Button title={translate('plugins.database.connect.open', 'Connect a database')}
      variant="secondary" onPress={() => setConnecting(true)} /> : null;
    return (
      <EmptyState
        layout="line"
        title={translate(
          'plugins.database.rail.none',
          'No database for this project yet',
        )}
        action={telemetrySetup ?? connect ?? undefined}
      />
    );
  }
  const selected = openedKey ? decodeWorkbenchSubPath(openedKey).place : null;
  const pickerHeader = (
    <DatabasePicker
      current={current}
      targets={picker.targets}
      onConnect={connectHere ? () => setConnecting(true) : undefined}
      onSelect={(key) => {
        setOpenedKey(null);
        picker.select(key);
      }}
    />
  );
  return railTabOf(props.context) === 'insights' ? (
    <ScrollArea>
      <Stack gap="medium">
        {pickerHeader}
        <InsightsRailList
          key={current.targetKey}
          context={props.context}
          launch={props.launch}
          targetKey={current.targetKey}
          detailsView={detailsViewId(props.context)}
        />
      </Stack>
    </ScrollArea>
  ) : (
    // The tables column is the shell's navigation column, the picker in its title's place.
    <WorkbenchRailList
      key={current.targetKey}
      targetKey={current.targetKey}
      header={current.target.kind === 'manual' ? <Stack>{pickerHeader}
        <DatabaseForget target={current.target} onForgot={() => {
          setOpenedKey(null);
          picker.refresh();
        }} />
      </Stack> : pickerHeader}
      selected={selected}
      onOpen={open}
      showOverview={false}
    />
  );
}

/** The details tab: the same relation view the page shows, at the location the rail opened. */
function DetailsTab(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope'] }>) {
  return <WorkbenchMain targetKey={props.targetKey} scope={props.scope} />;
}

/**
 * The Database rail tab (D23/D24). In the right rail it is the picker and the workbench list; in the details
 * pane it is the relation or Console the rail opened. One renderer, two containers (UILOGIC placements).
 */
function DatabaseRailSurface(context: RenderContext) {
  const translate = usePluginTranslation();
  const launch = readWorkbenchLaunchInput(context);
  const inDetails =
    context.surface.mount.kind === 'destination' &&
    context.surface.mount.container === 'detailsTab';
  const descriptor = inDetails ? launch?.descriptor : undefined;
  const targetKey = descriptor ? databaseTargetKey(descriptor) : '';
  const place = launch?.place;
  const location = React.useMemo<WorkbenchLocation | null>(() => {
    if (!launch) return null;
    if (!inDetails) return emptyLocation('');
    return descriptor
      ? {
          ...emptyLocation(targetKey),
          ...decodeWorkbenchSubPath(place).place,
        }
      : null;
  }, [launch === null, inDetails, targetKey, place]); // eslint-disable-line react-hooks/exhaustive-deps
  const instance = useWorkbenchMount(context, launch, location, LOCAL_ONLY);
  if (!instance || !launch) {
    return (
      <Text
        tone="secondary"
        variant="meta"
        value={translate(
          'plugins.database.rail.noCheckout',
          'Open a project checkout to see its databases.',
        )}
      />
    );
  }
  return (
    <WorkbenchProvider instance={instance}>
      {inDetails && railTabOf(context) === 'insights' ? (
        <InsightsDetailsTab context={context} targetKey={targetKey} statementKey={place} />
      ) : inDetails ? (
        <DetailsTab targetKey={targetKey} scope={launch.scope} />
      ) : (
        <RailTab context={context} launch={launch} />
      )}
    </WorkbenchProvider>
  );
}

export const renderSurface = defineUiSurface(DatabaseRailSurface);
