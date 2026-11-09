import {
  pickMostBlockingHappierCapabilityStatus,
  presentHappierCapabilityStatus,
  type HappierCapabilityFixKind,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusKind,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
  type HappierCapabilityStatusPresentation,
} from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import { formatAgentNameList } from '../identity/agentNameList';

/**
 * Happier's words for the shared capability status owner (`@happier-dev/plugin-ui` presentation): which status
 * speaks, its tone, fix and blocking order are decided there, for core pages and plugins alike.
 */
export type CapabilityStatusKind = HappierCapabilityStatusKind;
export type CapabilityFixKind = HappierCapabilityFixKind;
export type CapabilityStatus = HappierCapabilityStatus;
export type CapabilityStatusPresentation = HappierCapabilityStatusPresentation;
export type CapabilityStatusPlacement = HappierCapabilityStatusPlacement;

export const capabilityStatusLabels: HappierCapabilityStatusLabels = {
  status: (kind, machine) => {
    switch (kind) {
      case 'error':
        return t('capabilities.status.error', { machine });
      case 'cantrun':
        return t('capabilities.status.cantrun', { machine });
      case 'masked':
        return t('capabilities.status.masked', { machine });
      case 'signin':
        return t('capabilities.status.signin');
      case 'more_access':
        return t('capabilities.status.moreAccess');
      case 'key':
        return t('capabilities.status.key');
      case 'expired':
        return t('capabilities.status.expired');
      case 'revoked':
        return t('capabilities.status.revoked');
      case 'offline':
        return t('capabilities.status.offline');
      case 'signing':
        return t('capabilities.status.signing');
      case 'update':
        return t('capabilities.status.update');
      case 'removed':
        return t('capabilities.status.removed');
      case 'modified':
        return t('capabilities.status.modified');
      case 'pinned':
        return t('capabilities.status.pinned');
      case 'off':
        return t('capabilities.status.off');
      case 'unused':
        return t('capabilities.status.unused');
      case 'connected':
        return t('capabilities.status.connected');
    }
  },
  fix: (kind) => {
    switch (kind) {
      case 'sign_in':
        return t('capabilities.status.fix.signIn');
      case 'reconnect':
        return t('capabilities.status.fix.reconnect');
      case 'add_key':
        return t('capabilities.status.fix.addKey');
      case 'how_to_fix':
        return t('capabilities.status.fix.howToFix');
      case 'try_again':
        return t('capabilities.status.fix.tryAgain');
      case 'review_update':
        return t('capabilities.status.fix.reviewUpdate');
      case 'compare':
        return t('capabilities.status.fix.compare');
      case 'turn_on':
        return t('capabilities.status.fix.turnOn');
      case 'grant_access':
        return t('capabilities.status.fix.grantAccess');
    }
  },
};

export function presentCapabilityStatus(
  status: CapabilityStatus,
  placement: CapabilityStatusPlacement = 'row',
): CapabilityStatusPresentation {
  return presentHappierCapabilityStatus(
    status,
    placement,
    capabilityStatusLabels,
  );
}

export const pickMostBlockingCapabilityStatus =
  pickMostBlockingHappierCapabilityStatus;

/** Why "Not used recently" can only be known for some Agents (D29), naming the Agents that declare reported use. */
export function explainUnusedCapabilityStatus(
  reportingAgentNames: readonly string[],
): string {
  return t('capabilities.status.unusedExplanation', {
    agents: formatAgentNameList(reportingAgentNames),
  });
}
