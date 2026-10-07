import { z } from 'zod';

import { AIBackendProfileSchema as ProtocolAIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';

export const AIBackendProfileSchema = ProtocolAIBackendProfileSchema;

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;
