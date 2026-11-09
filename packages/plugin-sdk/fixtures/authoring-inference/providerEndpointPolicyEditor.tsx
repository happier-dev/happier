import { EndpointHeadersEditor, type EndpointHeadersEditorCopy } from '@happier-dev/plugin-ui';
import type {
  ProviderConnectionsDescribeResult,
  ProviderEndpointTemplateV1,
} from '@happier-dev/plugin-sdk/providers';

type Endpoint = Extract<ProviderConnectionsDescribeResult, { status: 'success' }>['connections'][number]['endpoints'][number];
type Hint = NonNullable<ProviderEndpointTemplateV1['publicHeaderHints']>[string];

// The host supplies its admitted description and localized copy. Save through
// providers.connections.endpoint.set; null removes this layer's header map.
export function ExampleEndpointPolicyEditor(props: Readonly<{
  endpoint: Endpoint;
  copy: EndpointHeadersEditorCopy;
  localize: (hint: Hint) => string;
  onChange: (publicHeaders: Record<string, string> | null) => void;
}>) {
  const { endpoint } = props;
  return (
    <EndpointHeadersEditor
      testID="example.gateway.policy"
      layer="machine"
      values={endpoint.machineOverridePublicHeaders}
      inherited={{ ...endpoint.defaultPublicHeaders, ...endpoint.accountOverridePublicHeaders }}
      required={endpoint.requiredPublicHeaders}
      hints={Object.fromEntries(Object.entries(endpoint.publicHeaderHints ?? {})
        .map(([name, hint]) => [name, props.localize(hint)]))}
      copy={props.copy}
      onChange={props.onChange}
    />
  );
}
