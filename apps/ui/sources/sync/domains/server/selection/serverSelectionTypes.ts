export type ServerSelectionTargetKind = 'server' | 'group';

export type ServerSelectionPresentation = 'grouped' | 'flat-with-badge';

export type ServerSelectionGroup = Readonly<{
    id: string;
    name: string;
    serverIds: ReadonlyArray<string>;
    presentation?: ServerSelectionPresentation | null;
}>;

export type ServerSelectionServerTarget = Readonly<{
    kind: 'server';
    id: string;
    serverId: string;
    name: string;
    serverUrl: string;
}>;

export type ServerSelectionGroupTarget = Readonly<{
    kind: 'group';
    id: string;
    groupId: string;
    name: string;
    serverIds: string[];
    presentation: ServerSelectionPresentation;
}>;

export type ServerSelectionTarget = ServerSelectionServerTarget | ServerSelectionGroupTarget;

export type ActiveServerSelectionTarget = Readonly<
    | { kind: 'server'; id: string; serverId: string }
    | { kind: 'group'; id: string; groupId: string; serverIds: string[] }
>;

export type ServerSelectionSettingsLike = Readonly<{
    serverSelectionGroups?: ReadonlyArray<ServerSelectionGroup> | null;
    serverSelectionActiveTargetKind?: ServerSelectionTargetKind | null;
    serverSelectionActiveTargetId?: string | null;
}>;

export type ResolvedActiveServerSelection = Readonly<{
    activeTarget: ActiveServerSelectionTarget;
    activeServerId: string;
    allowedServerIds: string[];
    enabled: boolean;
    presentation: ServerSelectionPresentation;
    explicit: boolean;
}>;

export type EffectiveServerSelection = Readonly<{
    enabled: boolean;
    serverIds: string[];
    presentation: ServerSelectionPresentation;
}>;

export type NewSessionServerTargeting = Readonly<{
    allowedServerIds: string[];
    pickerEnabled: boolean;
}>;

export type ResolvedNewSessionServerTarget = Readonly<{
    targetServerId: string | null;
    rejectedRequestedServerId: string | null;
}>;
