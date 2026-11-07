import * as React from 'react';
import { isPluginError, projectPluginFailureText } from '@happier-dev/plugin-sdk';
import { Action, ErrorState, type PluginUiResourceError } from '@happier-dev/plugin-ui';
import type { Translate } from './conversationRows.js';

/** Presentation only: the host already decided admission and the refusal reason. */
export type ProviderSelectionRefusal = Readonly<{
  kind: 'stale' | 'invalid' | 'unavailable';
  error?: PluginUiResourceError;
}>;

export function providerSelectionRefusal(error: unknown): ProviderSelectionRefusal {
  if (!isPluginError(error)) {
    return { kind: 'unavailable', ...(error instanceof Error ? { error: { message: projectPluginFailureText(error) } } : {}) };
  }
  const diagnostics = error.diagnostics?.map((diagnostic) => diagnostic.code);
  return {
    kind: error.code === 'stale_surface'
      || diagnostics?.some((code) => code === 'action_retired' || code === 'host_retired')
      ? 'stale' : error.code === 'invalid_payload' ? 'invalid' : 'unavailable',
    error: { code: error.code, message: error.message, ...(diagnostics === undefined ? {} : { diagnostics }) },
  };
}

export function hostRefusalDescription(error: PluginUiResourceError | undefined, fallback: string): string {
  return error?.message.trim() && error.message !== error.code
    ? projectPluginFailureText(new Error(error.message)) : fallback;
}

export function hostRefusalDetails(error: PluginUiResourceError | undefined): string | undefined {
  const codes = [error?.code, ...error?.diagnostics ?? []].filter((code) => code !== undefined);
  return codes.length === 0 ? undefined : projectPluginFailureText(new Error([...new Set(codes)].join(' · ')));
}

export function ProviderSelectionRefusalState(props: Readonly<{
  refusal: ProviderSelectionRefusal;
  testIDPrefix: string;
  title: string;
  staleDescription: string;
  onRetry: () => unknown;
  onRefresh: () => void;
  t: Translate;
}>): React.ReactElement {
  const stale = props.refusal.kind === 'stale';
  const fallback = props.refusal.kind === 'invalid'
    ? props.t('plugins.channels.surface.providerSelectionInvalidDescription', 'Happier couldn’t use this provider’s setup. Try again, or open Details to see why.')
    : props.t('happier.plugin-ui.action.error.unavailable', 'This isn’t available right now. Try again in a moment.');
  return (
    <ErrorState
      testID={`${props.testIDPrefix}-${props.refusal.kind}`}
      size="details"
      accessibilitySemantics="alert"
      kind={props.refusal.kind === 'invalid' ? 'error' : 'unavailable'}
      title={props.title}
      description={stale ? props.staleDescription : hostRefusalDescription(props.refusal.error, fallback)}
      details={hostRefusalDetails(props.refusal.error)}
      {...(stale ? { action: <Action.Refresh title={props.t('plugins.channels.surface.refresh', 'Refresh')} onRefresh={props.onRefresh} /> }
        : { onRetry: props.onRetry })}
    />
  );
}
