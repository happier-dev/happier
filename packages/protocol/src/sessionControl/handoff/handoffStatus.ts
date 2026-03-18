import { z } from 'zod';

import {
  SessionHandoffRecoveryActionSchema,
  SessionHandoffTransportStrategySchema,
} from './handoffTypes.js';

export const SessionHandoffPhaseSchema = z.enum([
  'preparing',
  'negotiating_transport',
  'staging_target',
  'cutover',
  'transferring',
  'importing',
  'resuming',
  'finalizing',
]);
export type SessionHandoffPhase = z.infer<typeof SessionHandoffPhaseSchema>;

export const SessionHandoffStatusCodeSchema = z.enum([
  'pending',
  'ready_for_cutover',
  'in_progress',
  'awaiting_recovery',
  'completed',
  'aborted',
  'failed',
]);
export type SessionHandoffStatusCode = z.infer<typeof SessionHandoffStatusCodeSchema>;

export const SessionHandoffStatusSchema = z
  .object({
    handoffId: z.string().min(1),
    status: SessionHandoffStatusCodeSchema,
    phase: SessionHandoffPhaseSchema,
    transportStrategy: SessionHandoffTransportStrategySchema.nullable().optional(),
    recoveryActions: z.array(SessionHandoffRecoveryActionSchema).default([]),
  })
  .strict();
export type SessionHandoffStatus = z.infer<typeof SessionHandoffStatusSchema>;
