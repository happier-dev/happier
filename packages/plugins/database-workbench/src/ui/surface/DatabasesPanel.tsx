import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  EmptyState,
  ErrorState,
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
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { WorkbenchTarget } from '../models.js';
import {
  readWorkbenchLaunchInput,
  useWorkbenchMount,
  type WorkbenchLaunchInput,
} from './mount.js';
import { WORKBENCH_PAGE_VIEW_ID } from './views.js';

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
  props: Readonly<{ context: RenderContext; launch: WorkbenchLaunchInput }>,
) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const { targets, looked, status, error, refresh } = useDatabaseTargets(
    props.launch.scope,
  );
  const open = React.useCallback(
    (target: WorkbenchTarget) => {
      void props.context.hostApi.openSurface(WORKBENCH_PAGE_VIEW_ID, projectNativeJsonValueForTransport({
        scope: props.launch.scope,
        descriptor: instance.target(target.targetKey),
      }));
    },
    [instance, props.context.hostApi, props.launch.scope],
  );
  if (status === 'loading' && targets.length === 0)
    return <LoadingState layout="line" rows={1} />;
  if (status === 'unavailable') {
    return (
      <ErrorState
        layout="line"
        kind="unavailable"
        title={translate(
          'plugins.database.find.failed',
          'Databases could not be read',
        )}
        details={error instanceof Error ? error.message : undefined}
        onRetry={refresh}
        retryLabel={translate('plugins.database.retry', 'Try again')}
      />
    );
  }
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
 * Request capture (P5) and Connect a database mount here when their producers land.
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
  return (
    <ItemGroup
      title={translate('plugins.database.section.title', 'Databases')}
      description={translate(
        'plugins.database.section.description',
        'Databases this checkout’s services use. Open one to browse tables, run SQL and see how it performs.',
      )}
    >
      {instance && launch ? (
        <WorkbenchProvider instance={instance}>
          <DatabaseRows context={context} launch={launch} />
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
