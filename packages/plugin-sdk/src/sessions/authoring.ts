import type { SessionSpawnNewInputV2 as ProtocolSessionSpawnNewInputV2, SessionServerStartSpawnDraftV1 as ProtocolSessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

export type ProjectKeyV1 =
    | Readonly<{ id: string; serverId?: string }>
    | Readonly<{ serverId: string; machineId: string; rootPath: string }>
    | Readonly<{ serverId: string; projectKey: string }>;

/**
 * Session-create Action operands. ActionsService.execute and UI executeAction
 * return creation settlements, but reject host admission failures with
 * PluginError. target_unavailable is a pre-creation refusal; an unclassified
 * exception remains an unknown outcome and must retain this creationKey.
 */
export type SessionSpawnNewInputV2 = ProtocolSessionSpawnNewInputV2;
/** Retained no-invoke recipes use the canonical creation draft, not Action operands. */
export type SessionServerStartSpawnDraftV1 = ProtocolSessionServerStartSpawnDraftV1;
