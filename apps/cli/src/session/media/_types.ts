export type SessionMediaIngestionSource =
  | Readonly<{
      kind: 'base64';
      data: string;
      mimeType: string;
      fileNameHint?: string;
    }>
  | Readonly<{
      kind: 'local-file';
      path: string;
      mimeType?: string;
      fileNameHint?: string;
    }>
  | Readonly<{
      kind: 'local-uri';
      uri: string;
      mimeType?: string;
      fileNameHint?: string;
    }>
  | Readonly<{
      kind: 'provider-file';
      providerFileId: string;
      mimeType?: string;
      fileNameHint?: string;
    }>;

export type SessionMediaOrigin = Readonly<{
  source: 'user-upload' | 'provider-generated' | 'tool-output' | 'acp-content' | 'mcp-content' | 'local-file';
  agentId?: string;
  toolCallId?: string;
  generationId?: string;
  providerEventId?: string;
  providerFileId?: string;
}>;

export type SessionMediaItemV1 = Readonly<{
  id: string;
  role: 'input' | 'output';
  category: 'attachment' | 'generated' | 'tool-artifact';
  mediaKind: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  name: string;
  path: string;
  sizeBytes: number;
  sha256?: string;
  width?: number;
  height?: number;
  createdAtMs?: number;
  origin: SessionMediaOrigin;
}>;
