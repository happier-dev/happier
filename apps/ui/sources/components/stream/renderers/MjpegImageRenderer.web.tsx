import * as React from 'react';

import { MjpegImageRenderer as SharedMjpegImageRenderer } from './MjpegImageRenderer.shared';

type MjpegImageRendererProps = React.ComponentProps<typeof SharedMjpegImageRenderer>;

function revokeObjectUrl(frameUrl: string): void {
    if (!frameUrl.startsWith('blob:')) return;
    const revokeObjectURL = globalThis.URL?.revokeObjectURL;
    if (typeof revokeObjectURL === 'function') {
        revokeObjectURL.call(globalThis.URL, frameUrl);
    }
}

export function MjpegImageRenderer(props: MjpegImageRendererProps): React.ReactElement {
    React.useEffect(() => {
        const frameUrl = props.frameUrl;
        return () => {
            revokeObjectUrl(frameUrl);
        };
    }, [props.frameUrl]);

    return <SharedMjpegImageRenderer {...props} />;
}
