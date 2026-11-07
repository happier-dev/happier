import * as React from 'react';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectNativeRefV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { t } from '@/text';
import { describeProjectCommandSource, findProjectInvocation } from './projectScriptPresentation';
import { useProjectDefinitionInspection } from './useProjectDefinitionInspection';

/** Additional editor/row demand uses the same checkout, credential and inspection owner as Scripts. */
export function useProjectDefinitionDemand(
  workspace: WorkspaceAddressV1 | null,
  accountId: string | null,
  selection: ProjectDefinitionInspectRead,
  enabled: boolean,
) {
  const { binding: captured, resolution } = useServerCredentialAccountScopeBinding(workspace?.serverId);
  const binding = captured?.accountId === accountId && captured.isCurrent() ? captured : null;
  const inspection = useProjectDefinitionInspection(enabled ? workspace : null, enabled ? binding : null, selection);
  const scopeError = !workspace || !accountId || (resolution.kind === 'bound' && resolution.scope.accountId !== accountId)
    ? 'not_authenticated' : resolution.kind === 'bound' ? binding ? null : 'unavailable'
      : resolution.kind === 'resolving' ? null : resolution.kind;
  const retry = React.useCallback(() => {
    if (resolution.kind === 'unavailable' && workspace) retryServerCredentialAccountScope(workspace.serverId);
    else inspection.retry();
  }, [inspection.retry, resolution.kind, workspace]);
  return { ...inspection, retry, scopeError };
}

/** Mounted only by an opened native row; a preview never controls Run admission. */
export function ProjectNativeInvocationDetail(props: Readonly<{
  workspace: WorkspaceAddressV1;
  accountId: string | null;
  source: ProjectNativeRefV1;
  usage: 'script' | 'service' | 'setup';
  testID: string;
}>) {
  const selection = React.useMemo<ProjectDefinitionInspectRead>(() => ({
    kind: 'detail', sources: [{ source: props.source, usage: props.usage }],
  }), [props.source, props.usage]);
  const { read, retry, scopeError } = useProjectDefinitionDemand(props.workspace, props.accountId, selection, true);
  if (scopeError) return <SurfaceStateCard size="line" kind="unavailable"
    title={t('projects.widgets.scriptsUnavailable')} diagnosticCode={scopeError}
    action={scopeError === 'unavailable' ? { label: t('common.retry'), onPress: retry } : undefined} testID={props.testID} />;
  if (!read) return <SurfaceStateCard size="line" kind="loading"
    title={t('projects.scripts.definition.inspecting')} testID={props.testID} />;
  if (!('value' in read) || read.error) return <SurfaceStateCard size="line" kind="unavailable"
    title={t('projects.widgets.scriptsUnavailable')} diagnosticCode={read.error}
    action={{ label: t('common.retry'), onPress: retry }} testID={props.testID} />;
  const invocation = findProjectInvocation(read.value, props.source);
  if (!invocation) return <SurfaceStateCard size="line" kind="unavailable"
    title={t('projects.widgets.scriptsUnavailable')}
    diagnosticCode={read.value.importCandidates[0]?.code}
    action={{ label: t('common.retry'), onPress: retry }} testID={props.testID} />;
  return <Item testID={props.testID} mode="info" showChevron={false}
    title={t('projects.scripts.editor.command')}
    subtitle={describeProjectCommandSource(props.source, invocation).command ?? undefined} subtitleLines={0} />;
}
