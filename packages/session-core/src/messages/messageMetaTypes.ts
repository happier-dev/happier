import { z } from 'zod';
import { createSessionMessageMetaSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

const CanonicalMessageMetaSchema = createSessionMessageMetaSchema(z);

// Shared message metadata schema
export const MessageMetaSchema = createStoredReadSchema(CanonicalMessageMetaSchema);

export type MessageMeta = z.infer<typeof MessageMetaSchema>;
