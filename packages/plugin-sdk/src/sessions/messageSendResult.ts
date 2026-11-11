import { SessionMessageSendResultV1ProtocolSchema as canonicalResult } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ProtocolComposableSchema, ProtocolSchemaInput, ProtocolSchemaOutput } from '../protocol/protocolFacade.js';

/** Admission, holds, uncertainty, terminal replies and fanout retain their original meaning; parsed output is strict transport JSON. */
export const SessionMessageSendResultV1ProtocolSchema: ProtocolComposableSchema<
    ProtocolSchemaInput<typeof canonicalResult>,
    ProtocolSchemaOutput<typeof canonicalResult>
> = canonicalResult;
