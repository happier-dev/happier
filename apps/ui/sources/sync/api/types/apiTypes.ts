import { z } from 'zod';
import { ChangeEntrySchema, ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { EphemeralUpdateSchema, type EphemeralUpdate, UpdateBodySchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';

//
// /v2/changes
//

export const ApiChangeEntrySchema = ChangeEntrySchema;
export type ApiChangeEntry = z.infer<typeof ApiChangeEntrySchema>;

export const ApiChangesResponseSchema = ChangesResponseSchema;
export type ApiChangesResponse = z.infer<typeof ApiChangesResponseSchema>;

//
// Updates
//

export const ApiUpdateSchema: typeof UpdateBodySchema = UpdateBodySchema;
export type ApiUpdate = z.infer<typeof ApiUpdateSchema>;

//
// API update container
//

export const ApiUpdateContainerSchema: typeof UpdateContainerSchema = UpdateContainerSchema;
export type ApiUpdateContainer = z.infer<typeof ApiUpdateContainerSchema>;

//
// Ephemeral update
//

export const ApiEphemeralUpdateSchema = EphemeralUpdateSchema;
export type ApiEphemeralUpdate = EphemeralUpdate;
export type ApiEphemeralActivityUpdate = Extract<ApiEphemeralUpdate, { type: 'activity' }>;

// Machine metadata updates use Partial<MachineMetadata> from storageTypes
// This matches how session metadata updates work
