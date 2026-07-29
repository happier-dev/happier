import { resolveOpenAiCompatEndpointConsent } from './endpoint';

export type OpenAiCompatEndpointPatch = Readonly<{
  baseUrl: string | null;
  insecureLocalOriginConsent: string | null;
  insecureLocalConsentMachineId: string | null;
}>;

/**
 * Canonical settings interaction for endpoint changes. It keeps consent bound
 * to one normalized origin and refuses to create machine-relative HTTP consent
 * when no online selected execution machine can be named.
 */
export async function promptOpenAiCompatEndpointChange(params: Readonly<{
  currentBaseUrl: string | null;
  currentConsent: string | null;
  currentConsentMachineId: string | null;
  machineId: string | null;
  machineLabel: string | null;
  promptBaseUrl: () => Promise<string | null>;
  confirmInsecureOrigin: (input: Readonly<{ origin: string; machineLabel: string }>) => Promise<boolean>;
  showInvalidEndpoint: (reason: 'endpoint_invalid' | 'machine_unavailable') => void | Promise<void>;
}>): Promise<OpenAiCompatEndpointPatch | null> {
  const raw = await params.promptBaseUrl();
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      baseUrl: null,
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
    };
  }

  let endpoint;
  try {
    endpoint = resolveOpenAiCompatEndpointConsent(
      trimmed,
      params.currentConsent,
      params.currentConsentMachineId,
      params.machineId,
    );
  } catch {
    await params.showInvalidEndpoint('endpoint_invalid');
    return null;
  }

  if (!endpoint.requiresInsecureConsent) {
    return {
      baseUrl: endpoint.normalizedBaseUrl,
      insecureLocalOriginConsent: null,
      insecureLocalConsentMachineId: null,
    };
  }
  if (endpoint.insecureLocalOriginConsent === endpoint.origin) {
    return {
      baseUrl: endpoint.normalizedBaseUrl,
      insecureLocalOriginConsent: endpoint.origin,
      insecureLocalConsentMachineId: params.machineId,
    };
  }
  if (!params.machineId || !params.machineLabel) {
    await params.showInvalidEndpoint('machine_unavailable');
    return null;
  }
  if (!await params.confirmInsecureOrigin({ origin: endpoint.origin, machineLabel: params.machineLabel })) {
    return null;
  }
  return {
    baseUrl: endpoint.normalizedBaseUrl,
    insecureLocalOriginConsent: endpoint.origin,
    insecureLocalConsentMachineId: params.machineId,
  };
}
