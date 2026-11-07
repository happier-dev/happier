import {
  useId,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';

/** The control under a clipped body: Show more / Show less, told whether the body is open and which body it opens. */
export type HappierCollapsibleBodyActionProps = Readonly<{
  label: string;
  onPress: () => void;
  expanded?: boolean;
  /** The id of the body this control opens (web `aria-controls`). */
  controls?: string;
  testID?: string;
}>;

export type HappierCollapsibleBodyProps = Readonly<{
  /** The clipped height. */
  maxHeight: number;
  /**
   * How far past `maxHeight` a body may run and still be drawn whole, so a body barely over the bound is never cut
   * by one line. Until the body is measured it is clipped, so a long body never paints full length and shrinks.
   */
  slack?: number;
  showMore: string;
  showLess: string;
  Action: ComponentType<HappierCollapsibleBodyActionProps>;
  /** The caller's bottom-edge fade (its scroll-edge mask owner) while the body is clipped. */
  fade?:
    | HappierPortableStyle
    | Readonly<{ maskImage: string; WebkitMaskImage: string }>;
  gap?: number;
  /** On the clipping box. */
  testID?: string;
  /** On the measured body inside it. */
  contentTestID?: string;
  /** On the Show more / Show less control. */
  actionTestID?: string;
  children: ReactNode;
}>;

/**
 * A long body bounded to a preview height with a Show more / Show less control; a body that fits is drawn whole with
 * nothing to open. One owner for every clipped preview (a returned answer, a pull request description, a long comment).
 * While clipped under a fade, the opener stands centred in the fade, on the words it opens; open (or with no fade to
 * stand in), the control sits centred under the body, on the same axis.
 *
 * The clip is visual, so what it hides must not stay reachable unseen: when keyboard focus enters the body (a link
 * below the fold), the body opens first, and the control says whether it is open and which body it opens. Visible
 * links in the preview stay reachable as they are.
 */
export function HappierCollapsibleBody(
  props: HappierCollapsibleBodyProps,
): ReactElement {
  const { Action } = props;
  const [expanded, setExpanded] = useState(false);
  const [naturalHeight, setNaturalHeight] = useState<number | null>(null);
  const bodyId = useId();
  const overflowing =
    naturalHeight !== null &&
    naturalHeight > props.maxHeight + (props.slack ?? 0);
  const clipped = !expanded && (naturalHeight === null || overflowing);
  // The opener stands in the fade it explains, a sibling of the masked box so the mask never fades the control itself.
  const inFade = overflowing && !expanded && props.fade !== undefined;
  return (
    <View style={{ minWidth: 0 }}>
      <View
        nativeID={bodyId}
        {...(props.testID === undefined ? {} : { testID: props.testID })}
        style={
          clipped
            ? {
                minWidth: 0,
                maxHeight: props.maxHeight,
                overflow: 'hidden',
                ...(overflowing ? props.fade : null),
              }
            : { minWidth: 0 }
        }
        // Focus moving into a clipped body opens it, so the focused control is never hidden under the clip.
        {...(overflowing && !expanded
          ? { onFocus: () => setExpanded(true) }
          : {})}
      >
        <View
          {...(props.contentTestID === undefined
            ? {}
            : { testID: props.contentTestID })}
          onLayout={(event) =>
            setNaturalHeight(event.nativeEvent.layout.height)
          }
        >
          {props.children}
        </View>
      </View>
      {overflowing ? (
        // One place in the tree for both states, so pressing it keeps keyboard focus on the control.
        <View
          pointerEvents="box-none"
          style={
            inFade
              ? { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' }
              : { alignItems: 'center', ...(props.gap === undefined ? {} : { marginTop: props.gap }) }
          }
        >
          <Action
            label={expanded ? props.showLess : props.showMore}
            expanded={expanded}
            controls={bodyId}
            onPress={() => setExpanded((value) => !value)}
            {...(props.actionTestID === undefined
              ? {}
              : { testID: props.actionTestID })}
          />
        </View>
      ) : null}
    </View>
  );
}
