import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

/** WebKit requires the platform write in the click stack; web has no native Action approval. */
export function useClipboardWrite(
    _scope?: ServerAccountScope | string | null,
    _options?: Readonly<{ enabled?: boolean }>,
) {
    return React.useCallback(async (text: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<boolean> => {
        if (options?.signal?.aborted) return false;
        return setClipboardStringSafe(text);
    }, []);
}
