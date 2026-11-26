import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import {
  buildToolCallMessageRouteId,
  type ToolCallMessage,
} from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CommandView } from '@/components/sessions/transcript/CommandView';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { ToolCallsGroupExpandMoreChrome } from '@/components/sessions/transcript/toolCalls/units/ToolCallsGroupExpandMoreChrome';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { ToolTimelinePreviewRow } from '@/components/tools/shell/views/timeline/ToolTimelinePreviewRow';
import { useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';

import type { ToolViewProps } from '../core/_registry';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { readScriptDisplay } from './scriptDisplay';

/** At rest the card shows the latest calls; earlier ones fold into the tool-calls group's "+N more…". */
const SUMMARY_CALL_ROWS = 4;

export { projectScriptDisplayText } from './scriptDisplay';

/**
 * The body of a `Script` tool card (Claude's REPL, Codex's exec cells, `happier tools run`): what the
 * script called, what it returned, then its source and console one press away. `ToolView` owns the
 * frame, header, status and any approval an inner call is waiting on; this view never draws an approval.
 * Closed, the source (`CodeView`) and console (`CommandView`) are not mounted.
 */
export const ScriptView = React.memo<ToolViewProps>(function ScriptView(props) {
  const find = useToolFindState(props.messageId);
  const full = props.detailLevel === 'full' || find.active;
  const display = React.useMemo(
    () => readScriptDisplay(props.tool, props.messages),
    [props.tool, props.messages],
  );
  const hasOutput = display.stdout !== null || display.stderr !== null;

  if (full) {
    return (
      <View testID="script-view" style={styles.root}>
        {display.error ? (
          <ToolError
            message={display.error}
            messageId={props.messageId}
            blockId="tool-error"
          />
        ) : null}
        {display.calls.length > 0 ? (
          <ToolSectionView
            title={t('tools.script.toolCallsCount', {
              count: display.calls.length,
            })}
          >
            <ScriptCallRail
              calls={display.calls}
              metadata={props.metadata}
              all
              focusId={props.jumpChildId ?? null}
            />
          </ToolSectionView>
        ) : null}
        {display.returned ? (
          <ToolSectionView title={t('tools.script.returned')}>
            <ScriptReturned
              text={display.returned}
              messageId={props.messageId}
              full
            />
          </ToolSectionView>
        ) : null}
        <ToolSectionView title={t('tools.script.scriptDisclosure')} fullWidth>
          <CodeView
            code={display.code}
            language={display.language}
            findRanges={find.ranges('tool-script-code')}
          />
        </ToolSectionView>
        {hasOutput ? (
          <ToolSectionView title={t('tools.script.outputDisclosure')}>
            <CommandView
              stdout={display.stdout}
              stderr={display.stderr}
              stdoutFindRanges={find.ranges('tool-stdout')}
              stderrFindRanges={find.ranges('tool-stderr')}
              hideEmptyOutput
            />
          </ToolSectionView>
        ) : null}
      </View>
    );
  }

  return (
    <View testID="script-view" style={styles.root}>
      {display.error ? (
        <ToolError
          message={display.error}
          messageId={props.messageId}
          blockId="tool-error"
        />
      ) : null}
      {display.calls.length > 0 ? (
        <ScriptCallRail
          calls={display.calls}
          metadata={props.metadata}
          sessionId={props.sessionId}
          serverId={props.serverId}
          scriptToolId={
            typeof props.tool.id === 'string' ? props.tool.id : null
          }
          messageId={props.messageId}
        />
      ) : null}
      {display.returned ? (
        <ScriptReturned text={display.returned} messageId={props.messageId} />
      ) : null}
      <ScriptDisclosures
        code={display.code}
        language={display.language}
        stdout={display.stdout}
        stderr={display.stderr}
      />
    </View>
  );
});

/** The inner calls, one canonical tool row each; a row opens the script's details page at that call. */
const ScriptCallRail = React.memo(function ScriptCallRail(
  props: Readonly<{
    calls: readonly ToolCallMessage[];
    metadata: Metadata | null;
    all?: boolean;
    sessionId?: string;
    serverId?: string;
    scriptToolId?: string | null;
    messageId?: string;
    /** The call a details page was opened at (`?jumpChildId=`). */
    focusId?: string | null;
  }>,
) {
  const transcriptSource = useSessionTranscriptSource();
  const [expanded, setExpanded] = React.useState(false);
  const showAll = props.all === true || expanded;
  const shown = showAll
    ? props.calls
    : props.calls.slice(Math.max(0, props.calls.length - SUMMARY_CALL_ROWS));
  const hiddenCount = props.calls.length - shown.length;
  const expand = React.useCallback(() => setExpanded(true), []);

  const routeMessageId = buildToolCallMessageRouteId({
    toolId: props.scriptToolId ?? null,
    fallbackMessageId: props.messageId,
  });
  const canOpen =
    props.all !== true &&
    transcriptSource.navigate !== null &&
    Boolean(props.sessionId) &&
    Boolean(routeMessageId);
  const openCall = useEventCallback((call: ToolCallMessage) => {
    if (!canOpen || !props.sessionId || !routeMessageId) return;
    const childRouteId =
      buildToolCallMessageRouteId({
        toolId: typeof call.tool.id === 'string' ? call.tool.id : null,
        fallbackMessageId: call.id,
      }) ?? call.id;
    navigateWithBlurOnWeb(() => {
      transcriptSource.navigate?.(
        buildScopedSessionRouteHref({
          sessionId: props.sessionId!,
          serverId: props.serverId,
          suffix: `/message/${encodeURIComponent(routeMessageId)}?jumpChildId=${encodeURIComponent(childRouteId)}`,
        }),
      );
    });
  });

  return (
    <View testID="script-view-calls" accessibilityRole="list">
      {hiddenCount > 0 ? (
        <ToolCallsGroupExpandMoreChrome
          hiddenCount={hiddenCount}
          onExpand={expand}
        />
      ) : null}
      {shown.map((call) => (
        <ScriptCallRow
          key={call.id}
          call={call}
          metadata={props.metadata}
          onOpen={canOpen ? openCall : null}
          focused={props.focusId != null && isCall(call, props.focusId)}
        />
      ))}
    </View>
  );
});

const ScriptCallRow = React.memo(function ScriptCallRow(
  props: Readonly<{
    call: ToolCallMessage;
    metadata: Metadata | null;
    onOpen: ((call: ToolCallMessage) => void) | null;
    focused: boolean;
  }>,
) {
  const { onOpen, call } = props;
  const onPress = React.useMemo(
    () => (onOpen ? () => onOpen(call) : null),
    [call, onOpen],
  );
  // One topology either way, so a focus change never remounts the row; the fill is the shared selection ink.
  return (
    <View testID={props.focused ? 'script-view-call-focused' : undefined} style={props.focused ? styles.focusedCall : null}>
      <ToolTimelinePreviewRow
        toolMessage={call}
        metadata={props.metadata}
        onPress={onPress}
      />
    </View>
  );
});

/** A details page link names a call by its message id or its tool-call route id. */
function isCall(call: ToolCallMessage, routeId: string): boolean {
  if (call.id === routeId) return true;
  return buildToolCallMessageRouteId({
    toolId: typeof call.tool.id === 'string' ? call.tool.id : null,
    fallbackMessageId: call.id,
  }) === routeId;
}

function ScriptReturned(
  props: Readonly<{ text: string; messageId?: string; full?: boolean }>,
) {
  return (
    <View testID="script-view-returned" style={styles.returned}>
      {props.full ? null : (
        <Text variant="meta" style={styles.returnedLabel} numberOfLines={1}>
          {t('tools.script.returned')}
        </Text>
      )}
      <ToolFindText
        messageId={props.messageId}
        blockId="tool-script-returned"
        text={props.text}
        style={styles.returnedText}
        numberOfLines={props.full ? undefined : 3}
      />
    </View>
  );
}

/** "Script source" and "Output": closed at rest; opening one mounts its body. */
function ScriptDisclosures(
  props: Readonly<{
    code: string;
    language: string;
    stdout: string | null;
    stderr: string | null;
  }>,
) {
  const binding = useCoreDisclosureToggleBinding();
  const [open, setOpen] = React.useState<{ code: boolean; output: boolean }>({
    code: false,
    output: false,
  });
  const toggleCode = React.useCallback(
    () => setOpen((value) => ({ ...value, code: !value.code })),
    [],
  );
  const toggleOutput = React.useCallback(
    () => setOpen((value) => ({ ...value, output: !value.output })),
    [],
  );
  const hasOutput = props.stdout !== null || props.stderr !== null;
  return (
    <>
      <View style={styles.toggles}>
        <HappierDisclosureToggle
          testID="script-view-code-toggle"
          label={t('tools.script.scriptDisclosure')}
          open={open.code}
          onPress={toggleCode}
          caret={binding.renderCaret(open.code)}
          renderLabel={binding.renderLabel}
          focusColor={binding.focusColor}
        />
        {hasOutput ? (
          <HappierDisclosureToggle
            testID="script-view-output-toggle"
            label={t('tools.script.outputDisclosure')}
            open={open.output}
            onPress={toggleOutput}
            caret={binding.renderCaret(open.output)}
            renderLabel={binding.renderLabel}
            focusColor={binding.focusColor}
          />
        ) : null}
      </View>
      {open.code ? (
        <View testID="script-view-code">
          <CodeView code={props.code} language={props.language} />
        </View>
      ) : null}
      {open.output && hasOutput ? (
        <View testID="script-view-output">
          <CommandView
            stdout={props.stdout}
            stderr={props.stderr}
            hideEmptyOutput
          />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s10,
    paddingBottom: theme.space.s12,
  },
  returned: {
    gap: theme.space.s2,
    paddingVertical: theme.space.s8,
    paddingHorizontal: theme.space.s10,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.elevated,
  },
  returnedLabel: {
    color: theme.colors.text.tertiary,
  },
  returnedText: {
    ...Typography.variant('meta'),
    ...Typography.mono(),
    color: theme.colors.text.primary,
  },
  focusedCall: {
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.selected,
  },
  toggles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s16,
  },
}));
