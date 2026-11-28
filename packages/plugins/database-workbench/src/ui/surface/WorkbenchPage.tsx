import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type { DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  EmptyState,
  ListDetailLayout,
  LoadingState,
  PageHeader,
  Row,
  Stack,
  defineUiSurface,
  useHappierPageChrome,
  usePluginTranslation,
  SurfaceState,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { AutomationsSection } from '@happier-dev/plugin-ui/components';
import { useHostDatabaseWorkbench, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui/hostApi';
import {
  WorkbenchProvider,
  useDatabaseTargets,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../hooks.js';
import type { WorkbenchClient, WorkbenchLocation } from '../models.js';
import { DatabaseConsole } from './DatabaseConsole.js';
import { InsightsPane } from './insights/InsightsPane.js';
import { RelationData } from './RelationData.js';
import { RelationHeader } from './RelationHeader.js';
import { RelationStructure } from './RelationStructure.js';
import { StagedBar, StagedReview } from './StagedChanges.js';
import { OverviewFacts } from './OverviewFacts.js';
import { ReadAccessSetup } from './ReadAccessSetup.js';
import { CatalogueReadFailure } from './CatalogueReadFailure.js';
import { DatabaseForget } from './DatabaseConnection.js';
import { renderWorkbenchWriteSetup } from './writeSetup.js';
import { TableDirectory } from './TableDirectory.js';
import { WorkbenchRail } from './WorkbenchRail.js';
import {
  databaseTargetKey,
  readWorkbenchLaunchInput,
  type WorkbenchLaunchInput,
  useLinkedWorkbench,
  useWorkbenchMount,
  WORKBENCH_DISPLAY_PAGE_ROWS,
} from './mount.js';
import { decodeWorkbenchSubPath, type WorkbenchPlace, type WorkbenchTargetDisplay } from './subPath.js';
import { databaseEngineName } from './engines.js';
import { bindMountedWorkbench } from './openWorkbench.js';

function OverviewPane(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope']; onForgot?: () => void }>) {
  const translate = usePluginTranslation();
  const descriptor = useWorkbenchInstance().target(props.targetKey);
  // The rail beside says the engine and where the database came from; the page says where it is and what it holds,
  // from the target facts the workbench projects (DBW-UILOGIC), never worked out here (lab dbBrowse overview).
  const facts = useDatabaseTargets(props.scope).targets.find((candidate) => candidate.targetKey === props.targetKey);
  const meta = [
    ...(facts?.endpointLabel ? [{ key: 'endpoint', text: facts.endpointLabel }] : []),
    ...(facts?.machineLabel ? [{ key: 'machine', text: translate('plugins.database.overview.machine', 'on {machine}', { machine: facts.machineLabel }) }] : []),
    ...(facts?.relationCount ? [{ key: 'tables', text: translate('plugins.database.target.tables', '{count} tables', { count: facts.relationCount }) }] : []),
  ];
  return (
    <Stack gap="large">
      <PageHeader
        title={descriptor.label}
        meta={meta.length > 0 ? meta : [{ key: 'engine', text: databaseEngineName(descriptor.engine) }]}
      />
      <OverviewFacts targetKey={props.targetKey} />
      <TableDirectory targetKey={props.targetKey} />
      {/* The database's own Automations (lab automations-v-database), on the subject its admitted read projected. */}
      {descriptor.automationSubject?.ok ? (
        <AutomationsSection subject={descriptor.automationSubject.subject} subjectName={descriptor.label}
          testID="database-automations" />
      ) : null}
      {/* A database connected by hand is forgotten here, last and quiet, at its own width; the Action's review confirms it. */}
      {props.onForgot && descriptor.target.kind === 'manual' ? (
        <Row><DatabaseForget target={descriptor.target} onForgot={props.onForgot} /></Row>
      ) : null}
    </Stack>
  );
}

export function WorkbenchMain(props: Readonly<{
  targetKey: string;
  scope: WorkbenchLaunchInput['scope'];
  /** The page's own Overview offers Forget database; a rail's details never do. */
  onForgot?: () => void;
}>) {
  const location = useWorkbenchLocation();
  const [reviewing, setReviewing] = React.useState(false);
  const closeReview = React.useCallback(() => setReviewing(false), []);
  const openReview = React.useCallback(() => setReviewing(true), []);
  const relation = location.relation;
  if (location.mode === 'console')
    return <DatabaseConsole targetKey={props.targetKey} scope={props.scope} />;
  if (location.mode === 'insights')
    return <InsightsPane targetKey={props.targetKey} />;
  if (!relation || location.mode === 'overview')
    return <OverviewPane targetKey={props.targetKey} scope={props.scope} {...(props.onForgot ? { onForgot: props.onForgot } : {})} />;
  if (reviewing)
    return (
      <StagedReview
        relation={relation}
        targetKey={props.targetKey}
        onClose={closeReview}
      />
    );
  return (
    <Stack gap="medium" grow>
      {location.mode === 'structure' ? (
        <>
          <RelationHeader targetKey={props.targetKey} />
          <Stack grow>
            <RelationStructure relation={relation} />
          </Stack>
        </>
      ) : (
        // Data's toolbar is the rows' own header, so a pushed row (a phone) takes the page whole.
        <Stack grow>
          {/* One relation's rows, open row and paging: another relation starts fresh rather than keeping a row that is not its own. */}
          <RelationData key={`${relation.database ?? ''}/${relation.schema}/${relation.name}`} relation={relation} />
        </Stack>
      )}
      <StagedBar onReview={openReview} />
    </Stack>
  );
}

/** The workbench page: the rail beside what it opens; on a phone the rail pushes its choice. */
function WorkbenchPage(context: RenderContext) {
  const { target, display, place, root } = React.useMemo(() => decodeWorkbenchSubPath(context.subPath), [context.subPath]);
  return target
    ? <LinkedWorkbenchPage context={context} target={target} display={display} place={place} root={root} />
    : <MountedWorkbenchPage context={context} launch={readWorkbenchLaunchInput(context)} place={place} root={root} />;
}

function LinkedWorkbenchPage({ context, target, display, place, root }: Readonly<{
  context: RenderContext;
  target: DatabaseTargetV1;
  display?: WorkbenchTargetDisplay;
  place: WorkbenchPlace;
  root: boolean;
}>) {
  const linked = useLinkedWorkbench(context, target, display);
  const host = useHostDatabaseWorkbench();
  const t = usePluginTranslation();
  if (linked.status === 'loading') return <LoadingState layout="line" rows={1} />;
  if (linked.status === 'unavailable') {
    if (isPluginError(linked.error) && linked.error.code === 'read_role_setup_required') {
      if (target.kind === 'managed_deployment') {
        return <ReadAccessSetup target={target} display={display} onConfigured={linked.retry} />;
      }
      if (target.kind === 'deployment_service') {
        const setup = renderWorkbenchWriteSetup(host, target, linked.error.code, linked.retry);
        if (setup != null) return <SurfaceState kind="unavailable" icon="database" size="page"
          title={t('plugins.database.readSetup.title', 'Set up read-only access')}
          note={display?.label || target.database} body={<Stack align="center">{setup}</Stack>} />;
      }
    }
    return <CatalogueReadFailure error={linked.error} refresh={linked.retry} />;
  }
  // Reading through the Account relay without a held connection changes nothing the person can act on, so the page
  // says nothing about it.
  return <MountedWorkbenchPage context={context} place={place} root={root}
    launch={readWorkbenchLaunchInput(context, linked.descriptor)} client={linked.client} />;
}

function MountedWorkbenchPage({ context, launch, place, root, client }: Readonly<{
  context: RenderContext;
  launch: WorkbenchLaunchInput | null;
  place: WorkbenchPlace;
  /** No place in the address: the database's root, which a phone shows as the rail. */
  root: boolean;
  client?: WorkbenchClient;
}>) {
  const translate = usePluginTranslation();
  const descriptor = launch?.descriptor;
  const targetKey = descriptor ? databaseTargetKey(descriptor) : null;
  const initial = React.useMemo<WorkbenchLocation | null>(
    () =>
      targetKey
        ? {
            targetKey,
            ...place,
            sort: [],
            columns: [],
            page: { rows: WORKBENCH_DISPLAY_PAGE_ROWS, offset: 0 },
            fkTrail: [],
          }
        : null,
    [targetKey, place],
  );
  const options = React.useMemo(() => ({ pageLocation: true }), []);
  const instance = useWorkbenchMount(context, launch, initial, options, client);
  const mountId = useSurfaceContext().mountId;
  const sharedScope = usePluginUiEphemeralSharedScope();
  React.useEffect(() => {
    if (!sharedScope || !mountId || !instance || !targetKey) return;
    const release = bindMountedWorkbench(sharedScope, mountId, { instance, targetKey, signal: context.signal });
    if (!release) return;
    context.hostApi.publishCurrentUiContext({ detail: { address: { mountId } } });
    return () => { release(); context.hostApi.publishCurrentUiContext(null); };
  }, [sharedScope, mountId, instance, targetKey, context.signal, context.hostApi]);
  // The host's Back, Forward or a link moves the page: the workbench takes that place, never writing it back.
  React.useEffect(() => { instance?.adopt(place); }, [instance, place]);
  // A link straight to a place goes to the root first and opens the place from there once the page has reached it,
  // exactly as picking it on the rail does, so a phone's Back returns to the rail (lab tablesp). Only the address
  // the page opened at decides this; a page whose navigation already goes back has its way back and writes nothing.
  const hasWayBack = useHappierPageChrome()?.renderBack != null;
  const coldPlace = React.useRef<WorkbenchPlace | null>(root || hasWayBack ? null : place);
  const leftForRoot = React.useRef<typeof instance>(null);
  React.useEffect(() => {
    if (!instance || !coldPlace.current || leftForRoot.current === instance) return;
    leftForRoot.current = instance;
    // A host without page locations (a widget, an older host) has no Back to declare; the page stays where it is.
    instance.openRoot().catch(() => { coldPlace.current = null; });
  }, [instance]);
  React.useEffect(() => {
    const pending = coldPlace.current;
    if (!instance || !root || !pending) return;
    coldPlace.current = null;
    instance.navigate({ mode: pending.mode, relation: pending.relation }).catch(() => undefined);
  }, [instance, root]);
  if (!instance || !targetKey || !launch) {
    return (
      <EmptyState
        layout="centered"
        title={translate(
          'plugins.database.page.noTarget',
          'Open a database from Dev servers',
        )}
      />
    );
  }
  return (
    <WorkbenchProvider instance={instance}>
      <WorkbenchLayout targetKey={targetKey} scope={launch.scope} root={root} />
    </WorkbenchProvider>
  );
}

function WorkbenchLayout(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope']; root: boolean }>) {
  const translate = usePluginTranslation();
  const label = useWorkbenchInstance().target(props.targetKey).label;
  const [forgotten, setForgotten] = React.useState(false);
  const forget = React.useCallback(() => setForgotten(true), []);
  if (forgotten) {
    return (
      <EmptyState
        layout="page"
        icon="database"
        title={translate('plugins.database.forgotten.title', '{name} is no longer connected', { name: label })}
        description={translate('plugins.database.forgotten.body', 'Its Saved Secret stays. Connect it again from Dev servers.')}
      />
    );
  }
  return (
    <ListDetailLayout
      minListWidth={232}
      minDetailWidth={360}
      preferredListRatio={0.24}
      // A phone opens on the rail (lab tablesp) and pushes the page it picks; the host's Back returns to the rail.
      stackedPane={props.root ? 'list' : 'detail'}
      list={<WorkbenchRail targetKey={props.targetKey} />}
      detail={<WorkbenchMain targetKey={props.targetKey} scope={props.scope} onForgot={forget} />}
    />
  );
}

export const renderSurface = defineUiSurface(WorkbenchPage);
export { activateWorkbenchClientActions as activate, openWorkbenchPage } from './openWorkbench.js';
