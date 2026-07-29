import { z } from 'zod';

export const ExternalSessionsRpcErrorCodeSchema = z.enum([
  'invalid_request',
  'machine_offline',
  'agent_unavailable',
  'internal_error',
]);
export type ExternalSessionsRpcErrorCode = z.infer<typeof ExternalSessionsRpcErrorCodeSchema>;
