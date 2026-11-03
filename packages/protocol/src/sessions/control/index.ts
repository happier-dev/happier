export * from './runtimeIssueV1.js';
export * from './sessionRunnerRestartV1.js';
export * from './sessionRunnerRestartV2.js';
export * from './sessionRunnerRuntimeV1.js';
export * from './sessionRunnerRuntimeV2.js';
export * from './checkpoints/index.js';
export * from './terminalComposerClearV1.js';
export * from './pendingInputInterruptAndRunV1.js';
export * from './exactTurnCancellationV1.js';
export * from './machineSessionTerminalV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** The scoped RPC route supplies the target Session. */
export const SessionCompactRequestV1Schema = lazyZodSchema(() => z.strictObject({
  instructions: z.optional(z.string().check(z.trim())),
}));
export type SessionCompactRequestV1 = z.infer<typeof SessionCompactRequestV1Schema>;

/** Admission to the live host queue does not imply native completion. */
export const SessionCompactResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['admitted', 'already_pending', 'unsupported']),
}));
export type SessionCompactResultV1 = z.infer<typeof SessionCompactResultV1Schema>;
