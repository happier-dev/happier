import type { ScmWorkspaceIntegrationWorkspaceCheckoutKind } from './workspaceCheckoutCreation.js';

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest = Readonly<{
  kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
  sourcePath: string;
  targetPath: string;
  displayName: string;
  baseRef: string | null;
  branchMode: 'new' | 'existing';
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult = Readonly<{
  targetPath: string;
  branchName: string;
  created: boolean;
}>;

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationKind(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): ScmWorkspaceIntegrationWorkspaceCheckoutKind {
  return input.kind;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationSourcePath(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string {
  return input.sourcePath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationTargetPath(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string {
  return input.targetPath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationDisplayName(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string {
  return input.displayName;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBaseRef(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): string | null {
  return input.baseRef;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBranchMode(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
): 'new' | 'existing' {
  return input.branchMode;
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
): ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult {
  return {
    targetPath: input.targetPath,
    branchName: input.branchName,
    created: input.created,
  };
}
