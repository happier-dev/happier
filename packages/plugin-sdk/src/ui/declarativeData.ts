/** Finite declarative readers use the same grammar and data paths as the host. */
import { PluginDeclarativeNodeV2Schema as canonicalNodeSchema } from '@happier-dev/protocol/plugins/contributions/ui/v2';
import type { PluginDeclarativeNodeV2 } from '../manifest.js';
import type { ProtocolStoredReadSchema } from '../protocol/protocolFacade.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';

export const PluginDeclarativeNodeV2Schema: ProtocolStoredReadSchema<PluginDeclarativeNodeV2> = projectProtocolValue(canonicalNodeSchema);
export { readPluginDeclarativeDataFieldV1, readPluginDeclarativeDataRowsV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';

export type { PluginDeclarativeDataFieldV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1';
