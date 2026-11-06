import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useGlassBackedInk } from '@/components/ui/glass/glassBackedInk';
import { ComposerChipView } from '@/components/ui/forms/composerEditor/ComposerChipView.web';
import {
  COMPOSER_EDITOR_CONTENT_STYLE,
  resolveComposerEditorHostStyle,
} from '@/components/ui/forms/composerEditor/composerEditorHostStyle.web';
import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '@/components/ui/forms/multiTextInputTypography';
import { ensureReferenceChipStyles } from '@/components/ui/referenceChip/referenceChipStyles';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';

import { useAgentInputDefaultMaxHeight } from '../useAgentInputDefaultMaxHeight';

import {
  splitAgentInputDocumentPreviewText,
  type AgentInputDocumentPreviewTextProps,
} from './agentInputDocumentPreviewTypes';

/** The live field's own text box, padding and paragraph, so the picture and the editor share every pixel. */
const FIELD_TEXT_STYLE = { fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE } as const;
const FIELD_PADDING_Y = 10;
const PARAGRAPH_STYLE = { margin: 0 } as const;
const OFFSET_ATTRIBUTE = 'data-preview-offset';
const END_ATTRIBUTE = 'data-preview-end';

type CaretPoint = Readonly<{ node: Node; offset: number }>;

function caretPointFromPoint(x: number, y: number): CaretPoint | null {
  const withPosition = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const position = withPosition.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

/** Maps a caret point inside the picture to an offset in the document's text. */
function resolveTextOffset(
  point: CaretPoint,
  root: HTMLElement,
): number | null {
  const element =
    point.node.nodeType === Node.TEXT_NODE
      ? point.node.parentElement
      : (point.node as Element | null);
  if (!element || !root.contains(element)) return null;
  const chip = element.closest(`[${END_ATTRIBUTE}]`);
  if (chip) return Number(chip.getAttribute(END_ATTRIBUTE));
  const segment = element.closest(`[${OFFSET_ATTRIBUTE}]`);
  if (!segment || point.node.nodeType !== Node.TEXT_NODE) return null;
  return Number(segment.getAttribute(OFFSET_ATTRIBUTE)) + point.offset;
}

/**
 * A composer document's text as the web editor draws it — same box, type, wrapping and inline chips —
 * without the editor. It holds no selection, history or editor instance.
 */
export function AgentInputDocumentPreviewText(
  props: AgentInputDocumentPreviewTextProps,
): React.ReactElement {
  const { theme } = useUnistyles();
  const uiFontScale = useLocalSetting('uiFontScale');
  const maxHeight = useAgentInputDefaultMaxHeight();
  const placeholderInk =
    useGlassBackedInk()(theme.colors.composer.chipTint) ??
    theme.colors.composer.chipTint;
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => ensureReferenceChipStyles(), []);
  const style = {
    ...resolveComposerEditorHostStyle({
      theme,
      uiFontScale,
      textStyle: FIELD_TEXT_STYLE,
      placeholderInk,
      paddingTop: props.fieldInset === false ? 0 : FIELD_PADDING_Y,
      paddingBottom: props.fieldInset === false ? 0 : FIELD_PADDING_Y,
      maxHeight,
    }),
    // The picture sits inside its activating button, whose own alignment must not reach the text.
    textAlign: 'start' as const,
    cursor: 'text',
  };
  const onPointerSelection = props.onPointerSelection;
  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      if (!onPointerSelection || !root) return;
      const point = caretPointFromPoint(event.clientX, event.clientY);
      const offset = point ? resolveTextOffset(point, root) : null;
      onPointerSelection(
        offset === null ? null : { start: offset, end: offset },
      );
    },
    [onPointerSelection],
  );
  const empty = props.value.length === 0;
  return (
    <div
      ref={rootRef}
      data-composer-editor=""
      data-testid="agent-input-document-preview-text"
      style={style}
      onPointerDown={handlePointerDown}
    >
      <div style={COMPOSER_EDITOR_CONTENT_STYLE}>
        <p
          data-empty={empty ? 'true' : undefined}
          data-placeholder={props.placeholder}
          style={PARAGRAPH_STYLE}
        >
          {splitAgentInputDocumentPreviewText(
            props.value,
            props.references,
          ).map((segment) =>
            segment.kind === 'text' ? (
              <span
                key={`t${segment.start}`}
                {...{ [OFFSET_ATTRIBUTE]: segment.start }}
              >
                {segment.text}
              </span>
            ) : (
              <span
                key={`r${segment.reference.start}`}
                data-composer-chip=""
                {...{ [END_ATTRIBUTE]: segment.reference.end }}
              >
                <ComposerChipView
                  reference={{
                    ref: segment.reference.ref,
                    token: props.value.slice(
                      segment.reference.start,
                      segment.reference.end,
                    ),
                    start: segment.reference.start,
                    end: segment.reference.end,
                    kind: '',
                    label: segment.reference.label,
                    ...(segment.reference.unavailable
                      ? { state: 'unavailable' as const }
                      : {}),
                  }}
                  selected={false}
                />
              </span>
            ),
          )}
        </p>
      </div>
    </div>
  );
}
