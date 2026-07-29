import type {
  ConnectedServiceAuthGroupMemberStateV1,
  ConnectedServiceAuthGroupStateV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceAuthGroupRuntimeStatePatch = Readonly<{
  state?: ConnectedServiceAuthGroupStateV1;
  memberStates: ReadonlyArray<Readonly<{
    profileId: string;
    state: ConnectedServiceAuthGroupMemberStateV1;
  }>>;
}>;

type ConnectedServiceAuthGroupRuntimeStateVersion = Readonly<{
  generation: number;
  runtimeStateRevision: number;
}>;

function isRuntimeStateRevisionConflict(error: unknown): boolean {
  return error instanceof Error
    && error.message === 'connected_service_auth_group_runtime_state_revision_conflict';
}

export async function updateConnectedServiceAuthGroupRuntimeStateWithRetry<
  TServiceIdentity = ConnectedServiceId,
  TGroup extends ConnectedServiceAuthGroupRuntimeStateVersion =
    ConnectedServiceAuthGroupV1,
  TPatch extends Readonly<Record<string, unknown>> =
    ConnectedServiceAuthGroupRuntimeStatePatch,
>(params: Readonly<{
  serviceId: TServiceIdentity;
  groupId: string;
  expectedGeneration: number;
  loadGroup: () => Promise<TGroup | null>;
  buildPatch: (
    group: TGroup,
  ) => TPatch | null;
  update: (input: Readonly<{
    serviceId: TServiceIdentity;
    groupId: string;
    expectedGeneration: number;
    expectedRuntimeStateRevision: number;
  }> & TPatch) => Promise<TGroup>;
}>): Promise<TGroup | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const group = await params.loadGroup();
    if (!group || group.generation !== params.expectedGeneration) return null;
    const patch = params.buildPatch(group);
    if (!patch) return group;
    try {
      return await params.update({
        serviceId: params.serviceId,
        groupId: params.groupId,
        expectedGeneration: params.expectedGeneration,
        expectedRuntimeStateRevision: group.runtimeStateRevision,
        ...patch,
      });
    } catch (error) {
      if (attempt > 0 || !isRuntimeStateRevisionConflict(error)) throw error;
    }
  }
  return null;
}
