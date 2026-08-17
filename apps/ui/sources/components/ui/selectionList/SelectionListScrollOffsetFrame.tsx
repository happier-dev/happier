/**
 * A layout container that keeps `SelectionListScrollIntoViewContext` honest.
 *
 * Rows report their position with `onLayout`, whose `y` is relative to the
 * nearest layout parent. Every wrapper introduced between the scroll frame and
 * a row therefore rebases that `y` to ~0 and quietly breaks scroll-into-view:
 * the list would scroll to the top of the wrapper instead of to the row.
 *
 * This frame measures its own offset and re-adds it before forwarding the
 * layout event upward, so wrappers can be nested freely. Sections use it; so
 * does the columns variant, whose visual row is exactly such a wrapper.
 *
 * Extracted to its own module so both the section renderer and the row
 * renderer can own the same behaviour without an import cycle between them.
 */

import * as React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { SelectionListScrollIntoViewContext } from './SelectionListScrollIntoViewContext';

export function SelectionListScrollOffsetFrame(props: Readonly<{
    children: React.ReactNode;
    style: StyleProp<ViewStyle>;
    testID?: string;
    /**
     * Optional role for the frame itself. The columns variant passes
     * `presentation` because its visual row is pure layout and must not
     * interpose a generic element between the popup and its rows.
     */
    role?: ViewProps['role'];
    /**
     * Extra accessibility props for the frame itself. The columns variant uses
     * it to make its visual row the `role="row"` of the grid pattern, which
     * needs an `aria-rowindex` alongside the role.
     */
    ariaProps?: Readonly<Record<string, unknown>>;
}>): React.ReactElement {
    const parentRegisterItemLayout = React.useContext(SelectionListScrollIntoViewContext);
    const offsetYRef = React.useRef(0);
    const registerItemLayout = React.useCallback<NonNullable<typeof parentRegisterItemLayout>>((optionId) => {
        const parentHandler = parentRegisterItemLayout?.(optionId);
        return (event) => {
            const layout = event.nativeEvent?.layout;
            if (!layout || typeof layout.y !== 'number') {
                parentHandler?.(event);
                return;
            }
            parentHandler?.({
                ...event,
                nativeEvent: {
                    ...event.nativeEvent,
                    layout: {
                        ...layout,
                        y: offsetYRef.current + layout.y,
                    },
                },
            });
        };
    }, [parentRegisterItemLayout]);

    return (
        <SelectionListScrollIntoViewContext.Provider
            value={parentRegisterItemLayout ? registerItemLayout : null}
        >
            <View
                testID={props.testID}
                style={props.style}
                {...(props.ariaProps ?? {})}
                role={props.role}
                onLayout={(event) => {
                    const nextY = event.nativeEvent.layout.y;
                    if (typeof nextY === 'number') {
                        offsetYRef.current = nextY;
                    }
                }}
            >
                {props.children}
            </View>
        </SelectionListScrollIntoViewContext.Provider>
    );
}
