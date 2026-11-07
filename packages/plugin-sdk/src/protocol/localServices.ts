import { LocalServiceLauncherSnapshotV1ProtocolSchema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** Live exact-Machine targets remain owned by the incumbent Local Services Action. */
export const ProtocolLocalServiceLauncherSnapshotV1Schema: ProtocolComposableSchema<
    PluginActionResultById['localServices.launcher.snapshot']
> = LocalServiceLauncherSnapshotV1ProtocolSchema;
