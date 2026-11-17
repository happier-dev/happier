import * as React from 'react';
import {
  Button,
  CodeBlock,
  Metric,
  Row,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  formatCount,
  formatDuration,
  formatPercent,
} from './format.js';
import type { StatementView } from './statements.js';
import { projectDatabaseStatementMetrics } from '../../../insights/presentation.js';

/**
 * One statement: its shape, what it costs, what changed since your last look, and where to go next. The same body
 * serves the page's details pane, the rail's details tab and the phone's pushed page.
 */
export function StatementDetail(
  props: Readonly<{
    view: StatementView;
    /** Opens the shape in the Console beside its tables; absent where the Console isn't reachable. */
    onOpenConsole?: (sql: string) => void;
  }>,
) {
  const translate = usePluginTranslation();
  const { row, change } = props.view;
  const hit = projectDatabaseStatementMetrics(row).bufferHitRatio;
  const mean = formatDuration(props.view.meanMs);
  const changedMean = change ? formatDuration(change.meanTimeMs) : null;
  const shape = row.shape;
  return (
    <Stack gap="large">
      {shape ? (
        <CodeBlock
          code={shape}
          language="sql"
          copyLabel={translate(
            'plugins.database.insights.copyStatement',
            'Copy statement',
          )}
          copiedLabel={translate('plugins.database.insights.copied', 'Copied')}
        />
      ) : (
        <Text
          tone="secondary"
          value={translate(
            'plugins.database.insights.shapeHidden',
            'The database didn’t share this statement’s text.',
          )}
        />
      )}
      <Row gap="large" wrap>
        {mean ? (
          <Metric
            size="stat"
            label={translate('plugins.database.insights.mean', 'Mean')}
            value={mean}
            {...(changedMean
              ? {
                  caption: translate(
                    'plugins.database.insights.meanSince',
                    '{mean} since your last look',
                    { mean: changedMean },
                  ),
                }
              : {})}
          />
        ) : null}
        <Metric
          size="stat"
          label={translate('plugins.database.insights.calls', 'Calls')}
          value={formatCount(row.calls) ?? row.calls}
          {...(change
            ? {
                caption: translate(
                  'plugins.database.insights.callsSince',
                  '{calls} since your last look',
                  { calls: formatCount(change.calls) ?? change.calls },
                ),
              }
            : props.view.isNew
              ? {
                  caption: translate(
                    'plugins.database.insights.new',
                    'New since your last look',
                  ),
                }
              : {})}
        />
        {props.view.rowsPerCall !== null ? (
          <Metric
            size="stat"
            label={translate(
              'plugins.database.insights.rowsPerCall',
              'Rows per call',
            )}
            value={formatCount(Math.round(props.view.rowsPerCall)) ?? '0'}
          />
        ) : null}
        {hit !== null ? (
          <Metric
            size="stat"
            label={translate(
              'plugins.database.insights.memory',
              'Read from memory',
            )}
            value={formatPercent(hit) ?? ''}
            caption={translate(
              'plugins.database.insights.memoryCaption',
              'of the blocks it read',
            )}
          />
        ) : null}
      </Row>
      <Text
        tone="secondary"
        variant="meta"
        value={translate(
          'plugins.database.insights.explainHint',
          'Statement statistics say how much time it takes, not why. Explain shows how it reads its rows.',
        )}
      />
      {shape && props.onOpenConsole ? (
        <Row gap="small" wrap>
          <Button
            variant="secondary"
            size="small"
            title={translate(
              'plugins.database.insights.openConsole',
              'Open in Console',
            )}
            onPress={() => props.onOpenConsole?.(shape)}
          />
        </Row>
      ) : null}
    </Stack>
  );
}
