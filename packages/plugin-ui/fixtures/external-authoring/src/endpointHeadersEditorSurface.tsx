import { useState } from 'react';
import { EndpointHeadersEditor, ItemGroup, Text } from '@happier-dev/plugin-ui/components';

const PROVIDER_DEFAULTS = { 'x-collect-log': 'false', 'x-cache-ttl': '0' } as const;

/**
 * A controlled public-header layer: the author keeps the layer's own entries and saves them; Happier draws
 * the editor. Values are public request policy (logging, caching), never credentials.
 */
export function EndpointHeadersEditorExample() {
  const [layer, setLayer] = useState<Record<string, string> | null>({ 'x-cache-ttl': '600' });
  return <>
    <ItemGroup title="Gateway">
      <EndpointHeadersEditor
        testID="author-headers"
        layer="account"
        values={layer}
        inherited={PROVIDER_DEFAULTS}
        hints={{ 'x-collect-log': 'False keeps request logs off at the gateway.' }}
        copy={{
          title: 'Request headers',
          inherited: 'From the provider',
          set: 'Set for every machine',
          required: 'Required',
          changedCount: (count) => `${count} changed`,
          needs: (names) => `Needs ${names}`,
          reset: 'Reset headers',
          resetDescription: 'Use the provider’s values',
        }}
        onChange={setLayer}
      />
    </ItemGroup>
    <Text testID="author-headers-layer" tone="secondary"
      value={layer === null ? 'This layer inherits every value' : Object.entries(layer).map(([name, value]) => `${name}=${value}`).join(', ')} />
  </>;
}
