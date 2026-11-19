import * as React from 'react';
import type { DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  EmptyState,
  ErrorState,
  ListDetailLayout,
  LoadingState,
  PageHeader,
  Stack,
  defineUiSurface,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import { AutomationsSection } from '@happier-dev/plugin-ui/components';
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
import { decodeWorkbenchSubPath, type WorkbenchPlace } from './subPath.js';
import { databaseEngineName } from './engines.js';

function OverviewPane(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope'] }>) {
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
    </Stack>
  );
}

export function WorkbenchMain(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope'] }>) {
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
    return <OverviewPane targetKey={props.targetKey} scope={props.scope} />;
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
  const { target, place } = React.useMemo(() => decodeWorkbenchSubPath(context.subPath), [context.subPath]);
  return target
    ? <LinkedWorkbenchPage context={context} target={target} place={place} />
    : <MountedWorkbenchPage context={context} launch={readWorkbenchLaunchInput(context)} place={place} />;
}

function LinkedWorkbenchPage({ context, target, place }: Readonly<{
  context: RenderContext;
  target: DatabaseTargetV1;
  place: WorkbenchPlace;
}>) {
  const translate = usePluginTranslation();
  const linked = useLinkedWorkbench(context, target);
  if (linked.status === 'loading') return <LoadingState layout="line" rows={1} />;
  if (linked.status === 'unavailable') return (
    <ErrorState
      layout="centered"
      kind="unavailable"
      title={translate('plugins.database.find.failed', 'Databases could not be read')}
      details={linked.error instanceof Error ? linked.error.message : undefined}
      onRetry={linked.retry}
      retryLabel={translate('plugins.database.retry', 'Try again')}
    />
  );
  return <MountedWorkbenchPage context={context} place={place}
    launch={readWorkbenchLaunchInput(context, linked.descriptor)} client={linked.client} />;
}

function MountedWorkbenchPage({ context, launch, place, client }: Readonly<{
  context: RenderContext;
  launch: WorkbenchLaunchInput | null;
  place: WorkbenchPlace;
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
      <WorkbenchLayout targetKey={targetKey} scope={launch.scope} />
    </WorkbenchProvider>
  );
}

function WorkbenchLayout(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope'] }>) {
  return (
    <ListDetailLayout
      minListWidth={232}
      minDetailWidth={360}
      preferredListRatio={0.24}
      list={<WorkbenchRail targetKey={props.targetKey} />}
      detail={<WorkbenchMain targetKey={props.targetKey} scope={props.scope} />}
    />
  );
}

export const renderSurface = defineUiSurface(WorkbenchPage);
export { encodeWorkbenchPageSubPath } from './subPath.js';
