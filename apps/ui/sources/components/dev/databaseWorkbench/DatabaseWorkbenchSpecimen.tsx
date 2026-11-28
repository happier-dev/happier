import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  PluginUiActionControlController,
  PluginUiHostApi,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import type { PluginUiActionControlPresentationV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginError } from '@happier-dev/plugin-sdk';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import {
  DATABASE_ACCESS_READ_ACTION_ID_V1,
  DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1,
  type DatabaseDescriptorV1,
  type DatabaseFilterV1,
  type DatabaseManagedDeploymentTargetV1,
  type DatabaseNamedCellV1,
} from '@happier-dev/plugin-sdk/database';
import { encodeBase64, formatSharedSavedSecretRefV1 } from '@happier-dev/plugin-sdk/protocol';
import { renderSurface as renderPanel } from '@happier-dev/plugins-database-workbench/happier-plugin-ui/database-panel-native';
import { renderSurface as renderPage } from '@happier-dev/plugins-database-workbench/happier-plugin-ui/database-workbench-native';
import { renderSurface as renderRail } from '@happier-dev/plugins-database-workbench/happier-plugin-ui/database-rail-native';

import {
  BundledPluginSurfaceMount,
  createBundledPluginFixtureHostApi,
} from '@/components/dev/pluginUi/bundledPluginSurfaceFixture';
import {
  recordPluginActionControlPlacement,
  type PluginSurfaceActionControls,
} from '@/components/plugins/surfaces/pluginSurfaceActionControls';
import {
  createPluginSurfaceContext,
  usePluginSurfaceEnvironment,
} from '@/components/plugins/surfaces/pluginSurfaceContext';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { HAPPIER_PAGE_METRICS, HappierColumnEdgeContext } from '@happier-dev/plugin-ui/presentation';
import {
  BILLING_DEV,
  BILLING_SCOPE,
  CONSOLE_DRAFT,
  CONSOLE_PLAN,
  CONSOLE_RESULT,
  INVOICE_ROWS,
  RELATIONS,
  rowsOf,
  structureOf,
} from './databaseWorkbenchFixture';

/**
 * Dev-only: the Database workbench surfaces (page, Dev servers panel, rail tab) from the plugin's own source on
 * the lab's `billing_dev`, so their look can be judged against `.happier/design-lab/database-workbench` without a
 * Machine. Only the Host API is a fixture; every surface, hook and controller is the real one.
 */

const PLUGIN_ID = 'happier.database';
export type DatabaseWorkbenchSpecimenSurface = 'page' | 'panel' | 'rail';

function matches(
  filter: DatabaseFilterV1 | undefined,
  names: readonly string[],
  cells: readonly { type: string; value?: unknown }[],
): boolean {
  if (!filter) return true;
  if (filter.kind === 'and')
    return filter.filters.every((leaf) => matches(leaf, names, cells));
  if (filter.kind === 'comparison' && filter.operator === 'eq') {
    const cell = cells[names.indexOf(filter.column)];
    return (
      cell !== undefined &&
      'value' in filter.value &&
      String(cell.value) === String(filter.value.value)
    );
  }
  if (filter.kind === 'null') {
    const cell = cells[names.indexOf(filter.column)];
    return (cell?.type === 'null') === filter.isNull;
  }
  return true;
}

/**
 * Which state the specimen draws (`?state=`): the rows still arriving, a table with no rows, rows that could not be
 * read; a Console run that fails or is stopped (`?console=`). Every other answer is the lab's billing_dev.
 */
export type DatabaseWorkbenchSpecimenState = Readonly<{
  rows?: 'loading' | 'empty' | 'failed';
  console?: 'error' | 'cancelled';
  /** `?stats=off`: statement statistics are off and this server can't turn them on (the Insights setup state). */
  stats?: 'off';
  review?: DatabaseWorkbenchReadSetupState;
}>;

/**
 * `?review=`: a writable database's staged review (`unverified`; `mysql` for MySQL's write guarantee), or a Railway database that needs a read-only login:
 * its PostgreSQL or MySQL review, editing off, a login created but not yet in use, a refusal with details, or (`read-setup-writer`)
 * Create refused because the Environment has no write connection, which leads to the host's write setup.
 */
export const DATABASE_WORKBENCH_REVIEW_STATES = [
  'unverified', 'mysql', 'read-setup', 'read-setup-mysql', 'read-setup-refused', 'read-setup-binding', 'read-setup-failed',
  'read-setup-writer',
] as const;
type DatabaseWorkbenchReadSetupState = typeof DATABASE_WORKBENCH_REVIEW_STATES[number];

const UNVERIFIED_BILLING: DatabaseDescriptorV1 = {
  ...BILLING_DEV,
  label: 'Billing staging',
  origin: { label: 'Railway' },
  access: { canRead: true, canWrite: true },
  endpointTrust: 'encrypted_unverified',
};

/** The same writable database on MySQL, whose staged review states MySQL's write guarantee. */
const MYSQL_BILLING: DatabaseDescriptorV1 = { ...UNVERIFIED_BILLING, engine: 'mysql', label: 'Billing staging (MySQL)' };

// Railway names every database `railway`; the engine is the contribution that links it.
function railwayTarget(engine: 'postgresql' | 'mysql'): DatabaseManagedDeploymentTargetV1 {
  return {
    kind: 'managed_deployment',
    environment: { serverId: 'meridian', environmentId: 'billing-staging', projectSourceId: 'billing-service' },
    targetLinkId: `billing-${engine}`,
    contribution: { pluginId: 'happier.deploy.railway-data', contributionId: engine },
    platformProjectId: 'meridian-billing',
    branchId: 'staging',
    database: 'railway',
  };
}
// The display facts a Workbench open carries for a managed database: engine, name and its Environment.
function railwayPath(engine: 'postgresql' | 'mysql'): string {
  const display = { engine, label: 'railway', origin: 'Billing staging' };
  return 'target/' + encodeBase64(new TextEncoder().encode(JSON.stringify({ target: railwayTarget(engine), display })), 'base64url');
}
const CREATE_READ_ACCESS = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);
const READ_ACCESS = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
const READ_ROLE = 'happier_ro_2b80ccb7367af66e';
// The statements the read-role planner (`packages/databases/src/readRoleSetup.ts`) writes for each engine.
const READ_SETUP_STATEMENTS = {
  postgresql: [
    `CREATE ROLE "${READ_ROLE}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD <generated SCRAM verifier>`,
    `GRANT CONNECT ON DATABASE "railway" TO "${READ_ROLE}"`,
    `GRANT USAGE ON SCHEMA "public" TO "${READ_ROLE}"`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "${READ_ROLE}"`,
    `ALTER ROLE "${READ_ROLE}" SET default_transaction_read_only = on`,
  ],
  mysql: [
    `CREATE USER '${READ_ROLE}'@'%' IDENTIFIED BY RANDOM PASSWORD REQUIRE SSL ACCOUNT LOCK`,
    `GRANT SELECT, SHOW VIEW ON \`railway\`.* TO '${READ_ROLE}'@'%'`,
    `ALTER USER '${READ_ROLE}'@'%' ACCOUNT UNLOCK`,
  ],
} as const;

/** What the read-setup Actions settle with in each `?review=` state: the owner's typed refusals, as a host delivers them. */
function readSetupRefusal(review: DatabaseWorkbenchReadSetupState | undefined, input: Record<string, unknown>) {
  if (review === 'read-setup-refused')
    return { ok: false, errorCode: 'database_editing_off', error: 'database_editing_off' } as const;
  if (review === 'read-setup-writer')
    return { ok: false, errorCode: 'write_connection_setup_required', error: 'write_connection_setup_required' } as const;
  if (review === 'read-setup-binding' && input.mode === 'apply')
    return { ok: false, errorCode: 'database_read_role_binding_failed', effectAttempted: true,
      error: 'The database login and its Saved Secret were created, but binding it did not complete. Use the existing read-only login to finish.',
      details: { role: READ_ROLE, savedSecretRef: formatSharedSavedSecretRefV1('railway-billing-reader'), resourceRevision: 3 },
      failureCause: { phase: 'database.read_access.binding', errorClass: 'PluginError', errorCode: 'deployment_conflict', httpStatus: null } } as const;
  if (review === 'read-setup-failed' && input.mode === 'apply')
    return { ok: false, errorCode: 'database_read_role_failed', effectAttempted: false, requestId: 'req_01JDX4Q8M2ZK7',
      error: 'The database refused to create the read-only login.',
      failureCause: { phase: 'database.read_access.create', errorClass: 'DatabaseError', errorCode: '42501', httpStatus: null } } as const;
  return null;
}

const NEVER = new Promise<never>(() => {});

async function answer(state: DatabaseWorkbenchSpecimenState, descriptor: DatabaseDescriptorV1, actionId: string, raw: unknown): Promise<unknown> {
  const input = raw as Record<string, unknown>;
  if (state.review?.startsWith('read-setup') && actionId === CREATE_READ_ACCESS && input.mode === 'preview') {
    return { ok: true, status: 'review', role: READ_ROLE, endpointTrust: 'encrypted_unverified',
      statements: READ_SETUP_STATEMENTS[state.review === 'read-setup-mysql' ? 'mysql' : 'postgresql'] };
  }
  const operation =
    typeof input.operation === 'string' ? input.operation : actionId;
  if (actionId.endsWith('targets.list') || actionId.endsWith('targets/list'))
    return { targets: [descriptor], completeness: { complete: true } };
  // The access sheet's loaded state: agent access is kept on the Machine the database runs on.
  if (actionId === READ_ACCESS)
    return { setBy: 'machine', agentAccess: 'read', access: descriptor.access ?? { canRead: true, canWrite: false } };
  switch (operation) {
    case 'describe':
      return { ok: true, operation, descriptor };
    case 'schemas.list':
      return {
        ok: true,
        operation,
        schemas: [{ name: 'public' }, { name: 'analytics' }, { name: 'auth' }],
        completeness: { complete: true },
      };
    case 'relations.list':
      return input.schema === 'public' || input.schema === undefined
        ? {
            ok: true,
            operation,
            relations: RELATIONS,
            completeness: { complete: true },
          }
        : {
            ok: true,
            operation,
            relations: [],
            completeness: { complete: true },
          };
    case 'relation.structure': {
      const structure = structureOf((input.relation as { name: string }).name);
      // A writable descriptor (`?review=unverified`) offers edits, so its staged review can be reached.
      return {
        ok: true,
        operation,
        structure: descriptor.access?.canWrite && structure.kind === 'table'
          ? { ...structure, capabilities: [...structure.capabilities, { operation: 'edits.apply', available: true }] }
          : structure,
      };
    }
    case 'rows.read': {
      if (state.rows === 'loading') return NEVER;
      if (state.rows === 'failed')
        return { ok: false, status: 'unavailable', code: 'database_unreachable', reason: 'The database at localhost:5432 did not answer.' };
      const relation = (input.relation as { name: string }).name;
      const data = rowsOf(relation);
      const names = data.columns.map((column) => column.name);
      const rows = state.rows === 'empty' ? [] : data.rows.filter((row) =>
        matches(input.filter as DatabaseFilterV1 | undefined, names, row.cells),
      );
      return {
        ok: true,
        operation,
        result: {
          columns: data.columns,
          rows,
          estimate: input.filter ? String(rows.length) : data.estimate,
          // The first page of a large table is never the whole table.
          completeness:
            input.filter || rows.length >= Number(data.estimate)
              ? { complete: true }
              : { complete: false, reason: 'page' },
        },
      };
    }
    case 'cell.read': {
      const key = (input.key as DatabaseNamedCellV1[])[0];
      const row = INVOICE_ROWS.find(
        (candidate) =>
          candidate.identity?.key[0]?.value.type === 'integer' &&
          key?.value.type === 'integer' &&
          candidate.identity.key[0].value.value === key.value.value,
      );
      return {
        ok: true,
        operation,
        value: row?.cells[9] ?? { type: 'null' },
        completeness: { complete: true },
      };
    }
    case 'statement.run':
      if (state.console === 'cancelled') return { ok: false, status: 'cancelled', code: 'database_cancelled' };
      if (state.console === 'error')
        return {
          ok: false,
          status: 'failed',
          code: 'database_statement_failed',
          cause: { source: 'engine', code: '42703', message: 'column "amount" does not exist', position: 8, statementIndex: 0 },
        };
      return { ok: true, operation, results: [CONSOLE_RESULT] };
    case 'stats.read': {
      // The lab's billing_dev at a glance: 412 MB, seven connections, statement statistics on.
      const group = (input.request as { group?: string } | undefined)?.group;
      const common = {
        v: 1, observedAtMs: Date.parse('2026-11-18T09:00:00Z'), engineId: 'postgresql', scope: { database: 'billing_dev' },
        intervalBasis: { bindingKey: 'binding', databaseIdentity: 'billing_dev', selectionKey: String(group) },
        status: 'available', coverage: { status: 'complete' }, completeness: { complete: true },
      };
      if (group === 'size')
        return { ok: true, operation, observation: { ...common, group, data: { bytes: '412000000', measurement: 'database_bytes' } } };
      if (group === 'activity')
        return { ok: true, operation, observation: { ...common, group, data: [
          ...['active', 'active', 'idle', 'idle', 'idle', 'idle', 'idle in transaction'].map((state, index) => ({ key: `s${index}`, state, blockingKeys: [] })),
        ] } };
      if (group === 'statements' && state.stats === 'off')
        return { ok: true, operation, observation: { v: 1, observedAtMs: common.observedAtMs, engineId: 'postgresql',
          scope: common.scope, status: 'unavailable', group, reason: 'extension_missing',
          remediation: "shared_preload_libraries = 'pg_stat_statements'" } };
      if (group === 'statements') return { ok: true, operation, observation: { ...common, group, data: [] } };
      return { ok: false, status: 'unavailable', code: 'database_unavailable', reason: 'Not in the specimen.' };
    }
    case 'statement.explain':
      return { ok: true, operation, format: 'text', plan: CONSOLE_PLAN, completeness: { complete: true } };
    default:
      return {
        ok: false,
        status: 'unavailable',
        code: 'database_unavailable',
        reason: `The specimen has no ${operation} answer.`,
      };
  }
}

function connectionContent(descriptor: DatabaseDescriptorV1) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      descriptor,
      ownWriteRevision: 0,
      relationRevisions: [],
    }),
  );
  return {
    contentType: 'application/json',
    digest: 'sha256:dev-database-workbench',
    bytes,
  };
}

type SpecimenControl = {
  presentation: PluginUiActionControlPresentationV1;
  controller: PluginUiActionControlController;
  busy: boolean;
};

/**
 * The host's Action controls, drawn by the host's own inline button (`PluginInlineActionControl`): a press asks the
 * author's controller to prepare, answers from the fixture as the Action executor would, and settles back, so Run and
 * Explain show their real results here. No other host machinery is stood in for.
 */
function createSpecimenActionControls(
  execute: (actionId: string, input: unknown) => Promise<unknown>,
  review: DatabaseWorkbenchReadSetupState | undefined,
) {
  const bound = new Map<string, SpecimenControl & { action: string }>();
  const listeners = new Set<() => void>();
  let snapshot: ReturnType<PluginSurfaceActionControls['getSnapshot']> = Object.freeze([]);
  const publish = () => {
    snapshot = Object.freeze([...bound].map(([id, control]) => Object.freeze({ id, presentation: control.presentation, busy: control.busy })));
    for (const listener of listeners) listener();
  };
  let next = 0;
  const controls = {
    getSnapshot: () => snapshot,
    getSlotSnapshot: () => Object.freeze([]),
    placeInline: () => () => {},
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async press(id: string) {
      const control = bound.get(id);
      if (!control) return;
      const preparation = await control.controller.prepare({ signal: new AbortController().signal });
      if (!preparation) return;
      control.busy = true;
      publish();
      const refusal = control.action === CREATE_READ_ACCESS
        ? readSetupRefusal(review, preparation.input as Record<string, unknown>) : null;
      const execution = refusal
        ?? { ok: true, result: await execute(control.action, preparation.input) } as Parameters<PluginUiActionControlController['onSettled']>[0];
      control.busy = false;
      publish();
      control.controller.onSettled(execution);
    },
    commit: async () => undefined,
    invalidatePreparations() {},
    handleRequest: (() => undefined) as unknown as PluginSurfaceActionControls['handleRequest'],
    dispose() {},
  } satisfies PluginSurfaceActionControls;
  const actionControl = (async (
    request: Readonly<{ action: unknown; presentation: PluginUiActionControlPresentationV1 }>,
    controller: PluginUiActionControlController,
  ) => {
    const id = `specimen-control-${next++}`;
    bound.set(id, { action: typeof request.action === 'string' ? request.action : JSON.stringify(request.action), presentation: request.presentation, controller, busy: false });
    publish();
    const control = {
      update: async (presentation: PluginUiActionControlPresentationV1) => {
        const held = bound.get(id);
        if (held) { held.presentation = presentation; publish(); }
      },
      dispose: () => { bound.delete(id); publish(); },
    };
    recordPluginActionControlPlacement(control, id);
    return control;
  }) as unknown as PluginUiHostApi['actionControl'];
  return { controls, actionControl };
}

export function DatabaseWorkbenchSpecimen(
  props: Readonly<{
    surface: DatabaseWorkbenchSpecimenSurface;
    subPath: string | null;
    width: number | null;
    state: DatabaseWorkbenchSpecimenState;
  }>,
) {
  const { rows: rowsState, console: consoleState, stats: statsState, review } = props.state;
  const needsReadSetup = review?.startsWith('read-setup') === true;
  const subPath = needsReadSetup ? railwayPath(review === 'read-setup-mysql' ? 'mysql' : 'postgresql') : props.subPath;
  const descriptor = props.state.review === 'unverified' ? UNVERIFIED_BILLING : props.state.review === 'mysql' ? MYSQL_BILLING : BILLING_DEV;
  const environment = usePluginSurfaceEnvironment(
    resolveLocalServicePreviewPlatform(),
  );
  const context = React.useMemo(
    () =>
      createPluginSurfaceContext({
        mount:
          props.surface === 'page'
            ? {
                kind: 'destination',
                destination: {
                  pluginId: PLUGIN_ID,
                  localId: 'database-workbench',
                },
                container: 'appPage',
              }
            : props.surface === 'rail'
              ? {
                  kind: 'destination',
                  destination: {
                    pluginId: PLUGIN_ID,
                    localId: 'database-session-rail',
                  },
                  container: 'rightSidebarTab',
                }
              : { kind: 'embedded', role: 'section', presentation: 'content' },
        target: { kind: 'app' },
        accountScope: { serverId: 'home', accountId: BILLING_SCOPE.accountId },
        accountEncryptionMode: 'plain',
        environment,
        translations: {},
        targetedContributions: {
          target: {
            pluginId: PLUGIN_ID,
            occurrenceId: 'dev-database-workbench',
            sourceCustody: {
              kind: 'development',
              registeredRootId: 'dev-database-workbench',
            },
          },
          points: [],
        },
      } as Parameters<typeof createPluginSurfaceContext>[0]) as SurfaceContext,
    [environment, props.surface],
  );
  const execute = React.useCallback(
    (actionId: string, input: unknown) => answer({
      ...(rowsState ? { rows: rowsState } : {}),
      ...(consoleState ? { console: consoleState } : {}),
      ...(statsState ? { stats: statsState } : {}),
      ...(review ? { review } : {}),
    }, descriptor, actionId, input),
    [consoleState, descriptor, rowsState, statsState, review],
  );
  const actionControls = React.useMemo(() => createSpecimenActionControls(execute, review), [execute, review]);
  // `read-setup-writer` mounts the host's Workbench recoveries as an app page does; with no signed-in Account bound here,
  // its write setup draws its own waiting state rather than a fixture copy of it.
  const presentation = React.useMemo(() => ({ actionControls: actionControls.controls,
    ...(review === 'read-setup-writer'
      ? { automations: { accountLifetime: null, target: { kind: 'app' as const }, isCurrent: () => true } } : {}) }),
  [actionControls, review]);
  const hostApi = React.useMemo<PluginUiHostApi>(() => {
    const base = createBundledPluginFixtureHostApi(
      context,
      { executeAction: execute },
      'Database workbench',
    );
    return {
      ...base,
      readResource: (async () =>
        connectionContent(descriptor)) as unknown as PluginUiHostApi['readResource'],
      watchResource: (async () => {
        if (needsReadSetup) throw new PluginError({ code: 'read_role_setup_required' });
        return { subscriptionId: 'dev-database-workbench', dispose() {} };
      }) as unknown as PluginUiHostApi['watchResource'],
      replacePageLocation: (async () =>
        undefined) as unknown as PluginUiHostApi['replacePageLocation'],
      setUnsavedChanges: async () => undefined,
      // The Machine the lab's database runs on, by the name its owner gave it.
      readMachineDisplayName: (async () => ({ status: 'ready', displayName: 'MacBook Pro' })) as unknown as PluginUiHostApi['readMachineDisplayName'],
      // The Console opens on the lab's draft and history, as this device would have kept them.
      deviceState: (async (request: Readonly<{ operation: string; key?: string }>) => ({
        status: 'ready',
        value: request.operation === 'read' && request.key?.includes('database-console') ? CONSOLE_DRAFT : null,
      })) as unknown as PluginUiHostApi['deviceState'],
      downloadFile: (async () => ({
        success: false,
        status: 'cancelled',
      })) as unknown as PluginUiHostApi['downloadFile'],
      // Run and Explain are host-drawn Action controls (`createSpecimenActionControls`).
      version: () => ({ ...base.version(), methods: [...base.version().methods, 'actionControl', 'presentActionFailure'] }),
      actionControl: actionControls.actionControl,
      presentActionFailure: async failure => presentActionExecutionFailure(failure),
    };
  }, [actionControls, context, descriptor, execute, needsReadSetup]);
  const module = React.useMemo(
    () => ({
      renderSurface:
        props.surface === 'page'
          ? renderPage
          : props.surface === 'rail'
            ? renderRail
            : renderPanel,
    }),
    [props.surface],
  );
  const launchInput = React.useMemo(
    () =>
      props.surface === 'page'
        ? { scope: BILLING_SCOPE, descriptor }
        : { scope: BILLING_SCOPE },
    [descriptor, props.surface],
  );
  return (
    <View style={styles.page} testID="database-workbench-specimen">
      <View
        style={[
          styles.frame,
          props.width ? { width: props.width } : styles.fill,
          // A page takes the host page gutter and column edge, as `PluginPageContent` frames it.
          props.surface === 'page' ? styles.pageGutter : null,
        ]}
      >
        <HappierColumnEdgeContext.Provider value={props.surface === 'page' ? HAPPIER_PAGE_METRICS.sheetInsetPx : 0}>
        <BundledPluginSurfaceMount
          module={module as never}
          pluginId={PLUGIN_ID}
          displayName="Database"
          context={context}
          hostApi={hostApi}
          launchInput={launchInput as never}
          presentation={presentation}
          {...(subPath ? { subPath } : {})}
        />
        </HappierColumnEdgeContext.Provider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    flexDirection: 'row',
    // The shell's own sidebar can float over a dev route's left edge; a sized frame sits at the right, where the
    // lab's content column sits beside the Projects sidebar.
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.surface.base,
  },
  pageGutter: {
    paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
  },
  frame: {
    flexShrink: 0,
    alignSelf: 'stretch',
  },
  fill: {
    flex: 1,
  },
}));
