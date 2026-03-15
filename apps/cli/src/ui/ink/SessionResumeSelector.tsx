import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { formatSessionUpdatedAtForCli, shortenSessionIdForCli } from '@/ui/sessionListFormatting';

export type SessionResumeSelectorRow = Readonly<{
  sessionId: string;
  agentId: string;
  updatedAt: number;
  title: string;
  path: string;
}>;

export function SessionResumeSelector(props: Readonly<{
  rows: ReadonlyArray<SessionResumeSelectorRow>;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}>): React.ReactElement {
  const rows = useMemo(() => props.rows.slice(0, 200), [props.rows]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    const maxIndex = Math.max(0, rows.length - 1);
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(maxIndex, prev + 1));
      return;
    }
    if (key.return) {
      const selected = rows[selectedIndex];
      if (selected) props.onSelect(selected.sessionId);
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
        <Text>Resume a session</Text>
      </Box>

      <Box flexDirection="column">
        {rows.map((row, index) => {
          const isSelected = index === selectedIndex;
          const title = row.title?.trim() ? row.title.trim() : '(untitled)';
          const updated = formatSessionUpdatedAtForCli(row.updatedAt, nowMs);
          const id = shortenSessionIdForCli(row.sessionId);
          const label = `${title}  ${row.agentId}  ${updated}  ${id}  ${row.path}`.trim();

          return (
            <Box key={row.sessionId}>
              <Text color={isSelected ? 'cyan' : undefined}>
                {isSelected ? '› ' : '  '}
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Use ↑/↓ to select, Enter to resume, Esc to cancel</Text>
      </Box>
    </Box>
  );
}
