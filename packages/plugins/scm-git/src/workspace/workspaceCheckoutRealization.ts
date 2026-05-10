import type { ScmWorkspaceIntegrationWorkspaceCheckoutKind } from './workspaceCheckoutCreation.js';

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest = Readonly<{
  kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
  sourcePath: string;
  displayName: string;
  baseRef: string | null;
  targetPath: string | null;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult = Readonly<{
  kind: ScmWorkspaceIntegrationWorkspaceCheckoutKind;
  targetPath: string;
}>;

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationKind(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): ScmWorkspaceIntegrationWorkspaceCheckoutKind {
  return input.kind;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationSourcePath(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string {
  return input.sourcePath;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string {
  return input.displayName;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string | null {
  return input.baseRef;
}

export function resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
): string | null {
  return input.targetPath;
}

export function createScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult(
  input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
): ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult {
  return {
    kind: input.kind,
    targetPath: input.targetPath,
  };
}
