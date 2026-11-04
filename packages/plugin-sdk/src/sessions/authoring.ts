export type { SessionSpawnNewInputV2, SessionServerStartSpawnDraftV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';

export type ProjectKeyV1 =
    | Readonly<{ id: string; serverId?: string }>
    | Readonly<{ serverId: string; machineId: string; rootPath: string }>
    | Readonly<{ serverId: string; projectKey: string }>;
