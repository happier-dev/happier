import {
    LaunchProfileIdV2ProtocolSchema,
} from '@happier-dev/protocol/profiles/v2/profileId';

import type { ProtocolComposableSchema } from './protocolFacade.js';

/** Launch Profile references delegate admission and normalization to the profile owner. */
export const ProtocolLaunchProfileIdV2Schema: ProtocolComposableSchema<string> =
    LaunchProfileIdV2ProtocolSchema;
