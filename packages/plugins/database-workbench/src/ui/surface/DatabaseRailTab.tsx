import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  EmptyState,
  ErrorState,
  LoadingState,
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
import {
  databaseTargetKey,
  readWorkbenchLaunchInput,
  useWorkbenchMount,
  WORKBENCH_DISPLAY_PAGE_ROWS,
  type WorkbenchLaunchInput,
} from './mount.js';
import { decodeWorkbenchSubPath, encodeWorkbenchSubPath } from './subPath.js';
import { databaseEngineName } from './engines.js';

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
        label: target.name,
        subtitle: databaseFactsOf(target),
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
      groups={[{ id: 'databases', accessibilityLabel: label, items }]}
      radioGroups={radioGroups}
      // Connect a database… joins as the menu's action row when the one Connect flow is composed (owed).
      onSelect={(id) => {
        if (id !== CONNECT_ID) props.onSelect(id);
        setOpen(false);
      }}
    />
  );
}
function databaseFactsOf(target: WorkbenchTarget): string {
  return [
    databaseEngineName(target.engineLabel),
    'variable' in target.origin
      ? target.origin.serviceName
      : target.origin.connectedBy,
  ]
    .filter(Boolean)
    .join(' · ');
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
        }),
        { subPath: place, instanceKey: `${current.name}/${place}` },
      );
    },
    [current, instance, props.context, props.launch.scope],
  );
  if (picker.status === 'loading' && picker.targets.length === 0)
    return <LoadingState layout="line" rows={6} rowShape="compact" />;
  if (picker.status === 'unavailable') {
    return (
      <ErrorState
        layout="line"
        kind="unavailable"
        title={translate(
          'plugins.database.find.failed',
          'Databases could not be read',
        )}
        details={
          picker.error instanceof Error ? picker.error.message : undefined
        }
        onRetry={picker.refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
  if (!current) {
    // Connect a database… is the tab's one setup Action once the Connect flow is composed (owed); no dead button until then.
    return (
      <EmptyState
        layout="line"
        title={translate(
          'plugins.database.rail.none',
          'No database for this project yet',
        )}
      />
    );
  }
  const selected = openedKey
    ? (() => {
        const decoded = decodeWorkbenchSubPath(openedKey);
        return {
          mode: decoded.mode,
          ...(decoded.relation ? { relation: decoded.relation } : {}),
        };
      })()
    : null;
  return (
    <ScrollArea>
      <Stack gap="medium">
        <DatabasePicker
          current={current}
          targets={picker.targets}
          onSelect={(key) => {
            setOpenedKey(null);
            picker.select(key);
          }}
        />
        {railTabOf(props.context) === 'insights' ? (
          <InsightsRailList
            key={current.targetKey}
            context={props.context}
            launch={props.launch}
            targetKey={current.targetKey}
            detailsView={detailsViewId(props.context)}
          />
        ) : (
          <WorkbenchRailList
            key={current.targetKey}
            targetKey={current.targetKey}
            selected={selected}
            onOpen={open}
            showOverview={false}
          />
        )}
      </Stack>
    </ScrollArea>
  );
}

/** The details tab: the same relation view the page shows, at the location the rail opened. */
function DetailsTab(props: Readonly<{ targetKey: string }>) {
  return <WorkbenchMain targetKey={props.targetKey} />;
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
    context.surface.mount.container === 'detailsPane';
  const descriptor = inDetails ? launch?.descriptor : undefined;
  const targetKey = descriptor ? databaseTargetKey(descriptor) : '';
  const location = React.useMemo<WorkbenchLocation | null>(() => {
    if (!launch) return null;
    if (!inDetails) return emptyLocation('');
    return descriptor
      ? {
          ...emptyLocation(targetKey),
          ...decodeWorkbenchSubPath(context.subPath),
        }
      : null;
  }, [launch === null, inDetails, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
        <InsightsDetailsTab context={context} targetKey={targetKey} />
      ) : inDetails ? (
        <DetailsTab targetKey={targetKey} />
      ) : (
        <RailTab context={context} launch={launch} />
      )}
    </WorkbenchProvider>
  );
}

export const renderSurface = defineUiSurface(DatabaseRailSurface);
