import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  EmptyState,
  Icon,
  Item,
  ItemGroup,
  LoadingState,
  Popover,
  Stack,
  defineUiSurface,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import { WorkbenchProvider, useDatabaseTargets, useWorkbenchInstance } from '../hooks.js';
import type { WorkbenchTarget } from '../models.js';
import {
  readWorkbenchLaunchInput,
  useWorkbenchMount,
  type WorkbenchLaunchInput,
} from './mount.js';
import { openWorkbenchPage } from './openWorkbench.js';
import { DatabaseConnection } from './DatabaseConnection.js';
import { CatalogueReadFailure } from './CatalogueReadFailure.js';

const PANEL_LOCATION = Object.freeze({
  targetKey: '',
  mode: 'overview' as const,
  sort: [],
  columns: [],
  page: { rows: 1, offset: 0 },
  fkTrail: [],
});
const PANEL_OPTIONS = Object.freeze({ pageLocation: false });

/** Where the target came from, said once: "PostgreSQL · from DATABASE_URL in web". */
function targetSubtitle(
  target: WorkbenchTarget,
  translate: PluginTranslate,
): string {
  const origin =
    'variable' in target.origin
      ? translate(
          'plugins.database.target.fromService',
          'from {variable} in {service}',
          {
            variable: target.origin.variable,
            service: target.origin.serviceName,
          },
        )
      : translate(
          'plugins.database.target.connectedBy',
          'connected by {name}',
          { name: target.origin.connectedBy },
        );
  return [target.engineLabel, origin, target.endpointLabel]
    .filter(Boolean)
    .join(' · ');
}

function LookedDisclosure(
  props: Readonly<{
    looked: readonly Readonly<{ place: string; outcome: string }>[];
  }>,
) {
  const translate = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  if (props.looked.length === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      triggerAppearance="text"
      triggerSize="small"
      triggerDisclosure
      trigger={translate('plugins.database.find.looked', 'Where Happier looked')}
        triggerAccessibilityLabel={translate('plugins.database.find.looked', 'Where Happier looked')}
    >
      <ItemGroup surface="none">
        {props.looked.map((entry) => (
          <Item
            key={entry.place}
            title={entry.place}
            subtitle={entry.outcome}
          />
        ))}
      </ItemGroup>
    </Popover>
  );
}

function DatabaseRows(
  props: Readonly<{
    context: RenderContext;
    launch: WorkbenchLaunchInput;
    /** Connect a database was chosen in the section header: the connection form stands in for the rows. */
    connecting: boolean;
    onConnectingChange: (connecting: boolean) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const { targets, looked, status, error, refresh } = useDatabaseTargets(
    props.launch.scope,
  );
  const { connecting, onConnectingChange: setConnecting } = props;
  const scope = props.launch.scope;
  const open = React.useCallback(
    (target: WorkbenchTarget) => {
      // The database's root: the Overview beside the rail; on a phone the rail itself (lab tablesp).
      void openWorkbenchPage(props.context.hostApi, instance.target(target.targetKey));
    },
    [instance, props.context.hostApi],
  );
  if (connecting && scope.kind === 'worktree') {
    return <DatabaseConnection scope={scope} onFileOpened={() => setConnecting(false)}
      onCancel={() => { setConnecting(false); refresh(); }} onConnected={() => {
      setConnecting(false);
      refresh();
    }} />;
  }
  if (status === 'loading' && targets.length === 0)
    return <LoadingState layout="line" rows={1} />;
  if (status === 'unavailable') return <CatalogueReadFailure error={error} refresh={refresh} />;
  if (status === 'empty') {
    return (
      <Stack gap="xsmall">
        <EmptyState
          layout="line"
          title={translate(
            'plugins.database.find.none',
            'No databases found in this checkout’s services',
          )}
        />
        <LookedDisclosure looked={looked} />
      </Stack>
    );
  }
  return (
    <>
      {targets.map((target) => (
        <Item
          key={target.targetKey}
          title={target.name}
          // A database is an identity (its mark), and the row opens its workbench (the navigation chevron).
          icon={<Icon name="database" tone="secondary" />}
          showChevron
          subtitle={targetSubtitle(target, translate)}
          {...(target.relationCount
            ? {
                detail: translate(
                  'plugins.database.target.tables',
                  '{count} tables',
                  { count: target.relationCount },
                ),
              }
            : {})}
          onPress={() => open(target)}
        />
      ))}
    </>
  );
}

/**
 * Databases on the Dev servers page: the checkout's databases, each one press from its workbench.
 * Local capture belongs to the selected checkout's project.
 */
function DatabasesPanel(context: RenderContext) {
  const translate = usePluginTranslation();
  const launch = readWorkbenchLaunchInput(context);
  const instance = useWorkbenchMount(
    context,
    launch,
    launch ? PANEL_LOCATION : null,
    PANEL_OPTIONS,
  );
  const [connecting, setConnecting] = React.useState(false);
  // Adding to the section is the section's own action, beside its title (lab dbFind-devservers), never a button in
  // its sheet: an empty section is then one quiet line on the rows' edge.
  const connect = instance && launch?.scope.kind === 'worktree' && !connecting ? (
    <Button
      testID="database.panel.connect"
      title={translate('plugins.database.connect.open', 'Connect a database')}
      variant="plain"
      icon={<Icon name="add" tone="secondary" />}
      onPress={() => setConnecting(true)}
    />
  ) : undefined;
  return (
    <ItemGroup
      // While connecting, the section's header names the form (lab dbFind-connect), so the form needs no title of its own.
      title={connecting ? translate('plugins.database.connect.open', 'Connect a database')
        : translate('plugins.database.section.title', 'Databases')}
      description={connecting ? translate('plugins.database.connect.description',
        'Choose a database server’s Saved Secret or a SQLite file in this checkout. Happier tests it, then opens it.')
        : translate(
        'plugins.database.section.description',
        'Databases this checkout’s services use. Open one to browse tables, run SQL and see how it performs.',
      )}
      action={connect}
    >
      {instance && launch ? (
        <WorkbenchProvider instance={instance}>
          {/* Capture is turned on, off and cleared in the Dev servers capture view that hosts this panel: one control owner. */}
          <DatabaseRows context={context} launch={launch} connecting={connecting} onConnectingChange={setConnecting} />
        </WorkbenchProvider>
      ) : (
        // The same line state as "No databases found": it sits inside the sheet with the row inset.
        <EmptyState
          layout="line"
          title={translate(
            'plugins.database.find.noCheckout',
            'Databases show here when this workspace is a project checkout.',
          )}
        />
      )}
    </ItemGroup>
  );
}

export const renderSurface = defineUiSurface(DatabasesPanel);
