import { isDeploymentDomainAttachedV1, type DeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { readDeploymentDomainServingUrlV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { deploymentDomainAttention, type DomainAttention, type DomainItem } from './deploymentDomainAttention';

type LiveDomain = Pick<DomainItem, 'domain' | 'content' | 'health'>;

type LiveReceipt = Readonly<{
  deployment: Readonly<{ targetLinkId: string; state: string }>;
  content: Readonly<{
    platform?: unknown;
    sourceIntent?: Readonly<{
      kind: string;
      primaryService?: string;
      compose?: Readonly<{ primaryService?: string }>;
    }>;
  }>;
  facts: Pick<DeploymentReceiptFactsV1, 'urls'>;
}>;

/** The address a serving receipt is reached at, and what its Domain still needs from the person (null: nothing). */
export type DeploymentLiveAddress = Readonly<{
  url: string;
  attention: DomainAttention | null;
  /** The Domain behind an address, for its own recovery (Check again); a provider's observed URL has none. */
  domain: Readonly<{ id: string; revision: number }> | null;
}>;

/** A version that runs: verified healthy, or running without a health check (the receipt's own notice says so). */
function servesLive(receipt: LiveReceipt): boolean {
  return receipt.deployment.state === 'succeeded' || receipt.deployment.state === 'running_unverified';
}

/** Whether the receipt page reads current Domains for this receipt's address; the same rule the resolver applies. */
export function deploymentLiveAddressDemand(receipt: LiveReceipt | null, serving: boolean): boolean {
  return serving && receipt !== null && servesLive(receipt) && !receipt.facts.urls?.[0];
}

/**
 * The address a serving receipt is live at: a platform's observed URL, else the current Domain that routes its
 * runtime link (and primary service for native targets). Both pages read it here, once.
 */
export function resolveDeploymentLiveAddress(
  receipt: LiveReceipt,
  domains: readonly LiveDomain[],
  /** The receipt is its runtime link's active deployment; a historical receipt never borrows current Domains. */
  serving: boolean,
): DeploymentLiveAddress | null {
  if (!serving || !servesLive(receipt)) return null;
  const observed = receipt.facts.urls?.[0];
  if (observed) return { url: observed, attention: null, domain: null };
  const intent = receipt.content.sourceIntent;
  const primaryService =
    intent?.kind === 'repository'
      ? intent.compose?.primaryService
      : intent?.primaryService;
  if (!receipt.content.platform && !primaryService) return null;
  const domain = domains.find(
    (item) =>
      isDeploymentDomainAttachedV1(item.domain, { runtimeTargetLinkId: receipt.deployment.targetLinkId }) &&
      (item.domain.state === 'active' || item.domain.state === 'warning') &&
      (receipt.content.platform ? item.content.target.kind === 'provider'
        : item.content.target.kind !== 'provider' && item.content.target.service === primaryService),
  );
  const url = domain ? readDeploymentDomainServingUrlV1(domain.content) : null;
  if (!domain || !url) return null;
  // A Domain that needs a look is still the address, but it is not plainly live: the Domains row's own line travels with it.
  return { url, attention: deploymentDomainAttention(domain, domain.domain.state, true),
    domain: { id: domain.domain.id, revision: domain.domain.revision } };
}

/** The address as people say it: no scheme, no trailing slash. */
export function formatDeploymentLiveAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
