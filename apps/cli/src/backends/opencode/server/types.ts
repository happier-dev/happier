export type OpenCodeGlobalEvent = Readonly<{
  directory: string;
  payload: Readonly<{
    type: string;
    properties: unknown;
  }>;
}>;

export type OpenCodeSession = Readonly<{
  id: string;
}>;

export type OpenCodeModelRef = Readonly<{
  providerID: string;
  modelID: string;
}>;

export type OpenCodeQuestionRequest = Readonly<{
  id: string;
  sessionID: string;
  questions: ReadonlyArray<unknown>;
  tool?: Readonly<{ messageID: string; callID: string }>;
}>;

export type OpenCodePermissionRequest = Readonly<{
  id: string;
  sessionID: string;
  permission: string;
  patterns: ReadonlyArray<string>;
  metadata: Record<string, unknown>;
  always: ReadonlyArray<string>;
  tool?: Readonly<{ messageID: string; callID: string }>;
}>;
