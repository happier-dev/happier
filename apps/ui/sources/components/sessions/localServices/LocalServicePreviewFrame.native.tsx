import * as React from 'react';

import { LocalPreviewTarget } from '@/components/browser/adapters/LocalPreviewTarget.native';

export function LocalServicePreviewFrame(props: Readonly<{
    title: string;
    url: string;
    testID: string;
}>): React.ReactElement {
    return (
        <LocalPreviewTarget
            title={props.title}
            url={props.url}
            testID={props.testID}
        />
    );
}
