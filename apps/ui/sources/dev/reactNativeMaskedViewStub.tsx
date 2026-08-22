import * as React from 'react';

/**
 * Node-safe stand-in for `@react-native-masked-view/masked-view`.
 *
 * The published package ships Flow-typed JSX in a plain `.js` file, which Vite's import analysis
 * cannot parse — importing it from any suite fails the whole module graph before a single
 * assertion runs. It is a native view with no JS behaviour to exercise, so the honest stub renders
 * its children and drops the mask, exactly as the reanimated and keyboard-controller stubs do for
 * their packages.
 *
 * The mask itself is a rendering concern with no observable contract in node, so a test that cares
 * about masking has to be a device or screenshot check rather than a unit test.
 */

type MaskedViewProps = Readonly<{
    children?: React.ReactNode;
    maskElement?: React.ReactNode;
    [key: string]: unknown;
}>;

function MaskedView({ children, maskElement: _maskElement, ...rest }: MaskedViewProps): React.ReactElement {
    return React.createElement('MaskedView', rest, children);
}

MaskedView.displayName = 'MaskedView';

export default MaskedView;
export { MaskedView, type MaskedViewProps };
