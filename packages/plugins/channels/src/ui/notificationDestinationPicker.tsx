import * as React from 'react';
import { parseQualifiedPluginContributionKey } from '@happier-dev/plugin-sdk';
import { readInputTypePickerLaunchInput } from '@happier-dev/plugin-sdk/actions';
import type { RenderContext, SelectActionInputRequest } from '@happier-dev/plugin-sdk/ui';
import {
  Button, ErrorState, Heading, LoadingState, Stack, Text,
  useExecutePluginAction, useLivePluginResource, usePluginHostApi, usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  ConversationNotificationDestinationSetupResultV1Schema,
  NOTIFICATION_DESTINATION_INPUT_TYPE_V1, NotificationDestinationSelectionV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { CHANNELS_CONNECTIONS_RESOURCE, connectionLabel, parseConnectionsResource, type ChannelsConnection } from './conversationRows.js';
import { hostRefusalDescription, hostRefusalDetails, providerSelectionRefusal, type ProviderSelectionRefusal } from './hostRefusal.js';

type ProviderOperation = Extract<SelectActionInputRequest, Readonly<{ operation: unknown }>>['operation'];
type Selection = ReturnType<typeof NotificationDestinationSelectionV1Schema.parse>;

function ConnectionDestinations(props: Readonly<{
  connection: ChannelsConnection; operation: ProviderOperation; selection: Selection; signal: AbortSignal;
}>): React.ReactElement {
  const host = usePluginHostApi();
  const t = usePluginTranslation();
  const action = useExecutePluginAction(props.operation.action);
  const [refusal, setRefusal] = React.useState<ProviderSelectionRefusal | null>(null);
  const resolve = async () => {
    setRefusal(null);
    try {
      const selected = await host.selectActionInput({ operation: props.operation,
        draft: { connectionId: props.connection.connectionId } }, { signal: props.signal });
      if (selected.kind !== 'submitted' || props.signal.aborted) return;
      await action.execute(selected.input, { signal: props.signal,
        selectedActionInput: { operation: props.operation, result: selected } });
    } catch (error) {
      if (!props.signal.aborted) setRefusal(providerSelectionRefusal(error));
    }
  };
  const result = action.execution.status === 'success'
    ? ConversationNotificationDestinationSetupResultV1Schema.safeParse(action.execution.result) : null;
  return <Stack>
    <Button title={connectionLabel(props.connection)}
      disabled={action.execution.status === 'pending'} onPress={resolve} />
    {refusal === null ? null : <ErrorState kind="unavailable"
      title={t('plugins.channels.surface.destinationUnavailable', 'Destinations could not be loaded')}
      description={hostRefusalDescription(refusal.error, t('plugins.channels.surface.destinationRetry', 'Choose the connection again to retry.'))}
      details={hostRefusalDetails(refusal.error)} onRetry={resolve} />}
    {action.execution.status === 'error' || action.execution.status === 'outcomeUnknown'
      ? <ErrorState kind="unavailable" title={t('plugins.channels.surface.destinationUnavailable', 'Destinations could not be loaded')}
        description={action.execution.message} /> : null}
    {result !== null && !result.success ? <ErrorState kind="error"
      title={t('plugins.channels.surface.destinationInvalid', 'The provider returned an unusable destination')} /> : null}
    {result?.success && result.data.kind === 'unavailable'
      ? <ErrorState kind="unavailable" title={t('plugins.channels.surface.destinationUnavailable', 'Destinations could not be loaded')}
        description={result.data.reason} /> : null}
    {result?.success && result.data.kind === 'resolved' ? result.data.destinations.length === 0
      ? <Text value={t('plugins.channels.surface.destinationEmpty', 'No matching conversations were found. Choose the connection again to search.')} />
      : result.data.destinations.map((destination) => <Button key={JSON.stringify(destination)}
        title={destination.endpoint.label ?? destination.endpoint.id}
        onPress={() => host.settleEphemeralInput({ kind: 'completed',
          input: { channelId: props.selection.channelId, destination } }, { signal: props.signal })} />) : null}
  </Stack>;
}

function ProviderDestinations(props: Readonly<{
  operations: readonly ProviderOperation[]; selection: Selection; signal: AbortSignal;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const { resource } = useLivePluginResource(CHANNELS_CONNECTIONS_RESOURCE);
  const parsed = resource.value === undefined ? null : parseConnectionsResource(resource.value);
  if (resource.error !== undefined) return <ErrorState kind="unavailable"
    title={t('plugins.channels.surface.connectionsUnavailable', 'Connections could not be loaded')}
    description={resource.error.message} />;
  if (parsed === null) return <LoadingState title={t('plugins.channels.surface.loadingConnections', 'Loading connections')} />;
  if (parsed.kind === 'invalid') return <ErrorState kind="error"
    title={t('plugins.channels.surface.connectionsInvalid', 'Connections could not be read')} />;
  const connections = parsed.connections.filter((connection) => connection.enabled && connection.deletionState === 'none');
  const choices = props.operations.flatMap((operation) => connections
    .filter((connection) => connection.providerPluginId === operation.contributor.pluginId)
    .map((connection) => <ConnectionDestinations key={JSON.stringify([operation, connection.connectionId])}
      operation={operation} connection={connection} selection={props.selection} signal={props.signal} />));
  return choices.length === 0
    ? <Text value={t('plugins.channels.surface.destinationNeedsConnection', 'Connect this provider in Channels settings, then reopen this picker.')} />
    : <Stack>{choices}</Stack>;
}

/** A finite Channels-owned selection. Choosing only returns addressing to the caller's draft. */
export function NotificationDestinationPicker(props: Readonly<{
  context: RenderContext; operations: readonly ProviderOperation[];
}>): React.ReactElement {
  const host = usePluginHostApi();
  const t = usePluginTranslation();
  const launch = readInputTypePickerLaunchInput(props.context.launchInput);
  const parsed = launch?.inputType.pluginId === NOTIFICATION_DESTINATION_INPUT_TYPE_V1.pluginId
    && launch.inputType.localId === NOTIFICATION_DESTINATION_INPUT_TYPE_V1.localId
    ? NotificationDestinationSelectionV1Schema.safeParse(launch.value) : null;
  const selection = parsed?.success ? parsed.data : null;
  const provider = selection === null ? null : parseQualifiedPluginContributionKey(selection.channelId);
  const operations = props.operations.filter((operation) => operation.contributor.pluginId === provider?.pluginId);
  return <Stack>
    <Heading level={1} value={t('plugins.channels.surface.alertDestination', 'Alert destination')} />
    {selection === null ? <Text value={t('plugins.channels.surface.destinationReopen', 'Reopen the destination picker from your alert settings.')} />
      : operations.length === 0 ? <Button title={t('plugins.channels.surface.useChannel', 'Use channel')}
        onPress={() => host.settleEphemeralInput({ kind: 'completed', input: selection }, { signal: props.context.signal })} />
        : <ProviderDestinations operations={operations} selection={selection} signal={props.context.signal} />}
    <Button title={t('plugins.channels.surface.cancel', 'Cancel')} variant="secondary"
      onPress={() => host.settleEphemeralInput({ kind: 'cancelled' }, { signal: props.context.signal })} />
  </Stack>;
}
