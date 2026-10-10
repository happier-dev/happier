import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

export const SessionHandoffStorageModeSchema = lazyZodSchema(() => z.enum(['direct', 'persisted']));
export type SessionHandoffStorageMode = z.infer<typeof SessionHandoffStorageModeSchema>;

export const SessionHandoffStateTransferSchema = lazyZodSchema(() => z.enum(['transfer', 'existing']));
export type SessionHandoffStateTransfer = z.infer<typeof SessionHandoffStateTransferSchema>;

export const SessionHandoffTransportStrategySchema = lazyZodSchema(() => z.enum(['direct_peer', 'server_routed_stream']));
export type SessionHandoffTransportStrategy = z.infer<typeof SessionHandoffTransportStrategySchema>;

export const SessionHandoffRecoveryActionSchema = lazyZodSchema(() => z.enum(['restart_on_source', 'keep_stopped']));
export type SessionHandoffRecoveryAction = z.infer<typeof SessionHandoffRecoveryActionSchema>;
