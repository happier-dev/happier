import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import type { DatabaseTargetV1 } from '@happier-dev/plugin-sdk/database';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';

/** Launch inputs, cached targets and resource operands share an order-independent identity. */
export function workbenchTargetKey(target: DatabaseTargetV1): string {
    return createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(target));
}
