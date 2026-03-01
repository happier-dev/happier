export type PermissionToolCallMessageLocation =
    | Readonly<{ kind: 'top'; messageId: string; seq: number | null }>
    | Readonly<{ kind: 'nested'; parentMessageId: string; messageId: string; seq: number | null }>;
