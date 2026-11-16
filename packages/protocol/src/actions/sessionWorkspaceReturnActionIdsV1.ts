export const SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1 = 'session.workspace.return.prepare';
export const SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1 = 'session.workspace.return.apply';
export const SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1 = 'session.workspace.return.capture';
export const SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1 = { action: SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1, role: 'session_workspace_return_capture' } as const;
export const SESSION_WORKSPACE_RETURN_WRITE_SCOPED_ACTION_IDS_V1 = [SESSION_WORKSPACE_RETURN_PREPARE_ACTION_ID_V1, SESSION_WORKSPACE_RETURN_APPLY_ACTION_ID_V1] as const;
export const SESSION_WORKSPACE_RETURN_ACTION_IDS_V1 = [...SESSION_WORKSPACE_RETURN_WRITE_SCOPED_ACTION_IDS_V1, SESSION_WORKSPACE_RETURN_CAPTURE_ACTION_ID_V1] as const;
export function isSessionWorkspaceReturnActionIdV1(value: string): value is typeof SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[number] {
  return (SESSION_WORKSPACE_RETURN_ACTION_IDS_V1 as readonly string[]).includes(value);
}
