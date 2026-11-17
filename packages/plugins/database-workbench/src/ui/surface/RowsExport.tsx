import * as React from 'react';
import {
  CodeBlock,
  Popover,
  Select,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  useListMultiSelectionStoreSnapshot,
  type ListMultiSelectionStore,
} from '@happier-dev/plugin-ui/components';
import type { useRelationPage } from '../hooks.js';
import { exportSelectedRows } from '../../selectedExport.js';

type Page = ReturnType<typeof useRelationPage>;

/**
 * Export of the loaded rows (D27 #8): the one serialization owner the agent Action also uses, so the file is the
 * same either way, and it says how complete it is. A whole-table export is a separate, later flow.
 */
export function RowsExport(
  props: Readonly<{ page: Page; selection: ListMultiSelectionStore }>,
) {
  const translate = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const [format, setFormat] = React.useState<'csv' | 'json'>('csv');
  const [scope, setScope] = React.useState<'selected' | 'loaded'>('selected');
  const { page } = props;
  const chosen = useListMultiSelectionStoreSnapshot(props.selection);
  const selectedKeys = React.useMemo(
    () => page.rows.filter((row) => chosen.selectedKeys.has(row.rowKey)).map((row) => row.rowKey),
    [page.rows, chosen.selectedKeys],
  );
  const exportsSelected = scope === 'selected' && selectedKeys.length > 0;
  const exported = React.useMemo(() => {
    if (!open || !page.exportInput || page.rows.length === 0) return null;
    return exportSelectedRows(
      page.exportInput(exportsSelected ? selectedKeys : page.rows.map((row) => row.rowKey), format),
    );
  }, [open, page, format, exportsSelected, selectedKeys]);
  if (page.rows.length === 0 || !page.exportInput) return null;
  const label =
    selectedKeys.length > 0
      ? translate('plugins.database.export.titleSelected', 'Export {count} selected…', { count: String(selectedKeys.length) })
      : translate('plugins.database.export.title', 'Export…');
  const total = page.page.approxTotal;
  const count = String(exported?.rowCount ?? (exportsSelected ? selectedKeys.length : page.rows.length));
  // Completeness is said once: chosen rows are never "the whole table", loaded rows are unless more match.
  const completeness = exportsSelected
    ? translate('plugins.database.export.selectedLine', '{count} selected rows · every column', { count })
    : exported?.completeness.complete
      ? translate('plugins.database.export.complete', '{count} rows · the whole result', { count })
      : total
        ? translate('plugins.database.export.partialOf', '{count} loaded rows · not the whole table: ~{total} rows match', { count, total })
        : translate('plugins.database.export.partial', '{count} loaded rows · not the whole table', { count });
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={label} triggerAccessibilityLabel={label} triggerSize="small">
      <Stack gap="small">
        <Select
          label={translate('plugins.database.export.format', 'Format')}
          presentation="segmented"
          options={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]}
          value={format}
          onChange={(value) => setFormat(value === 'json' ? 'json' : 'csv')}
        />
        {selectedKeys.length > 0 ? (
          <Select
            label={translate('plugins.database.export.scope', 'Rows')}
            presentation="segmented"
            options={[
              { value: 'selected', label: translate('plugins.database.export.scopeSelected', 'Selected') },
              { value: 'loaded', label: translate('plugins.database.export.scopeLoaded', 'Loaded') },
            ]}
            value={scope}
            onChange={(value) => setScope(value === 'loaded' ? 'loaded' : 'selected')}
          />
        ) : null}
        <Text value={completeness} />
        {exported && exported.partialCells.length > 0 ? (
          <Text
            tone="secondary"
            variant="meta"
            value={translate(
              'plugins.database.export.cutValues',
              '{count} values were longer than the preview and are cut in this export.',
              { count: String(exported.partialCells.length) },
            )}
          />
        ) : null}
        {exported ? (
          <CodeBlock
            code={exported.content}
            language={format === 'json' ? 'json' : undefined}
            copyLabel={translate('plugins.database.export.copy', 'Copy')}
          />
        ) : null}
      </Stack>
    </Popover>
  );
}
