import { connect } from 'node:net';
import { encodeProviderBrokerAuthorityV1, type SignedProviderBrokerModelRouteGrantV1 } from '@happier-dev/protocol';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import type { ManagedServiceResponse } from '@happier-dev/plugin-sdk/managed-services';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderContributionRegistryView } from '@/providers/registry';

/** Consume the SDK's reader boundary without assuming a native Web stream. */
export async function readProviderBrokerResponseBody(body: ManagedServiceResponse['body']): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Declared gateway fixture: the real registry/projection owners are exercised. */
export function createBrokerProviderRegistry(): ProviderContributionRegistryView {
  const identity = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
  const endpointTemplates = [
    { id: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
    { id: 'cliproxyapi-openai-chat', protocol: 'openai-chat' },
    { id: 'cliproxyapi-anthropic', protocol: 'anthropic' },
  ];
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: identity.localId, name: 'Managed gateway', kind: 'aggregator',
    endpointTemplates: endpointTemplates.map((endpoint) => ({
      ...endpoint, baseUrl: 'http://127.0.0.1:8317/v1',
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'supported' },
    })),
    catalog: { source: 'manual', manualModelPolicy: 'allowed' },
    managedRuntime: {
      kind: 'managed', sourceEnvelopeTransport: 'cpx-v1', endpointTemplateIds: endpointTemplates.map((endpoint) => endpoint.id),
      connectedAccounts: [
        { purpose: 'openai-upstream', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          title: { key: 'managedPurpose.openai.title', fallback: 'Use OpenAI upstream account' }, required: false,
          materializationKinds: ['httpHeaders'], endpointTemplateIds: endpointTemplates.map((endpoint) => endpoint.id) },
        { purpose: 'anthropic-upstream', service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          materializationKinds: ['httpHeaders'], endpointTemplateIds: endpointTemplates.map((endpoint) => endpoint.id) },
      ],
    },
  });
  const provider: ResolvedProviderContribution = {
    identity, pluginId: identity.pluginId, definition, provenance: 'external', source: { kind: 'path' },
  };
  return { providersByContributionKey: new Map([[`${identity.pluginId}/${identity.localId}`, provider]]) };
}

export async function requestThroughApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  /** An Agent-supplied bearer. The target must never treat it as authority. */
  authority?: SignedProviderBrokerModelRouteGrantV1;
  /** Overrides the default small JSON body; used to probe the ingress limit. */
  body?: string;
  path?: string;
  onData?: (chunk: Buffer) => void;
}>): Promise<string> {
  const body = input.body ?? JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] });
  const request = [
    `POST ${input.path ?? '/v1/chat/completions'} HTTP/1.1`,
    'Host: 127.0.0.1',
    ...(input.authority ? [`Authorization: Bearer ${encodeProviderBrokerAuthorityV1(input.authority)}`] : []),
    'X-Provider-Request: retained',
    'X-Remove: connection-scoped',
    'Connection: close, X-Remove',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');

  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: input.port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.write(input.localCapability, 'ascii');
      // Keep the response half open. The client requested `Connection: close`,
      // so the application owns closing only after the streamed result lands.
      socket.write(request, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      input.onData?.(chunk);
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
