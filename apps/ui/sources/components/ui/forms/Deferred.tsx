import * as React from 'react';

export const Deferred = React.memo((props: {
    children: React.ReactNode;
    enabled?: boolean;
    fallback?: React.ReactNode;
}) => {
    const [enabled, setEnabled] = React.useState(props.enabled ?? false);

    React.useEffect(() => {
        if (props.enabled === true) {
            setEnabled(true);
            return;
        }

        const timeout = setTimeout(() => {
            setEnabled(true);
        }, 10);
        return () => clearTimeout(timeout);
    }, [props.enabled]);

    return (
        <React.Fragment>
            {enabled ? props.children : (props.fallback ?? null)}
        </React.Fragment>
    )
});
