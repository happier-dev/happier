import React from 'react';

export function EnrichedMarkdownText(props: Record<string, unknown>) {
    return React.createElement('EnrichedMarkdownText', props, props.markdown as React.ReactNode);
}

export default EnrichedMarkdownText;
