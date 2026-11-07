import { ComposerAttachmentAuthorValueV1ProtocolSchema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import type { ComposerAttachmentAuthorValueV1 } from '../ui/publicContract.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** Exact author admission, including the composer owner's serialized value budget. */
export const ProtocolComposerAttachmentAuthorValueV1Schema: ProtocolComposableSchema<ComposerAttachmentAuthorValueV1> = ComposerAttachmentAuthorValueV1ProtocolSchema;
