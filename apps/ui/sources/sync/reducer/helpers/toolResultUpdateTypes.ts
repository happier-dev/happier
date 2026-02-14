export type ToolResultPermissionsUpdate = {
  date: number;
  result: 'approved' | 'denied';
  mode?: string;
  allowedTools?: string[];
  decision?:
    | 'approved'
    | 'approved_for_session'
    | 'approved_execpolicy_amendment'
    | 'denied'
    | 'abort';
};

export type ToolResultUpdate = {
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
  permissions?: ToolResultPermissionsUpdate;
};

