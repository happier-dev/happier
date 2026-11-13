import { projectDeploymentDomainDnsReadinessV1 } from '@happier-dev/deployments';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { t } from '@/text';
import type { useDeploymentEnvironmentDomains } from './useDeploymentReads';

export type DomainItem = ReturnType<
  typeof useDeploymentEnvironmentDomains
>['result']['items'][number];
/** A Domain credential binding's role (basic auth password, your certificate's chain and key). */
export type DomainCredentialRole =
  | 'basicAuth'
  | 'certificateChain'
  | 'privateKey';
export type DomainAttention = Readonly<{
  variant: StatusPillVariant;
  label: string;
}>;
type DomainLifecycle =
  | DomainItem['domain']['state']
  | 'outcome_unknown'
  | 'cancelled';

/**
 * What a Domain needs from the person, as one line: its lifecycle first, then a credential it lacks, then whether
 * its name reaches this Machine, then its health. A settled address that is healthy says nothing. The Domains row
 * and the live address read it here, once.
 */
export function deploymentDomainAttention(
  item: Pick<DomainItem, 'health'> & Readonly<{ domain: Pick<DomainItem['domain'], 'dnsHealth'> }>,
  lifecycle: DomainLifecycle,
  missing: readonly DomainCredentialRole[] = [],
): DomainAttention | null {
  if (lifecycle === 'outcome_unknown')
    return {
      variant: 'attention',
      label: t('projects.deployments.stateUnknown'),
    };
  if (lifecycle === 'cancelled')
    return {
      variant: 'attention',
      label: t('projects.deployments.stateCancelled'),
    };
  const state = domainState(lifecycle);
  // A name that does not reach this Machine explains the failed health check after it, so it leads.
  const health = dnsState(item.domain.dnsHealth) ?? healthState(item.health);
  // "Needs a look" alone hides why: a warning carries the cause beside it (DEPLOY-ACCEPT-143 A4).
  if (lifecycle === 'warning' && state && health) return { variant: health.variant, label: `${state.label} · ${health.label}` };
  return state ?? credentialState(missing) ?? health;
}

/** The native DNS check's verdict (SOS-GAP-DOMAINS): only a missing record or a name that reaches elsewhere needs the person. */
function dnsState(dnsHealth: DomainItem['domain']['dnsHealth']): DomainAttention | null {
  const { state } = projectDeploymentDomainDnsReadinessV1(dnsHealth);
  if (state === 'missing') return { variant: 'attention', label: t('projects.deployments.domainDnsRowMissing') };
  if (state === 'not_this_machine') return { variant: 'attention', label: t('projects.deployments.domainDnsRowElsewhere') };
  return null;
}

/** A settled address whose own content asks for a credential no binding supplies yet. */
function credentialState(
  missing: readonly DomainCredentialRole[],
): DomainAttention | null {
  if (missing.length === 0) return null;
  return {
    variant: 'attention',
    label: missing.includes('basicAuth')
      ? t('projects.deployments.editors.needsPassword')
      : t('projects.deployments.editors.needsCertificate'),
  };
}

/**
 * The Domain health owner's one `needsYou` fact (T2-DOMAIN-PREVIEW `projectDeploymentDomainHealthFactsV1`): a
 * certificate that expires soon or is no longer valid, or an address that does not answer, with its one cause.
 * Healthy, unchecked and unavailable observations stay quiet.
 */
function healthState(health: DomainItem['health']): DomainAttention | null {
  const needs = health?.needsYou;
  if (!needs) return null;
  if (needs.cause === 'certificate') {
    if (needs.reason === 'expiresSoon')
      return {
        variant: 'attention',
        label: health?.certificate.expiresAt
          ? t('projects.deployments.editors.certExpiresSoon', {
              date: new Date(health.certificate.expiresAt).toLocaleDateString(),
            })
          : t('projects.deployments.editors.certInvalid'),
      };
    return {
      variant: 'danger',
      label:
        needs.reason === 'expired'
          ? t('projects.deployments.editors.certExpired')
          : t('projects.deployments.editors.certInvalid'),
    };
  }
  const where =
    needs.vantage === 'outside'
      ? t('projects.deployments.editors.unreachableOutside')
      : t('projects.deployments.editors.unreachableHere');
  const why =
    needs.cause === 'dns'
      ? t('projects.deployments.editors.diagnosisDns')
      : needs.cause === 'network'
        ? t('projects.deployments.editors.diagnosisNetwork')
        : t('projects.deployments.editors.diagnosisHttp');
  return { variant: 'danger', label: `${where} · ${why}` };
}

/** Healthy (`active`) is quiet; the rest speak, in the colour of what they need. */
function domainState(
  state: DomainItem['domain']['state'],
): DomainAttention | null {
  switch (state) {
    case 'active':
      return null;
    case 'pending':
    case 'applying':
      return {
        variant: 'neutral',
        label: t('projects.deployments.domainStateSettingUp'),
      };
    case 'warning':
      return {
        variant: 'attention',
        label: t('projects.deployments.domainStateWarning'),
      };
    case 'failed':
      return {
        variant: 'danger',
        label: t('projects.deployments.domainStateFailed'),
      };
    case 'removing':
      return {
        variant: 'neutral',
        label: t('projects.deployments.domainStateRemoving'),
      };
  }
}
