import * as React from 'react';
import {
  CodeBlock,
  Popover,
  Select,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { useRelationPage } from '../hooks.js';
import { exportSelectedRows } from '../../selectedExport.js';

type Page = ReturnType<typeof useRelationPage>;

/**
 * Export of the loaded rows (D27 #8): the one serialization owner the agent Action also uses, so the file is the
 * same either way, and it says how complete it is. A whole-table export is a separate, later flow.
 */
export function RowsExport(props: Readonly<{ page: Page }>) {
  const translate = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const [format, setFormat] = React.useState<'csv' | 'json'>('csv');
  const { page } = props;
  const exported = React.useMemo(() => {
    if (!open || !page.exportInput || page.rows.length === 0) return null;
    return exportSelectedRows(
      page.exportInput(
        page.rows.map((row) => row.rowKey),
        format,
      ),
    );
  }, [open, page, format]);
  if (page.rows.length === 0 || !page.exportInput) return null;
  const label = translate('plugins.database.export.title', 'Export…');
  const total = page.page.approxTotal;
  const scope = exported?.completeness.complete
    ? translate(
        'plugins.database.export.complete',
        '{count} rows · the whole result',
        { count: String(exported.rowCount) },
      )
    : total
      ? translate(
          'plugins.database.export.partialOf',
          '{count} loaded rows · not the whole table: ~{total} rows match',
          {
            count: String(exported?.rowCount ?? page.rows.length),
            total,
          },
        )
      : translate(
          'plugins.database.export.partial',
          '{count} loaded rows · not the whole table',
          {
            count: String(exported?.rowCount ?? page.rows.length),
          },
        );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerAccessibilityLabel={label}
      triggerSize="small"
    >
      <Stack gap="small">
        <Select
          label={translate('plugins.database.export.format', 'Format')}
          presentation="segmented"
          options={[
            { value: 'csv', label: 'CSV' },
            { value: 'json', label: 'JSON' },
          ]}
          value={format}
          onChange={(value) => setFormat(value === 'json' ? 'json' : 'csv')}
        />
        <Text value={scope} />
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
