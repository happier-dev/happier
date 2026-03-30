import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { formatSessionUpdatedAtForCli, shortenSessionIdForCli } from '@/ui/sessionListFormatting';

export type SessionActionSelectorRow = Readonly<{
  sessionId: string;
  agentId: string;
  updatedAt: number;
  title: string;
  path: string;
  annotation?: string | null;
  probeable?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
}>;

function findNextIndex(rows: ReadonlyArray<SessionActionSelectorRow>, start: number, direction: 1 | -1): number {
  if (rows.length === 0) return 0;
  let index = start;
  index += direction;
  if (index < 0) index = rows.length - 1;
  if (index >= rows.length) index = 0;
  return index;
}

export function SessionActionSelector(props: Readonly<{
  title: string;
  actionVerb: string;
  footerHint?: string | null;
  rows: ReadonlyArray<SessionActionSelectorRow>;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  onProbe?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
}>): React.ReactElement {
  const initialRows = useMemo(() => props.rows.slice(0, 200), [props.rows]);
  const [rows, setRows] = useState<ReadonlyArray<SessionActionSelectorRow>>(initialRows);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setRows(initialRows);
    setSelectedIndex(0);
  }, [initialRows]);

  useInput((input, key) => {
    if (rows.length === 0) return;
    if (key.upArrow) {
      setSelectedIndex((prev) => findNextIndex(rows, prev, -1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => findNextIndex(rows, prev, 1));
      return;
    }
    if (key.return) {
      const selected = rows[selectedIndex];
      if (selected && !selected.disabled) props.onSelect(selected.sessionId);
      return;
    }
    if ((input === 'p' || input === 'P') && props.onProbe) {
      const selected = rows[selectedIndex];
      if (!selected?.probeable) return;

      setRows((currentRows) => currentRows.map((row, index) => index === selectedIndex
        ? {
            ...row,
            annotation: 'remote checking',
            disabled: true,
            disabledReason: 'Checking remote reachability…',
          }
        : row));

      void props.onProbe(selected.sessionId).then((result) => {
        setRows((currentRows) => currentRows.map((row) => {
          if (row.sessionId !== selected.sessionId) return row;
          if (result.reachable) {
            return {
              ...row,
              annotation: 'remote ok',
              disabled: false,
              disabledReason: null,
            };
          }
          return {
            ...row,
            annotation: 'remote',
            disabled: true,
            disabledReason: result.reason ?? 'Remote session is unreachable.',
          };
        }));
      });
      return;
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      props.onCancel();
    }
  });

  const nowMs = Date.now();

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text>{props.title}</Text>
      </Box>

      <Box flexDirection="column">
        {rows.map((row, index) => {
          const isSelected = index === selectedIndex;
          const title = row.title?.trim() ? row.title.trim() : '(untitled)';
          const updated = formatSessionUpdatedAtForCli(row.updatedAt, nowMs);
          const id = shortenSessionIdForCli(row.sessionId);
          const annotation = row.annotation?.trim() ? `  [${row.annotation.trim()}]` : '';
          const suffix = row.disabled && row.disabledReason ? `  —  ${row.disabledReason}` : '';
          const label = `${title}  ${row.agentId}${annotation}  ${updated}  ${id}  ${row.path}${suffix}`.trim();

          return (
            <Box key={row.sessionId}>
              <Text color={row.disabled ? 'gray' : isSelected ? 'cyan' : undefined} dimColor={row.disabled}>
                {isSelected && !row.disabled ? '› ' : '  '}
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          Use ↑/↓ to select, Enter to {props.actionVerb}, Esc to cancel
        </Text>
        {props.onProbe ? <Text dimColor>Press P to check remote reachability</Text> : null}
        {props.footerHint ? <Text dimColor>{props.footerHint}</Text> : null}
      </Box>
    </Box>
  );
}
