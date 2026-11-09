import * as React from 'react';
import { Platform, Pressable, type View } from 'react-native';

/**
 * Where an option sits in the set a list numbers across its whole popup (`aria-posinset`,
 * `aria-setsize`). A virtualized list publishes these here instead of handing them to every row as
 * props: each arriving result changes the set size of every row and the position of every row
 * below it, and as row props that redrew each of those rows' whole content. Read by the option's
 * own pressable only, a changed number redraws that one element.
 *
 * The list publishes the set size once; each row publishes its own position. A number the row
 * passes explicitly wins; outside a provider nothing is emitted.
 */
export const ListOptionSetSizeContext = React.createContext<number | undefined>(undefined);
export const ListOptionPositionContext = React.createContext<number | undefined>(undefined);

type OptionPressableProps = React.ComponentProps<typeof Pressable> & Readonly<{
    /** An `option` element whose caller supplied no set size of its own. */
    readsListOptionSetSize: boolean;
    /** An `option` element whose caller supplied no position of its own. */
    readsListOptionPosition: boolean;
}>;

/** `Pressable` that adds the list-published `aria-setsize` / `aria-posinset` on web when asked to. */
export const ListOptionPressable = React.forwardRef<View, OptionPressableProps>(function ListOptionPressable(
    { readsListOptionSetSize, readsListOptionPosition, ...props },
    ref,
) {
    const setSize = React.useContext(ListOptionSetSizeContext);
    const position = React.useContext(ListOptionPositionContext);
    const web = Platform.OS === 'web';
    const setPositionProps: Record<string, unknown> | null = web ? {
        ...(readsListOptionSetSize && setSize !== undefined ? { 'aria-setsize': setSize } : null),
        ...(readsListOptionPosition && position !== undefined ? { 'aria-posinset': position } : null),
    } : null;
    return <Pressable ref={ref} {...props} {...setPositionProps} />;
});
