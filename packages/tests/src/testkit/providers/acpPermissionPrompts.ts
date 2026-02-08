import type { AcpPermissionMode, ProviderUnderTest } from './types';

type AcpPermissions = NonNullable<NonNullable<ProviderUnderTest['permissions']>['acp']>;

export function resolveAcpToolPermissionPromptExpectation(params: {
  acpPermissions: AcpPermissions | undefined;
  mode: AcpPermissionMode;
}): boolean {
  const matrix = params.acpPermissions?.toolPermissionPromptsByMode;
  if (matrix) {
    const exact = matrix[params.mode];
    if (typeof exact === 'boolean') return exact;
    if (params.mode === 'plan') {
      const readOnly = matrix['read-only'];
      if (typeof readOnly === 'boolean') return readOnly;
    }
  }

  const legacy = params.acpPermissions?.expectToolPermissionPrompts;
  if (typeof legacy === 'boolean') {
    if (params.mode === 'yolo') return false;
    return legacy;
  }

  return params.mode !== 'yolo';
}

export function decisionForPermissionMode(mode: AcpPermissionMode): 'approve' | 'deny' {
  if (mode === 'read-only' || mode === 'plan') return 'deny';
  return 'approve';
}

export function yoloFlagForPermissionMode(mode: AcpPermissionMode): boolean {
  return mode === 'yolo';
}

export function resolveAcpOutsideWorkspaceWriteAllowed(params: {
  acpPermissions: AcpPermissions | undefined;
  mode: AcpPermissionMode;
}): boolean {
  const matrix = params.acpPermissions?.outsideWorkspaceWriteAllowedByMode;
  if (matrix) {
    const exact = matrix[params.mode];
    if (typeof exact === 'boolean') return exact;
    if (params.mode === 'plan') {
      const readOnly = matrix['read-only'];
      if (typeof readOnly === 'boolean') return readOnly;
    }
  }

  return decisionForPermissionMode(params.mode) === 'approve';
}

export function resolveAcpOutsideWorkspaceWriteMustComplete(params: {
  acpPermissions: AcpPermissions | undefined;
  mode: AcpPermissionMode;
}): boolean {
  const matrix = params.acpPermissions?.outsideWorkspaceWriteMustCompleteByMode;
  if (matrix) {
    const exact = matrix[params.mode];
    if (typeof exact === 'boolean') return exact;
    if (params.mode === 'plan') {
      const readOnly = matrix['read-only'];
      if (typeof readOnly === 'boolean') return readOnly;
    }
  }

  return resolveAcpOutsideWorkspaceWriteAllowed(params);
}

export function resolveAcpOutsideWorkspaceRequireTaskComplete(params: {
  acpPermissions: AcpPermissions | undefined;
  mode: AcpPermissionMode;
}): boolean {
  const matrix = params.acpPermissions?.outsideWorkspaceRequireTaskCompleteByMode;
  if (matrix) {
    const exact = matrix[params.mode];
    if (typeof exact === 'boolean') return exact;
    if (params.mode === 'plan') {
      const readOnly = matrix['read-only'];
      if (typeof readOnly === 'boolean') return readOnly;
    }
  }

  return true;
}
