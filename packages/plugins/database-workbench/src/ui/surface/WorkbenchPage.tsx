import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  EmptyState,
  IconButton,
  Icon,
  ListDetailLayout,
  PageHeader,
  Row,
  Select,
  Stack,
  defineUiSurface,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  WorkbenchProvider,
  useWorkbenchInstance,
  useWorkbenchLocation,
} from '../hooks.js';
import type { WorkbenchLocation } from '../models.js';
import { DatabaseConsole } from './DatabaseConsole.js';
import { RelationData } from './RelationData.js';
import { RelationStructure } from './RelationStructure.js';
import { StagedBar, StagedReview } from './StagedChanges.js';
import { WorkbenchRail } from './WorkbenchRail.js';
import {
  databaseTargetKey,
  readWorkbenchLaunchInput,
  useWorkbenchMount,
  WORKBENCH_DISPLAY_PAGE_ROWS,
} from './mount.js';
import { decodeWorkbenchSubPath } from './subPath.js';

function RelationHeader(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const location = useWorkbenchLocation();
  const relation = location.relation!;
  const modes = React.useMemo(
    () => [
      { value: 'data', label: translate('plugins.database.mode.data', 'Data') },
      {
        value: 'structure',
        label: translate('plugins.database.mode.structure', 'Structure'),
      },
    ],
    [translate],
  );
  const sort = location.sort[0];
  return (
    <Stack gap="small">
      <PageHeader
        title={relation.name}
        meta={[{ key: 'schema', text: relation.schema }]}
        actions={
          <IconButton
            accessibilityLabel={translate(
              'plugins.database.refresh',
              'Refresh',
            )}
            icon={<Icon name="refresh" />}
            onPress={() => instance.refresh(props.targetKey, relation)}
          />
        }
      />
      <Row gap="small" align="center">
        <Select
          label={translate('plugins.database.mode.label', 'View')}
          presentation="segmented"
          options={modes}
          value={location.mode}
          onChange={(value) =>
            void location.navigate({
              mode: value === 'structure' ? 'structure' : 'data',
            })
          }
        />
        {sort && location.mode === 'data' ? (
          <IconButton
            accessibilityLabel={translate(
              'plugins.database.sort.clear',
              'Clear sort by {column}',
              { column: sort.column },
            )}
            icon={<Icon name="close" />}
            onPress={() => void location.navigate({ sort: [] })}
          />
        ) : null}
      </Row>
    </Stack>
  );
}

function OverviewPane(props: Readonly<{ targetKey: string }>) {
  const translate = usePluginTranslation();
  const descriptor = useWorkbenchInstance().target(props.targetKey);
  return (
    <Stack gap="large">
      <PageHeader
        title={descriptor.label}
        description={translate(
          'plugins.database.overview.description',
          'Browse its tables, run SQL and review changes before they’re applied.',
        )}
        meta={[
          { key: 'engine', text: descriptor.engine },
          { key: 'origin', text: descriptor.origin.label },
        ]}
      />
      <EmptyState
        layout="line"
        title={translate(
          'plugins.database.overview.choose',
          'Choose a table to see its rows',
        )}
      />
    </Stack>
  );
}

function WorkbenchMain(props: Readonly<{ targetKey: string }>) {
  const location = useWorkbenchLocation();
  const [reviewing, setReviewing] = React.useState(false);
  const closeReview = React.useCallback(() => setReviewing(false), []);
  const openReview = React.useCallback(() => setReviewing(true), []);
  const relation = location.relation;
  if (location.mode === 'console')
    return <DatabaseConsole targetKey={props.targetKey} />;
  if (!relation || location.mode === 'overview')
    return <OverviewPane targetKey={props.targetKey} />;
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
      <RelationHeader targetKey={props.targetKey} />
      <Stack grow>
        {location.mode === 'structure' ? (
          <RelationStructure relation={relation} />
        ) : (
          <RelationData relation={relation} />
        )}
      </Stack>
      <StagedBar onReview={openReview} />
    </Stack>
  );
}

/** The workbench page: the rail beside what it opens; on a phone the rail pushes its choice. */
function WorkbenchPage(context: RenderContext) {
  const translate = usePluginTranslation();
  const launch = readWorkbenchLaunchInput(context);
  const descriptor = launch?.descriptor;
  const targetKey = descriptor ? databaseTargetKey(descriptor) : null;
  const initial = React.useMemo<WorkbenchLocation | null>(
    () =>
      targetKey
        ? {
            targetKey,
            ...decodeWorkbenchSubPath(context.subPath),
            sort: [],
            columns: [],
            page: { rows: WORKBENCH_DISPLAY_PAGE_ROWS, offset: 0 },
            fkTrail: [],
          }
        : null,
    [targetKey],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const options = React.useMemo(() => ({ pageLocation: true }), []);
  const instance = useWorkbenchMount(context, launch, initial, options);
  if (!instance || !targetKey) {
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
      <WorkbenchLayout targetKey={targetKey} />
    </WorkbenchProvider>
  );
}

function WorkbenchLayout(props: Readonly<{ targetKey: string }>) {
  const location = useWorkbenchLocation();
  const chosen = location.mode === 'console' || location.relation !== undefined;
  return (
    <ListDetailLayout
      minListWidth={232}
      minDetailWidth={360}
      preferredListRatio={0.24}
      stackedPane={chosen ? 'detail' : 'list'}
      detailActive={chosen}
      list={<WorkbenchRail targetKey={props.targetKey} />}
      detail={<WorkbenchMain targetKey={props.targetKey} />}
    />
  );
}

export const renderSurface = defineUiSurface(WorkbenchPage);
