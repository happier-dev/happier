import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { z } from 'zod/mini';

const id = z.string().check(z.minLength(1));
const count = z.number().check(z.int(), z.nonnegative());

/** Operands identify a source; only its existing target owner can admit it and select a partition. */
export const DatabaseCaptureProjectV1Schema = z.strictObject({ serverId: id, machineId: id, projectId: id });
export const DatabaseCaptureSourceV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('worktree'), ...DatabaseCaptureProjectV1Schema.shape, workspaceId: id }),
    z.strictObject({ kind: z.literal('environment'), serverId: id, environmentId: id }),
]);
export const DatabaseCaptureCoverageV1Schema = z.strictObject({ lostObservations: count, reason: z.nullable(z.string()) });

export const DatabaseCaptureProjectV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureProjectV1Schema);

export const DatabaseCaptureSourceV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureSourceV1Schema);

export const DatabaseCaptureCoverageV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureCoverageV1Schema);
