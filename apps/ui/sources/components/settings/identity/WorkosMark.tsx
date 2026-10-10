import * as React from 'react';
import Svg, { Path } from 'react-native-svg';

/** The WorkOS mark used by the approved Home/Team identity design, without a surrounding tile. */
export const WorkosMark = React.memo(function WorkosMark(props: Readonly<{ size?: number }>) {
    const size = props.size ?? 22;
    return <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
        <Path d="M7.2 3.5h9.6l5 8.5-5 8.5H7.2l-5-8.5 5-8.5Z" fill="#6363F1" />
        <Path d="M10 8.2 7.9 12l2.1 3.8M14 8.2l2.1 3.8-2.1 3.8" stroke="#fff" strokeWidth={1.9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>;
});
