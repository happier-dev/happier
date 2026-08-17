import { normalizeProviderEndpointUrlSyntax } from '@happier-dev/protocol';

export type SpeechEndpointConsentPatch = Readonly<{
  baseUrl: string;
  insecureLocalOriginConsent: string;
  insecureLocalConsentMachineId: string;
}>;

export async function promptSpeechEndpointChange(params: Readonly<{
  currentBaseUrl: string;
  currentConsent: string;
  currentConsentMachineId: string;
  machineId: string | null;
  machineLabel: string | null;
  promptBaseUrl(): Promise<string | null>;
  confirmInsecureOrigin(input: Readonly<{ origin: string; machineLabel: string }>): Promise<boolean>;
  showInvalidEndpoint(reason: 'endpoint_invalid' | 'machine_unavailable'): void | Promise<void>;
}>): Promise<SpeechEndpointConsentPatch | null> {
  const raw = await params.promptBaseUrl();
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return { baseUrl: '', insecureLocalOriginConsent: '', insecureLocalConsentMachineId: '' };
  let endpoint: ReturnType<typeof normalizeProviderEndpointUrlSyntax>;
  try {
    endpoint = normalizeProviderEndpointUrlSyntax(trimmed, { allowQuery: false });
  } catch {
    await params.showInvalidEndpoint('endpoint_invalid');
    return null;
  }
  if (endpoint.protocol !== 'http:') {
    return {
      baseUrl: endpoint.normalizedUrl,
      insecureLocalOriginConsent: '',
      insecureLocalConsentMachineId: '',
    };
  }
  if (
    params.currentConsent === endpoint.origin
    && params.machineId !== null
    && params.currentConsentMachineId === params.machineId
  ) {
    return {
      baseUrl: endpoint.normalizedUrl,
      insecureLocalOriginConsent: endpoint.origin,
      insecureLocalConsentMachineId: params.machineId,
    };
  }
  if (!params.machineId || !params.machineLabel) {
    await params.showInvalidEndpoint('machine_unavailable');
    return null;
  }
  if (!await params.confirmInsecureOrigin({ origin: endpoint.origin, machineLabel: params.machineLabel })) return null;
  return {
    baseUrl: endpoint.normalizedUrl,
    insecureLocalOriginConsent: endpoint.origin,
    insecureLocalConsentMachineId: params.machineId,
  };
}
