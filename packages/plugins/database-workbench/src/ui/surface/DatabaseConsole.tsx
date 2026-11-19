import * as React from 'react';
import type { DatabaseOperationResultV1, DatabaseStatementResultV1 } from '@happier-dev/plugin-sdk/database';
import {
  Action,
  Button,
  CodeBlock,
  ErrorState,
  Item,
  ItemGroup,
  PageHeader,
  Popover,
  Row,
  Select,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  CodeEditor,
  Collection,
  useHappierCollection,
} from '@happier-dev/plugin-ui/components';
import { useDatabaseConsole, useDatabaseTargets, useWorkbenchInstance } from '../hooks.js';
import type { WorkbenchLaunchInput } from './mount.js';
import { projectColumn } from '../projections.js';
import { CellText } from './cells.js';
import { ConsoleParameters } from './ConsoleParameters.js';
import { useGridAnatomy, type GridColumn, type GridRow } from './grid.js';

const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_PARAMETERS: readonly never[] = Object.freeze([]);

function ResultRows(
  props: Readonly<{
    result: DatabaseStatementResultV1;
    translate: PluginTranslate;
  }>,
) {
  const columns = React.useMemo(
    () => props.result.columns.map((column) => projectColumn(column)),
    [props.result.columns],
  );
  const rows = React.useMemo<readonly GridRow[]>(
    () =>
      props.result.rows.map((row, index) => ({
        rowKey: String(index),
        cells: row.cells,
      })),
    [props.result.rows],
  );
  const renderCell = React.useCallback(
    (row: GridRow, _column: GridColumn, index: number) => (
      <CellText cell={row.cells[index]} translate={props.translate} />
    ),
    [props.translate],
  );
  const anatomy = useGridAnatomy(columns, props.translate, renderCell, false);
  const model = useHappierCollection({
    items: rows,
    keyOf: (row) => row.rowKey,
    openKey: null,
    onOpenChange: () => {},
  });
  return (
    <Collection
      accessibilityLabel={props.translate(
        'plugins.database.console.result',
        'Result',
      )}
      model={model}
      anatomy={anatomy}
      presentation="table"
      detail="none"
      collapsedGroups={EMPTY_SET}
      minListWidth={320}
      minDetailWidth={320}
      preferredListRatio={1}
      empty={
        <Text
          tone="secondary"
          value={props.translate('plugins.database.console.noRows', 'No rows')}
        />
      }
      footer={
        // The run's outcome in one quiet line: how many rows came back, or that only the first ones did.
        <Text
          tone="secondary"
          variant="meta"
          value={props.result.completeness.complete
            ? rows.length === 1
              ? props.translate('plugins.database.console.oneRow', '1 row')
              : props.translate('plugins.database.console.rowCount', '{count} rows', { count: String(rows.length) })
            : props.translate(
              'plugins.database.console.partial',
              'Showing the first {count} rows',
              { count: String(rows.length) },
            )}
        />
      }
    />
  );
}

function ConsoleResult(
  props: Readonly<{
    result: DatabaseOperationResultV1 | undefined;
    translate: PluginTranslate;
  }>,
) {
  const result = props.result;
  if (!result || !result.ok) return null;
  if (result.operation === 'statement.explain') {
    return (
      <CodeBlock
        code={
          typeof result.plan === 'string'
            ? result.plan
            : JSON.stringify(result.plan, null, 2)
        }
        language={result.format === 'json' ? 'json' : undefined}
        copyLabel={props.translate(
          'plugins.database.console.copyPlan',
          'Copy plan',
        )}
      />
    );
  }
  if (result.operation !== 'statement.run') return null;
  const last = result.results[result.results.length - 1];
  if (!last)
    return (
      <Text
        tone="secondary"
        value={props.translate('plugins.database.console.done', 'Done')}
      />
    );
  if (last.columns.length === 0) {
    return (
      <Text
        tone="secondary"
        value={
          last.affectedRows !== undefined
            ? props.translate(
                'plugins.database.console.affected',
                '{count} rows changed',
                { count: last.affectedRows },
              )
            : props.translate('plugins.database.console.done', 'Done')
        }
      />
    );
  }
  return <ResultRows result={last} translate={props.translate} />;
}

function HistoryMenu(
  props: Readonly<{
    history: readonly Readonly<{ sql: string }>[];
    onPick: (sql: string) => void;
    onClear: () => void;
  }>,
) {
  const translate = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  if (props.history.length === 0) return null;
  const label = translate('plugins.database.console.history', 'History');
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerAccessibilityLabel={label}
      triggerAppearance="text"
      triggerSize="small"
      triggerDisclosure
    >
      <ItemGroup surface="none">
        {props.history.map((entry, index) => (
          // A statement is code: the row's title in the code face, two lines at most (lab dbConsole/history).
          <Item
            key={`${index}:${entry.sql}`}
            title={entry.sql}
            titleNumberOfLines={2}
            identifier
            onPress={() => {
              props.onPick(entry.sql);
              setOpen(false);
            }}
          />
        ))}
      </ItemGroup>
      <Button
        variant="plain"
        size="small"
        title={translate(
          'plugins.database.console.clearHistory',
          'Clear history',
        )}
        onPress={() => {
          props.onClear();
          setOpen(false);
        }}
      />
    </Popover>
  );
}

/** SQL against this database: read by default, write only by choice, Explain beside Run. */
export function DatabaseConsole(props: Readonly<{ targetKey: string; scope: WorkbenchLaunchInput['scope'] }>) {
  const translate = usePluginTranslation();
  const instance = useWorkbenchInstance();
  const sql = useDatabaseConsole(props.targetKey);
  const descriptor = instance.target(props.targetKey);
  const machineLabel = useDatabaseTargets(props.scope).targets.find((candidate) => candidate.targetKey === props.targetKey)?.machineLabel ?? null;
  const canWrite = descriptor.access?.canWrite === true;
  const run = sql.run();
  const explain = sql.explain();
  const modes = React.useMemo(
    () => [
      {
        value: 'read',
        label: translate('plugins.database.console.read', 'Read'),
      },
      {
        value: 'write',
        label: translate('plugins.database.console.write', 'Write'),
        ...(canWrite
          ? {}
          : {
              unavailableReason: translate(
                'plugins.database.console.writeOff',
                'Editing is off for this database',
              ),
            }),
      },
    ],
    [canWrite, translate],
  );
  const engineIsMysql = descriptor.engine === 'mysql';
  // The run bar sits between what is sent and what comes back: statement, its parameters, then Run (lab p7AddNow/params).
  // The editor and the result share the pane's height: the editor needs a bounded box to draw in at all.
  return (
    <Stack gap="medium" grow>
      <PageHeader
        title={translate('plugins.database.console.title', 'Console')}
        // Which database and where it runs: the statement runs on that Machine (lab dbConsole), from the workbench's
        // projected target facts.
        meta={[
          { key: 'database', text: descriptor.label },
          ...(machineLabel ? [{ key: 'machine', text: translate('plugins.database.console.runsOn', 'runs on {machine}', { machine: machineLabel }) }] : []),
        ]}
        actions={
          <HistoryMenu
            history={sql.history}
            onPick={sql.setText}
            onClear={sql.clearHistory}
          />
        }
      />
      {sql.mode === 'write' && engineIsMysql ? (
        // D22: MySQL commits schema statements as it goes, so a failed batch can leave earlier changes in place.
        <Text
          tone="attention"
          variant="meta"
          value={translate(
            'plugins.database.console.mysqlNote',
            'MySQL applies schema changes immediately. If a later statement fails, earlier ones stay.',
          )}
        />
      ) : null}
      <Stack grow>
        <CodeEditor
          {...sql.editorProps}
          presentation="framed"
          showLineNumbers
        />
      </Stack>
      {/* One field per placeholder of each selected statement, from the dialect lexer (D41). */}
      {sql.parameterSlots.map((slots, statement) => (
        <ConsoleParameters
          key={statement}
          slots={slots}
          inputs={sql.parameterInputs[statement] ?? NO_PARAMETERS}
          onChange={(inputs) =>
            sql.setParameterInputs(
              sql.parameterSlots.map((_slots, at) => (at === statement ? inputs : sql.parameterInputs[at] ?? NO_PARAMETERS)),
            )
          }
        />
      ))}
      <Row gap="small" align="center">
        <Select
          label={translate('plugins.database.console.mode', 'Mode')}
          presentation="segmented"
          options={modes}
          value={sql.mode}
          onChange={(value) =>
            sql.setMode(value === 'write' ? 'write' : 'read')
          }
        />
        {sql.running ? (
          <Button
            variant="secondary"
            title={translate('plugins.database.console.stop', 'Stop')}
            onPress={() => void sql.cancel()}
          />
        ) : (
          <Action.Control
            {...run}
            title={translate('plugins.database.console.run', 'Run')}
            variant="primary"
          />
        )}
        <Action.Control
          {...explain}
          title={translate('plugins.database.console.explain', 'Explain')}
          variant="secondary"
          disabled={sql.running}
        />
      </Row>
      <Stack grow>
        {sql.error?.code === 'database_cancelled' ? (
          // Stopping is the person's own choice, not a failure: one quiet line.
          <Text
            tone="secondary"
            value={translate('plugins.database.console.stopped', 'Stopped. Nothing was changed.')}
          />
        ) : sql.error ? (
          // The database's own words lead; a read, or a write in its transaction, changed nothing. MySQL keeps the
          // schema changes before a failed statement (D22), so it says nothing of the kind.
          <ErrorState
            layout="line"
            kind="error"
            title={sql.error.message}
            {...(sql.mode === 'write' && engineIsMysql ? {} : {
              description: translate('plugins.database.console.nothingChanged', 'Nothing was changed.'),
            })}
          />
        ) : (
          <ConsoleResult result={sql.result} translate={translate} />
        )}
      </Stack>
    </Stack>
  );
}
