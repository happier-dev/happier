import { SessionMessageSendResultV1ProtocolSchema as canonicalResult } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';

/** Admission, holds, uncertainty, terminal replies and fanout retain their original meaning; parsed output is strict transport JSON. */
export const SessionMessageSendResultV1ProtocolSchema: ProtocolComposableSchema<
    PluginActionResultById['session.message.send'],
    PluginActionResultById['session.message.send'] & ProtocolJsonValue
> = canonicalResult;
