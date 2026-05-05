import * as React from 'react';

export function EnrichedMarkdownText(props: Record<string, unknown>) {
    return React.createElement(
        'EnrichedMarkdownText',
        props,
        typeof props.markdown === 'string' ? props.markdown : null,
    );
}
