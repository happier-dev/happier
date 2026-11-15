import { describe, expect, it } from 'vitest';
import {
  createDeploymentReceiptDetailV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import {
  deploymentLiveAddressDemand,
  resolveDeploymentLiveAddress,
} from './deploymentLiveAddressFacts';

const domain = (
  targetLinkId: string,
  state: 'active' | 'warning',
  needsYou: unknown = null,
) =>
  ({
    domain: {
      v: 1 as const,
      id: 'shop-domain',
      environmentId: 'environment',
      targetLinkId,
      revision: 1,
      state,
      contentArtifactId: 'domain-content',
      contentHeaderVersion: 1,
      contentBodyVersion: 1,
      createdByAccountId: 'account-owner',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    title: 'shop.example.test',
    content: {
      hostname: 'shop.example.test',
      target: { service: 'app', containerPort: 3000 },
    },
    health: needsYou
      ? {
          availability: 'observed',
          unavailableReason: null,
          observedAt: 1,
          vantage: 'outside',
          certificate: { state: 'not_checked', expiresAt: null },
          needsYou,
        }
      : undefined,
  }) as unknown as Parameters<typeof resolveDeploymentLiveAddress>[1][number];

const serving = (state: 'succeeded' | 'running_unverified' | 'failed') => {
  const receipt = createDeploymentReceiptDetailV1({
    deployment: createDeploymentReceiptHeaderV1({ state }),
  });
  return { ...receipt, facts: projectDeploymentReceiptFactsV1(receipt) };
};

describe('the live address (FIRST-DEPLOY-URL-1112, DEPLOY-ACCEPT-143 A1/A2)', () => {
  it('uses the platform target Domain when workers.dev supplies no address', () => {
    const base = serving('succeeded');
    const receipt = { ...base, content: { platform: {} }, facts: { ...base.facts, urls: [] } };
    const providerDomain = { ...domain(receipt.deployment.targetLinkId, 'active'),
      content: { hostname: 'shop.example.test', target: { kind: 'provider' as const } } };
    expect(deploymentLiveAddressDemand(receipt, true)).toBe(true);
    expect(resolveDeploymentLiveAddress(receipt, [providerDomain], true)?.url).toBe('https://shop.example.test/');
    expect(resolveDeploymentLiveAddress(receipt, [domain(receipt.deployment.targetLinkId, 'active')], true)).toBeNull();
    const addressed = { ...receipt, facts: { ...receipt.facts, urls: ['https://app.actual.workers.dev'] } };
    expect(deploymentLiveAddressDemand(addressed, true)).toBe(false);
    expect(resolveDeploymentLiveAddress(addressed, [providerDomain], true)?.url).toBe('https://app.actual.workers.dev');
  });

  it.each(['succeeded', 'running_unverified'] as const)(
    'reads one serving %s receipt as live for every surface',
    (state) => {
      const receipt = serving(state);
      // The receipt page reads Domains only when this says so; the Overview resolves from the same answer.
      expect(deploymentLiveAddressDemand(receipt, true)).toBe(true);
      expect(
        resolveDeploymentLiveAddress(
          receipt,
          [domain(receipt.deployment.targetLinkId, 'active')],
          true,
        )?.url,
      ).toBe('https://shop.example.test/');
    },
  );

  it('is never live for a receipt that does not serve or did not succeed', () => {
    const failed = serving('failed');
    expect(deploymentLiveAddressDemand(failed, true)).toBe(false);
    expect(
      resolveDeploymentLiveAddress(
        failed,
        [domain(failed.deployment.targetLinkId, 'active')],
        true,
      ),
    ).toBeNull();
    const historical = serving('succeeded');
    expect(deploymentLiveAddressDemand(historical, false)).toBe(false);
    expect(
      resolveDeploymentLiveAddress(
        historical,
        [domain(historical.deployment.targetLinkId, 'active')],
        false,
      ),
    ).toBeNull();
  });

  it("carries a warning Domain's state and cause instead of reading it as plainly live", () => {
    const receipt = serving('succeeded');
    const healthy = resolveDeploymentLiveAddress(
      receipt,
      [domain(receipt.deployment.targetLinkId, 'active')],
      true,
    );
    expect(healthy?.attention).toBeNull();
    const warning = resolveDeploymentLiveAddress(
      receipt,
      [
        domain(receipt.deployment.targetLinkId, 'warning', {
          cause: 'dns',
          reason: 'dns_missing',
          vantage: 'outside',
        }),
      ],
      true,
    );
    expect(warning?.url).toBe('https://shop.example.test/');
    expect(warning?.attention?.variant).not.toBeUndefined();
    // The lifecycle word and the health cause speak together.
    expect(warning?.attention?.label).toContain('Needs a look');
    expect(warning?.attention?.label).toContain('DNS');
  });
});
