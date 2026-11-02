import { PluginSessionInputAttachmentsV1ProtocolSchema as canonicalAttachments } from '@happier-dev/protocol/sessions/messages/sessionInputAuthoringV1';
import type { PluginActionInputById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';

/** Exact Session-input authoring boundary, including its existing value and count budgets. */
export const PluginSessionInputAttachmentsV1ProtocolSchema: ProtocolComposableSchema<
    NonNullable<Extract<PluginActionInputById['session.message.send'], { message: string }>['attachments']>,
    NonNullable<Extract<PluginActionInputById['session.message.send'], { message: string }>['attachments']> & ProtocolJsonValue
> = canonicalAttachments;
