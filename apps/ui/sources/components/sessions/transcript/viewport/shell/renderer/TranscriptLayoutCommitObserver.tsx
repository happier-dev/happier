import * as React from 'react';

export const TranscriptLayoutCommitObserver = React.memo(function TranscriptLayoutCommitObserver(
    props: Readonly<{
        children: React.ReactNode;
        onCommitLayoutEffect: () => void;
    }>,
) {
    React.useLayoutEffect(() => {
        props.onCommitLayoutEffect();
    });

    return <>{props.children}</>;
});
